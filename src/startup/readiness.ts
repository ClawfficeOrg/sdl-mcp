export type StartupReadinessState = "initializing" | "ready" | "degraded";

export type StartupReadinessReason =
  | "database_unavailable"
  | "storage_preflight_failed"
  | "watcher_start_failed";

export interface StartupReadinessSnapshot {
  state: StartupReadinessState;
  reason: StartupReadinessReason | null;
  watchers: {
    expected: number;
    ready: number;
  };
}

export interface StartupReadiness {
  getSnapshot(): StartupReadinessSnapshot;
  isWriteReady(): boolean;
  markReady(expectedWatchers: number, readyWatchers: number): void;
  markDegraded(
    reason: StartupReadinessReason,
    expectedWatchers: number,
    readyWatchers: number,
  ): void;
}

export class StorageNotWriteReadyError extends Error {
  readonly code = "STORAGE_NOT_WRITE_READY";

  constructor(snapshot: StartupReadinessSnapshot) {
    super(
      `Storage is not write-ready (${snapshot.state}); only read-only diagnostics are available`,
    );
    this.name = "StorageNotWriteReadyError";
  }
}

export function readyStartupReadinessSnapshot(): StartupReadinessSnapshot {
  return {
    state: "ready",
    reason: null,
    watchers: { expected: 0, ready: 0 },
  };
}

export function createStartupReadiness(): StartupReadiness {
  let snapshot: StartupReadinessSnapshot = {
    state: "initializing",
    reason: null,
    watchers: { expected: 0, ready: 0 },
  };

  const replace = (
    state: StartupReadinessState,
    reason: StartupReadinessReason | null,
    expected: number,
    ready: number,
  ): void => {
    snapshot = { state, reason, watchers: { expected, ready } };
  };

  return {
    // Return a copy so callers cannot mutate the process-wide latch.
    getSnapshot: () => ({
      ...snapshot,
      watchers: { ...snapshot.watchers },
    }),
    isWriteReady: () => snapshot.state === "ready",
    markReady: (expected, ready) => {
      if (snapshot.state !== "degraded") replace("ready", null, expected, ready);
    },
    markDegraded: (reason, expected, ready) => {
      replace("degraded", reason, expected, ready);
    },
  };
}
