import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";

describe("Ladybug production lineage guard", { concurrency: 1 }, () => {
  let testRoot = "";

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    if (testRoot && existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    testRoot = "";
  });

  function createPath(): string {
    testRoot = mkdtempSync(join(tmpdir(), "sdl-ladybug-lineage-init-"));
    return join(testRoot, "graph.lbug");
  }

  it("marks a fresh normal init and preserves primary identity across checkpoint and reopen", async () => {
    const dbPath = createPath();
    const markerPath = dbPath + ".sdl-lineage.json";

    await initLadybugDb(dbPath);

    assert.equal(existsSync(markerPath), true);
    const receiptBefore = readFileSync(markerPath, "utf8");
    const identityBefore = statSync(dbPath, { bigint: true });
    // Strict close checkpoints the primary before the separate reopen.
    await closeLadybugDb({ strict: true });
    const identityAfter = statSync(dbPath, { bigint: true });
    assert.equal(identityAfter.dev, identityBefore.dev);
    assert.equal(identityAfter.ino, identityBefore.ino);

    await initLadybugDb(dbPath);
    assert.equal(readFileSync(markerPath, "utf8"), receiptBefore);
  });

  it("rejects an unmarked existing database before production reopen", async () => {
    const dbPath = createPath();
    const markerPath = dbPath + ".sdl-lineage.json";
    await initLadybugDb(dbPath);
    await closeLadybugDb({ strict: true });
    rmSync(markerPath, { force: true });

    await assert.rejects(
      initLadybugDb(dbPath),
      /lineage marker is missing[\s\S]*--safe-rebuild/iu,
    );
  });
});
