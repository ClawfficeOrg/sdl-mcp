import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkpointAndCloseLadybugDatabase,
  createManagedLadybugDatabase,
  hasPendingShadowLadybugDatabaseCleanup,
  retryPendingShadowLadybugDatabaseCleanup,
  withShadowLadybugDatabase,
} from "../../dist/db/ladybug-database-lifecycle.js";
import {
  withLadybugCloseOperation,
  withLadybugInitialization,
  withSharedLadybugOperation,
} from "../../dist/db/ladybug-operation-gate.js";

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
    let failClose = true;
    const conn = {
      query: async () => {
        throw new Error("checkpoint failed");
      },
      close: async () => {
        if (failClose) throw new Error("connection close failed");
      },
    } as unknown as import("kuzu").Connection;
    const db = {
      close: async () => {
        if (failClose) throw new Error("database close failed");
      },
    } as unknown as import("kuzu").Database;

    try {
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
    } finally {
      failClose = false;
      if (hasPendingShadowLadybugDatabaseCleanup()) {
        await withLadybugCloseOperation(
          retryPendingShadowLadybugDatabaseCleanup,
          () => !hasPendingShadowLadybugDatabaseCleanup(),
        );
      }
      await withLadybugInitialization(async () => {});
    }
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
    let failClose = true;

    class FailingDatabase {
      async close(): Promise<void> {
        if (failClose) throw new Error("database close failed");
      }
    }

    class FailingConnection {
      async query(): Promise<never> {
        throw new Error("checkpoint failed");
      }

      async close(): Promise<void> {
        if (failClose) throw new Error("connection close failed");
      }
    }

    try {
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
    } finally {
      failClose = false;
      if (hasPendingShadowLadybugDatabaseCleanup()) {
        await withLadybugCloseOperation(
          retryPendingShadowLadybugDatabaseCleanup,
          () => !hasPendingShadowLadybugDatabaseCleanup(),
        );
      }
      await withLadybugInitialization(async () => {});
    }
  });

  it("keeps the complete shadow lifetime ahead of global close", async () => {
    const bodyEntered = deferred();
    const releaseBody = deferred();
    const events: string[] = [];
    let closeCompleted = false;
    let shadow: Promise<void> | undefined;
    let close: Promise<void> | undefined;

    class FakeDatabase {
      constructor() {
        events.push("db-construct");
      }

      async close(): Promise<void> {
        events.push("db-close");
      }
    }

    class FakeConnection {
      constructor(_db: unknown) {
        events.push("conn-construct");
      }

      async query(statement: string): Promise<{
        getAll: () => Promise<never[]>;
        close: () => void;
      }> {
        events.push(statement.toLowerCase());
        return { getAll: async () => [], close: () => {} };
      }

      async close(): Promise<void> {
        events.push("conn-close");
      }
    }

    try {
      shadow = withShadowLadybugDatabase(
        FakeDatabase as unknown as typeof import("kuzu").Database,
        FakeConnection as unknown as typeof import("kuzu").Connection,
        "shadow.lbug",
        async () => {
          events.push("body-enter");
          bodyEntered.resolve();
          await releaseBody.promise;
        },
      );
      await bodyEntered.promise;

      close = withLadybugCloseOperation(
        async () => {
          events.push("global-close");
        },
        () => true,
      ).then(() => {
        closeCompleted = true;
      });
      await nextTurn();

      assert.equal(closeCompleted, false);
      assert.deepEqual(events, [
        "db-construct",
        "conn-construct",
        "body-enter",
      ]);

      releaseBody.resolve();
      await Promise.all([shadow, close]);
      assert.deepEqual(events, [
        "db-construct",
        "conn-construct",
        "body-enter",
        "checkpoint",
        "conn-close",
        "db-close",
        "global-close",
      ]);
    } finally {
      releaseBody.resolve();
      await Promise.allSettled([shadow, close].filter((value) => value !== undefined));
      await withLadybugInitialization(async () => {});
    }
  });

  it("retains failed shadow closes and fences ordinary operations until retry", async () => {
    const lifecycle = (await import(
      "../../dist/db/ladybug-database-lifecycle.js"
    )) as typeof import("../../dist/db/ladybug-database-lifecycle.js") & {
      hasPendingShadowLadybugDatabaseCleanup(): boolean;
      retryPendingShadowLadybugDatabaseCleanup(): Promise<void>;
    };
    let failClose = true;
    let connectionCloseCalls = 0;
    let databaseCloseCalls = 0;

    class RetryDatabase {
      async close(): Promise<void> {
        databaseCloseCalls++;
        if (failClose) throw new Error("shadow-database-close-failure");
      }
    }

    class RetryConnection {
      async query(): Promise<{
        getAll: () => Promise<never[]>;
        close: () => void;
      }> {
        return { getAll: async () => [], close: () => {} };
      }

      async close(): Promise<void> {
        connectionCloseCalls++;
        if (failClose) throw new Error("shadow-connection-close-failure");
      }
    }

    try {
      await assert.rejects(
        withShadowLadybugDatabase(
          RetryDatabase as unknown as typeof import("kuzu").Database,
          RetryConnection as unknown as typeof import("kuzu").Connection,
          "shadow.lbug",
          async () => undefined,
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(
            error.errors.map((entry) =>
              entry instanceof Error ? entry.message : String(entry),
            ),
            [
              "shadow-connection-close-failure",
              "shadow-database-close-failure",
            ],
          );
          return true;
        },
      );
      assert.equal(
        typeof lifecycle.hasPendingShadowLadybugDatabaseCleanup,
        "function",
      );
      assert.equal(lifecycle.hasPendingShadowLadybugDatabaseCleanup(), true);
      await assert.rejects(
        withSharedLadybugOperation(async () => undefined),
        /LadybugDB is closing/iu,
      );

      failClose = false;
      await withLadybugCloseOperation(
        async () => lifecycle.retryPendingShadowLadybugDatabaseCleanup(),
        () => !lifecycle.hasPendingShadowLadybugDatabaseCleanup(),
      );
      assert.equal(lifecycle.hasPendingShadowLadybugDatabaseCleanup(), false);
      assert.equal(connectionCloseCalls, 2);
      assert.equal(databaseCloseCalls, 2);
    } finally {
      failClose = false;
      if (
        lifecycle.hasPendingShadowLadybugDatabaseCleanup?.()
      ) {
        await withLadybugCloseOperation(
          async () => lifecycle.retryPendingShadowLadybugDatabaseCleanup(),
          () => !lifecycle.hasPendingShadowLadybugDatabaseCleanup(),
        );
      }
      await withLadybugInitialization(async () => {});
    }
  });
});
