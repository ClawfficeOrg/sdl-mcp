import { AsyncLocalStorage } from "node:async_hooks";

import { DatabaseError } from "../domain/errors.js";

type OperationMode = "shared" | "exclusive";
type OperationKind = "ordinary" | "initialization" | "close";

export const MAX_LADYBUG_OPERATION_WAITERS = 256;

interface Admission {
  mode: OperationMode;
  activeLeases: number;
  drained: Promise<void>;
  resolveDrained: () => void;
}

interface Lease {
  admission: Admission;
  active: boolean;
}

interface Waiter {
  mode: OperationMode;
  kind: OperationKind;
  resolve: (admission: Admission) => void;
  reject: (error: DatabaseError) => void;
  timeout?: NodeJS.Timeout;
}

const operationContext = new AsyncLocalStorage<Lease>();
const waiters: Waiter[] = [];

let activeShared = 0;
let activeExclusive = false;
let lifecycleState: "open" | "closing" | "closed" = "open";

/**
 * Fail closed when native ownership survives an operation. Only a root close
 * may run after this point, and it must clear every retained handle.
 */
export function fenceLadybugOperationsForNativeCleanup(): void {
  lifecycleState = "closing";
  rejectQueuedOperationsForClose();
}

function createAdmission(mode: OperationMode): Admission {
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return { mode, activeLeases: 0, drained, resolveDrained };
}

function hasQueuedExclusive(): boolean {
  return waiters.some((waiter) => waiter.mode === "exclusive");
}

function canAdmit(mode: OperationMode): boolean {
  if (mode === "shared") {
    return !activeExclusive && !hasQueuedExclusive();
  }
  return !activeExclusive && activeShared === 0 && waiters.length === 0;
}

function markAdmitted(mode: OperationMode): Admission {
  if (mode === "exclusive") {
    activeExclusive = true;
  } else {
    activeShared++;
  }
  return createAdmission(mode);
}

function clearWaiterTimer(waiter: Waiter): void {
  if (waiter.timeout !== undefined) {
    clearTimeout(waiter.timeout);
    waiter.timeout = undefined;
  }
}

function admit(waiter: Waiter): void {
  clearWaiterTimer(waiter);
  waiter.resolve(markAdmitted(waiter.mode));
}

function rejectQueuedOperationsForClose(): void {
  const error = new DatabaseError(
    "LadybugDB is closing; queued operation cancelled",
  );
  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index];
    if (waiter.kind === "close") continue;
    waiters.splice(index, 1);
    clearWaiterTimer(waiter);
    waiter.reject(error);
  }
}

function drainWaiters(): void {
  if (activeExclusive) return;

  const exclusiveIndex = waiters.findIndex(
    (waiter) => waiter.mode === "exclusive",
  );
  if (exclusiveIndex !== -1) {
    if (activeShared === 0) {
      const [waiter] = waiters.splice(exclusiveIndex, 1);
      admit(waiter);
    }
    return;
  }

  while (waiters.length > 0) {
    const waiter = waiters.shift();
    if (waiter !== undefined) admit(waiter);
  }
}

function acquire(
  mode: OperationMode,
  timeoutMs?: number,
  kind: OperationKind = "ordinary",
): Promise<Admission> {
  if (kind !== "close") {
    if (lifecycleState === "closing") {
      return Promise.reject(new DatabaseError("LadybugDB is closing"));
    }
    if (lifecycleState === "closed" && kind === "ordinary") {
      return Promise.reject(new DatabaseError("LadybugDB is closed"));
    }
  }

  if (canAdmit(mode)) {
    return Promise.resolve(markAdmitted(mode));
  }
  if (waiters.length >= MAX_LADYBUG_OPERATION_WAITERS) {
    return Promise.reject(
      new DatabaseError(
        `LadybugDB operation waiter limit reached (${MAX_LADYBUG_OPERATION_WAITERS})`,
      ),
    );
  }

  return new Promise<Admission>((resolve, reject) => {
    const waiter: Waiter = { mode, kind, resolve, reject };
    waiters.push(waiter);

    if (timeoutMs !== undefined) {
      waiter.timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index === -1) return;

        waiters.splice(index, 1);
        reject(
          new DatabaseError(
            `Timed out after ${timeoutMs}ms waiting for ${mode} Ladybug operation admission`,
          ),
        );
        drainWaiters();
      }, timeoutMs);
      waiter.timeout.unref();
    }
  });
}

function releaseAdmission(admission: Admission): void {
  if (admission.mode === "exclusive") {
    activeExclusive = false;
  } else {
    activeShared--;
  }
  drainWaiters();
}

async function runLease<T>(
  admission: Admission,
  task: () => Promise<T>,
): Promise<T> {
  const lease: Lease = { admission, active: true };
  admission.activeLeases++;

  try {
    return await operationContext.run(lease, task);
  } finally {
    // Each invocation owns a lease, so detached callbacks cannot reuse it after
    // that invocation settles even though AsyncLocalStorage retains the value.
    lease.active = false;
    admission.activeLeases--;
    if (admission.activeLeases === 0) {
      admission.resolveDrained();
    }
  }
}

async function runRoot<T>(
  admission: Admission,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await runLease(admission, task);
  } finally {
    // Keep root admission until every nested operation started under an active
    // lease has settled.
    await admission.drained;
    releaseAdmission(admission);
  }
}

async function withLadybugOperation<T>(
  mode: OperationMode,
  task: () => Promise<T>,
  timeoutMs?: number,
  kind: OperationKind = "ordinary",
): Promise<T> {
  const currentLease = operationContext.getStore();
  if (currentLease?.active) {
    if (
      mode === "exclusive" &&
      currentLease.admission.mode === "shared"
    ) {
      throw new DatabaseError(
        "Cannot upgrade a shared Ladybug operation to exclusive",
      );
    }
    return runLease(currentLease.admission, task);
  }

  const admission = await acquire(mode, timeoutMs, kind);
  return runRoot(admission, task);
}

/**
 * Capture the active admission for work that another queue invokes later.
 * The nested lease keeps plain callbacks covered and restores the gate context
 * for DB helpers called from a dequeued callback.
 */
export function bindCurrentLadybugOperation<T>(
  task: () => Promise<T>,
): () => Promise<T> {
  const capturedLease = operationContext.getStore();
  if (!capturedLease?.active) return task;

  return () => {
    if (!capturedLease.active) {
      throw new DatabaseError(
        "Captured Ladybug operation expired before queued work started",
      );
    }
    return runLease(capturedLease.admission, task);
  };
}

export function getCurrentLadybugOperationMode(): OperationMode | undefined {
  const currentLease = operationContext.getStore();
  return currentLease?.active ? currentLease.admission.mode : undefined;
}

export function hasCurrentExclusiveLadybugOperation(): boolean {
  return getCurrentLadybugOperationMode() === "exclusive";
}

/**
 * Fence new root work immediately, then close after active nested leases drain.
 * A retained native handle keeps the gate in the closing state for close retry.
 */
export function withLadybugCloseOperation<T>(
  task: () => Promise<T>,
  isFullyClosed: () => boolean,
): Promise<T> {
  if (operationContext.getStore()?.active) {
    return Promise.reject(
      new DatabaseError("LadybugDB close must be started as a root operation"),
    );
  }
  fenceLadybugOperationsForNativeCleanup();
  return withLadybugOperation("exclusive", task, undefined, "close").finally(
    () => {
      if (isFullyClosed()) lifecycleState = "closed";
    },
  );
}

/**
 * Explicit initialization is the only root operation admitted after close.
 * Nested DB helpers reuse this exclusive admission until initialization ends.
 */
export function withLadybugInitialization<T>(
  task: () => Promise<T>,
): Promise<T> {
  return withLadybugOperation(
    "exclusive",
    task,
    undefined,
    "initialization",
  ).then((result) => {
    if (lifecycleState !== "closing") lifecycleState = "open";
    return result;
  });
}

export function withSharedLadybugOperation<T>(
  task: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return withLadybugOperation("shared", task, timeoutMs);
}

export function withExclusiveLadybugOperation<T>(
  task: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return withLadybugOperation("exclusive", task, timeoutMs);
}

/**
 * Queue a new exclusive root even when the caller currently owns a shared
 * admission. The acquisition is created while explicitly outside the current
 * AsyncLocalStorage store, so writer preference starts synchronously.
 *
 * Callers inside shared work must not await this promise until that shared root
 * has fully unwound, or they would wait on their own admission.
 */
export function queueExclusiveLadybugOperation<T>(
  task: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return operationContext.exit(() => {
    const admission = acquire("exclusive", timeoutMs);
    return admission.then((exclusive) => runRoot(exclusive, task));
  });
}
