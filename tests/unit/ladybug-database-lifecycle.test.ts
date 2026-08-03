import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkpointAndCloseLadybugDatabase,
  createManagedLadybugDatabase,
  withShadowLadybugDatabase,
} from "../../dist/db/ladybug-database-lifecycle.js";
import { withSharedLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("managed Ladybug database lifecycle", () => {
  it("constructs databases with manual checkpoints and strict WAL replay", () => {
    const calls: unknown[][] = [];
    class FakeDatabase {
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    }

    createManagedLadybugDatabase(
      FakeDatabase as unknown as typeof import("kuzu").Database,
      "shadow.lbug",
      {
        bufferManagerSize: 123,
        checkpointThresholdBytes: 456,
      },
    );

    assert.deepEqual(calls, [
      ["shadow.lbug", 123, true, false, 0, false, 456, true],
    ]);
  });

  it("keeps checkpoint and both closes inside one exclusive admission", async () => {
    const closeEntered = deferred();
    const releaseClose = deferred();
    const events: string[] = [];
    let sharedEntered = false;
    const result = {
      getAll: async () => [],
      close: () => {},
    };
    const conn = {
      query: async (statement: string) => {
        events.push(statement.toLowerCase());
        return result;
      },
      close: async () => {
        events.push("conn-close");
        closeEntered.resolve();
        await releaseClose.promise;
      },
    } as unknown as import("kuzu").Connection;
    const db = {
      close: async () => {
        events.push("db-close");
      },
    } as unknown as import("kuzu").Database;

    const lifecycle = checkpointAndCloseLadybugDatabase(conn, db);
    await closeEntered.promise;
    const shared = withSharedLadybugOperation(async () => {
      sharedEntered = true;
      events.push("shared");
    });
    await nextTurn();
    assert.equal(sharedEntered, false);

    releaseClose.resolve();
    await Promise.all([lifecycle, shared]);
    assert.deepEqual(events, [
      "checkpoint",
      "conn-close",
      "db-close",
      "shared",
    ]);
  });

  it("preserves checkpoint and close failures together", async () => {
    const conn = {
      query: async () => {
        throw new Error("checkpoint failed");
      },
      close: async () => {
        throw new Error("connection close failed");
      },
    } as unknown as import("kuzu").Connection;
    const db = {
      close: async () => {
        throw new Error("database close failed");
      },
    } as unknown as import("kuzu").Database;

    await assert.rejects(
      checkpointAndCloseLadybugDatabase(conn, db),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map((entry) =>
            entry instanceof Error ? entry.message : String(entry),
          ),
          [
            "checkpoint failed",
            "connection close failed",
            "database close failed",
          ],
        );
        return true;
      },
    );
  });

  it("closes the database when shadow connection construction fails", async () => {
    const events: string[] = [];

    class FakeDatabase {
      constructor() {
        events.push("db-construct");
      }

      async close(): Promise<void> {
        events.push("db-close");
      }
    }

    class FailingConnection {
      constructor(_db: unknown) {
        events.push("conn-construct");
        throw new Error("connection construction failed");
      }
    }

    await assert.rejects(
      withShadowLadybugDatabase(
        FakeDatabase as unknown as typeof import("kuzu").Database,
        FailingConnection as unknown as typeof import("kuzu").Connection,
        "shadow.lbug",
        async () => undefined,
      ),
      /connection construction failed/,
    );
    assert.deepEqual(events, ["db-construct", "conn-construct", "db-close"]);
  });

  it("preserves shadow body and cleanup failures together", async () => {
    class FailingDatabase {
      async close(): Promise<void> {
        throw new Error("database close failed");
      }
    }

    class FailingConnection {
      async query(): Promise<never> {
        throw new Error("checkpoint failed");
      }

      async close(): Promise<void> {
        throw new Error("connection close failed");
      }
    }

    await assert.rejects(
      withShadowLadybugDatabase(
        FailingDatabase as unknown as typeof import("kuzu").Database,
        FailingConnection as unknown as typeof import("kuzu").Connection,
        "shadow.lbug",
        async () => {
          throw new Error("body failed");
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(
          error.errors[0] instanceof Error
            ? error.errors[0].message
            : String(error.errors[0]),
          "body failed",
        );
        const cleanupError = error.errors[1];
        assert.ok(cleanupError instanceof AggregateError);
        assert.deepEqual(
          cleanupError.errors.map((entry) =>
            entry instanceof Error ? entry.message : String(entry),
          ),
          [
            "checkpoint failed",
            "connection close failed",
            "database close failed",
          ],
        );
        return true;
      },
    );
  });
});
