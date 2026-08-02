import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStartupReadiness } from "../../dist/startup/readiness.js";

describe("startup readiness", () => {
  it("starts initializing and becomes ready with watcher counts", () => {
    const readiness = createStartupReadiness();

    assert.deepEqual(readiness.getSnapshot(), {
      state: "initializing",
      reason: null,
      watchers: { expected: 0, ready: 0 },
    });
    assert.equal(readiness.isWriteReady(), false);

    readiness.markReady(2, 2);

    assert.deepEqual(readiness.getSnapshot(), {
      state: "ready",
      reason: null,
      watchers: { expected: 2, ready: 2 },
    });
    assert.equal(readiness.isWriteReady(), true);
  });

  it("latches degraded state and cannot later become ready", () => {
    const readiness = createStartupReadiness();

    readiness.markDegraded("watcher_start_failed", 2, 1);
    readiness.markReady(2, 2);

    assert.deepEqual(readiness.getSnapshot(), {
      state: "degraded",
      reason: "watcher_start_failed",
      watchers: { expected: 2, ready: 1 },
    });
    assert.equal(readiness.isWriteReady(), false);
  });
});
