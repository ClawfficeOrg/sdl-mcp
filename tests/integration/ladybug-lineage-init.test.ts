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

import { fingerprintDbFamily } from "../../dist/benchmark/external-runner.js";
import { bindVerifiedLadybugClone } from "../../dist/db/ladybug-lineage.js";
import {
  closeLadybugDb,
  initLadybugDb,
  initValidatedLadybugClone,
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

    assert.equal(
      existsSync(markerPath),
      false,
      "a live fresh database is not stamped before strict close",
    );
    assert.equal(existsSync(dbPath + ".sdl-family.lock"), true);
    const identityBefore = statSync(dbPath, { bigint: true });
    // Strict close checkpoints the primary before publishing its closed-family receipt.
    await closeLadybugDb({ strict: true });
    assert.equal(existsSync(markerPath), true);
    assert.equal(existsSync(dbPath + ".sdl-family.lock"), false);
    const receiptBefore = readFileSync(markerPath, "utf8");
    const identityAfter = statSync(dbPath, { bigint: true });
    assert.equal(identityAfter.dev, identityBefore.dev);
    assert.equal(identityAfter.ino, identityBefore.ino);

    await initLadybugDb(dbPath);
    assert.equal(readFileSync(markerPath, "utf8"), receiptBefore);
    assert.equal(existsSync(dbPath + ".sdl-family.lock"), true);
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

  it("promotes a verified clone into the normal closed-family lifecycle", async () => {
    const dbPath = createPath();
    const markerPath = dbPath + ".sdl-lineage.json";
    await initLadybugDb(dbPath);
    await closeLadybugDb({ strict: true });
    rmSync(markerPath, { force: true });

    const authority = bindVerifiedLadybugClone(
      dbPath,
      fingerprintDbFamily(dbPath),
    );
    await initValidatedLadybugClone(dbPath, authority);
    await closeLadybugDb({ strict: true });

    assert.equal(existsSync(markerPath), true);
    await assert.doesNotReject(initLadybugDb(dbPath));
  });
});
