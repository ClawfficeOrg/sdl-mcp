import assert from "node:assert";
import { describe, it } from "node:test";

import { DatabaseError } from "../../dist/domain/errors.js";
import {
  withExclusiveLadybugOperation,
  withSharedLadybugOperation,
} from "../../dist/db/ladybug-operation-gate.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Ladybug operation gate", { timeout: 5_000 }, () => {
  it("admits shared roots concurrently", async () => {
    const release = deferred<void>();
    const entered = [deferred<void>(), deferred<void>()];

    const operations = entered.map((signal) =>
      withSharedLadybugOperation(async () => {
        signal.resolve();
        await release.promise;
      }),
    );

    await Promise.all(entered.map((signal) => signal.promise));
    release.resolve();
    await Promise.all(operations);
  });

  it("gives a queued exclusive operation preference over new shared roots", async () => {
    const releaseFirstShared = deferred<void>();
    const releaseExclusive = deferred<void>();
    const firstSharedEntered = deferred<void>();
    const exclusiveEntered = deferred<void>();
    const order: string[] = [];

    const firstShared = withSharedLadybugOperation(async () => {
      order.push("shared-1");
      firstSharedEntered.resolve();
      await releaseFirstShared.promise;
    });
    await firstSharedEntered.promise;

    const exclusive = withExclusiveLadybugOperation(async () => {
      order.push("exclusive");
      exclusiveEntered.resolve();
      await releaseExclusive.promise;
    });
    const secondShared = withSharedLadybugOperation(async () => {
      order.push("shared-2");
    });

    releaseFirstShared.resolve();
    await exclusiveEntered.promise;
    assert.deepStrictEqual(order, ["shared-1", "exclusive"]);

    releaseExclusive.resolve();
    await Promise.all([firstShared, exclusive, secondShared]);
    assert.deepStrictEqual(order, ["shared-1", "exclusive", "shared-2"]);
  });

  it("serializes exclusive roots", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    let secondEntered = false;

    const first = withExclusiveLadybugOperation(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withExclusiveLadybugOperation(async () => {
      secondEntered = true;
    });
    await nextTurn();
    assert.strictEqual(secondEntered, false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.strictEqual(secondEntered, true);
  });

  it("reuses shared admission and waits for already-started nested work", async () => {
    const outerEntered = deferred<void>();
    const startNested = deferred<void>();
    const nestedEntered = deferred<void>();
    const releaseNested = deferred<void>();
    let outerSettled = false;

    const outer = withSharedLadybugOperation(async () => {
      outerEntered.resolve();
      await startNested.promise;
      void withSharedLadybugOperation(async () => {
        nestedEntered.resolve();
        await releaseNested.promise;
      });
    });
    void outer.then(() => {
      outerSettled = true;
    });
    await outerEntered.promise;

    const queuedExclusive = withExclusiveLadybugOperation(async () => undefined);
    startNested.resolve();
    await nestedEntered.promise;
    await nextTurn();
    assert.strictEqual(outerSettled, false);

    releaseNested.resolve();
    await Promise.all([outer, queuedExclusive]);
    assert.strictEqual(outerSettled, true);
  });

  it("reuses exclusive admission for nested shared work", async () => {
    const events: string[] = [];

    await withExclusiveLadybugOperation(async () => {
      events.push("exclusive");
      await withSharedLadybugOperation(async () => {
        events.push("shared");
      });
    });

    assert.deepStrictEqual(events, ["exclusive", "shared"]);
  });

  it("reuses exclusive admission for nested exclusive work", async () => {
    const events: string[] = [];

    await withExclusiveLadybugOperation(async () => {
      events.push("outer");
      await withExclusiveLadybugOperation(async () => {
        events.push("inner");
      });
    });

    assert.deepStrictEqual(events, ["outer", "inner"]);
  });

  it("rejects a shared-to-exclusive upgrade", async () => {
    await withSharedLadybugOperation(async () => {
      await assert.rejects(
        withExclusiveLadybugOperation(async () => undefined),
        DatabaseError,
      );
    });
  });

  it("removes a timed-out exclusive and admits shared work behind it", async () => {
    const firstSharedEntered = deferred<void>();
    const releaseFirstShared = deferred<void>();
    let timedOutExclusiveRan = false;
    let queuedSharedRan = false;

    const firstShared = withSharedLadybugOperation(async () => {
      firstSharedEntered.resolve();
      await releaseFirstShared.promise;
    });
    await firstSharedEntered.promise;

    const timedOutExclusive = withExclusiveLadybugOperation(async () => {
      timedOutExclusiveRan = true;
    }, 20);
    const queuedShared = withSharedLadybugOperation(async () => {
      queuedSharedRan = true;
    });

    try {
      await nextTurn();
      assert.strictEqual(queuedSharedRan, false);
      await assert.rejects(timedOutExclusive, DatabaseError);
      await queuedShared;
      assert.strictEqual(timedOutExclusiveRan, false);
      assert.strictEqual(queuedSharedRan, true);
    } finally {
      releaseFirstShared.resolve();
      await Promise.allSettled([firstShared, queuedShared]);
    }
  });

  it("reacquires when a detached callback inherits a stale context", async () => {
    const triggerDetached = deferred<void>();
    let detachedStarted = false;
    let detached: Promise<void> | undefined;

    await withSharedLadybugOperation(async () => {
      detached = triggerDetached.promise.then(() =>
        withSharedLadybugOperation(async () => {
          detachedStarted = true;
        }),
      );
    });

    const exclusiveEntered = deferred<void>();
    const releaseExclusive = deferred<void>();
    const exclusive = withExclusiveLadybugOperation(async () => {
      exclusiveEntered.resolve();
      await releaseExclusive.promise;
    });
    await exclusiveEntered.promise;

    triggerDetached.resolve();
    await nextTurn();
    assert.strictEqual(detachedStarted, false);

    releaseExclusive.resolve();
    await exclusive;
    await detached;
    assert.strictEqual(detachedStarted, true);
  });
});
