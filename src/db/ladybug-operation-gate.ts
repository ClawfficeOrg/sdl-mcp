import { AsyncLocalStorage } from "node:async_hooks";

import { DatabaseError } from "../domain/errors.js";

type OperationMode = "shared" | "exclusive";

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
  resolve: (admission: Admission) => void;
  reject: (error: DatabaseError) => void;
  timeout?: NodeJS.Timeout;
}

const operationContext = new AsyncLocalStorage<Lease>();
const waiters: Waiter[] = [];

let activeShared = 0;
let activeExclusive = false;

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

function admit(waiter: Waiter): void {
  if (waiter.timeout !== undefined) {
    clearTimeout(waiter.timeout);
  }
  waiter.resolve(markAdmitted(waiter.mode));
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
): Promise<Admission> {
  if (canAdmit(mode)) {
    return Promise.resolve(markAdmitted(mode));
  }

  return new Promise<Admission>((resolve, reject) => {
    const waiter: Waiter = { mode, resolve, reject };
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

  const admission = await acquire(mode, timeoutMs);
  return runRoot(admission, task);
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
