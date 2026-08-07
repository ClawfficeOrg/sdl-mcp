import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getDerivedState,
  markGraphIntegrityVerified,
  markGraphIntegrityVerifying,
} from "../../dist/db/ladybug-derived-state.js";
import { capturePersistedGraphIntegrity } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { loadBuiltInAdapters } from "../../dist/indexer/adapter/registry.js";
import { patchSavedFile } from "../../dist/live-index/file-patcher.js";

describe("patchSavedFile", () => {
  const repoId = "file-patcher-repo";
  const configPath = join(tmpdir(), `sdl-file-patcher-${Date.now()}.json`);
  let dbDir = "";
  let dbPath = "";
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "sdl-file-patcher-db-"));
    dbPath = join(dbDir, "sdl-mcp-graph.lbug");
    repoDir = mkdtempSync(join(tmpdir(), "sdl-file-patcher-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    process.env.SDL_GRAPH_DB_PATH = dbPath;
    try {
      await closeLadybugDb();
    } catch {
      /* may already be closed */
    }
    await initLadybugDb(dbPath);
    loadBuiltInAdapters();
    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "verified live-edit baseline",
      prevVersionHash: null,
      versionHash: null,
    });
    const baseline = await capturePersistedGraphIntegrity(conn, repoId);
    await markGraphIntegrityVerified(repoId, "v1", baseline.digest);
  });

  after(async () => {
    await closeLadybugDb();
    if (dbDir && existsSync(dbDir))
      rmSync(dbDir, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir))
      rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("rejects before parsing or writing when parser provenance is incomplete", async () => {
    const beforeState = await getDerivedState(repoId);
    assert.equal(beforeState?.graphIntegrityState, "verified");
    assert.equal(beforeState?.graphIntegrityRevision, 0);

    await assert.rejects(
      () =>
        patchSavedFile({
          repoId,
          filePath: "src/example.ts",
          content: "export function changed() { return 2; }",
          language: "typescript",
          version: 2,
        }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "PARSER_PROVENANCE_INCOMPLETE",
        );
        return true;
      },
    );

    const conn = await getLadybugConn();
    assert.equal(
      await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts"),
      null,
    );
    const afterState = await getDerivedState(repoId);
    assert.equal(afterState?.graphIntegrityState, "verified");
    assert.equal(afterState?.graphIntegrityRevision, 0);
    assert.equal(afterState?.graphIntegrityVerifiedRevision, 0);
  });

  it("surfaces a missing watched path before provenance preflight", async () => {
    await markGraphIntegrityVerifying(repoId, "v1");
    await assert.rejects(
      patchSavedFile({
        repoId,
        filePath: "src/deleted.ts",
        language: "typescript",
        version: 3,
      }),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        return true;
      },
    );
  });
});
