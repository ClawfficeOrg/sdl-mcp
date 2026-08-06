import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { resolveEffectiveIndexMode } from "../../dist/indexer/index-mode.js";

describe("command-wide effective index modes", () => {
  let graphDbPath = "";

  before(async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-index-mode-plan-"));
    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    const conn = await getLadybugConn();
    const createdAt = new Date().toISOString();
    for (const repoId of ["forced", "empty", "populated"]) {
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: `F:/${repoId}`,
        configJson: "{}",
        createdAt,
      });
    }
    await ladybugDb.upsertFile(conn, {
      fileId: "populated:file.ts",
      repoId: "populated",
      relPath: "file.ts",
      contentHash: "hash",
      language: "typescript",
      byteSize: 1,
      lastIndexedAt: createdAt,
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (graphDbPath && existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("resolves missing, forced, zero-file, and populated repositories before eligibility", async () => {
    const conn = await getLadybugConn();
    const modes = new Map<string, "full" | "incremental">();
    for (const [repoId, requestedMode] of [
      ["initial", "incremental"],
      ["forced", "full"],
      ["empty", "incremental"],
      ["populated", "incremental"],
    ] as const) {
      modes.set(
        repoId,
        await resolveEffectiveIndexMode(repoId, requestedMode, conn),
      );
    }

    assert.deepStrictEqual([...modes], [
      ["initial", "full"],
      ["forced", "full"],
      ["empty", "full"],
      ["populated", "incremental"],
    ]);
  });
});
