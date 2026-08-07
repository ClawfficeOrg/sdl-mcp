import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { getDerivedState } from "../../dist/db/ladybug-derived-state.js";
import {
  cancelAndWaitForGraphIntegrityVerifier,
  waitForGraphIntegrityVerifier,
} from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { createGraphIntegrityFileDigest } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { NATIVE_PARSER_CONTRACT } from "../../dist/indexer/parser-provenance.js";
import {
  getNativeContentParserCapability,
  isRustEngineAvailable,
} from "../../dist/indexer/rustIndexer.js";
import { patchSavedFile } from "../../dist/live-index/file-patcher.js";

test(
  "native mjs live edits retain parser identity and verified integrity",
  { timeout: 120_000 },
  async () => {
    assert.equal(
      isRustEngineAvailable(),
      true,
      "native addon is required; run npm run build:native",
    );
    assert.deepEqual(getNativeContentParserCapability(), {
      available: true,
      contract: NATIVE_PARSER_CONTRACT.engineContract,
    });

    const repoId = "native-engine-affine-live-index";
    const tempRoot = mkdtempSync(join(tmpdir(), "sdl-native-live-index-"));
    const repoRoot = join(tempRoot, "repo");
    const initialPath = "scripts/run-tests.mjs";
    const newPath = "scripts/new-task.mjs";
    const absoluteInitialPath = join(repoRoot, initialPath);
    const absoluteNewPath = join(repoRoot, newPath);
    const dbPath = join(tempRoot, "graph", "sdl-mcp-graph.lbug");
    const configPath = join(tempRoot, "sdlmcp.config.json");
    const previousConfig = process.env.SDL_CONFIG;
    const previousConfigPath = process.env.SDL_CONFIG_PATH;
    const previousGraphPath = process.env.SDL_GRAPH_DB_PATH;
    const previousDisableNative = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

    const initialContent = [
      "export function runTests() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const editedContent = [
      "export function runTests() {",
      "  return 2;",
      "}",
      "",
      "export function helper() {",
      "  return runTests();",
      "}",
      "",
    ].join("\n");
    const newContent = [
      "export function newTask() {",
      "  return 3;",
      "}",
      "",
    ].join("\n");

    try {
      mkdirSync(dirname(absoluteInitialPath), { recursive: true });
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(absoluteInitialPath, initialContent, "utf8");
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            repos: [],
            policy: {},
            graphDatabase: { path: dbPath.replace(/\\/g, "/") },
            indexing: {
              engine: "rust",
              enableFileWatching: false,
            },
            scip: { enabled: false },
            semantic: {
              enabled: false,
              generateSummaries: false,
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      process.env.SDL_CONFIG = configPath;
      delete process.env.SDL_CONFIG_PATH;
      process.env.SDL_GRAPH_DB_PATH = dbPath;
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
      invalidateConfigCache();

      await closeLadybugDb();
      await initLadybugDb(dbPath);
      await withWriteConn((conn) =>
        ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath: repoRoot,
          configJson: JSON.stringify({
            repoId,
            rootPath: repoRoot,
            ignore: [],
            languages: ["mjs"],
            maxFileBytes: 2_000_000,
            includeNodeModulesTypes: true,
          }),
          createdAt: "2026-08-07T12:00:00.000Z",
        }),
      );

      let indexed: Awaited<ReturnType<typeof indexRepo>>;
      try {
        indexed = await indexRepo(
          repoId,
          "full",
          undefined,
          undefined,
          { isolatedRebuild: true },
        );
      } catch (error) {
        const diagnosticConn = await getLadybugConn();
        console.error({
          files: await ladybugDb.getFilesByRepo(diagnosticConn, repoId),
          parserStates: await ladybugDb.listFileParserStates(
            diagnosticConn,
            repoId,
          ),
        });
        throw error;
      }
      let conn = await getLadybugConn();
      const initialFile = await ladybugDb.getFileByRepoPath(
        conn,
        repoId,
        initialPath,
      );
      assert.ok(initialFile);
      assert.deepEqual(
        await ladybugDb.getFileParserState(conn, repoId, initialFile.fileId),
        {
          stateId: JSON.stringify([repoId, initialFile.fileId]),
          repoId,
          fileId: initialFile.fileId,
          ...NATIVE_PARSER_CONTRACT,
        },
      );

      writeFileSync(absoluteInitialPath, editedContent, "utf8");
      const edited = await patchSavedFile({
        repoId,
        filePath: initialPath,
        content: editedContent,
        language: "typescript",
        version: 1,
      });
      assert.equal(edited.parseResult.parserContract.engine, "native");
      await waitForGraphIntegrityVerifier(repoId);

      mkdirSync(dirname(absoluteNewPath), { recursive: true });
      writeFileSync(absoluteNewPath, newContent, "utf8");
      const added = await patchSavedFile({
        repoId,
        filePath: newPath,
        content: newContent,
        language: "typescript",
        version: 2,
      });
      assert.equal(added.parseResult.parserContract.engine, "native");
      await waitForGraphIntegrityVerifier(repoId);

      conn = await getLadybugConn();
      const derived = await getDerivedState(repoId);
      assert.equal(derived?.graphIntegrityState, "verified");
      assert.equal(
        derived?.graphIntegrityRevision,
        derived?.graphIntegrityVerifiedRevision,
      );
      assert.equal(derived?.graphIntegrityVersionId, indexed.versionId);
      const repoParserState = await ladybugDb.getRepoParserState(conn, repoId);
      assert.equal(repoParserState?.coverageState, "complete");
      assert.equal(
        repoParserState?.graphVersionId,
        derived?.graphIntegrityVersionId,
      );
      assert.equal(
        repoParserState?.graphRevision,
        derived?.graphIntegrityVerifiedRevision,
      );

      for (const relPath of [initialPath, newPath]) {
        const file = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
        assert.ok(file);
        const parserState = await ladybugDb.getFileParserState(
          conn,
          repoId,
          file.fileId,
        );
        assert.equal(parserState?.engine, "native");
        assert.equal(
          parserState?.engineContract,
          NATIVE_PARSER_CONTRACT.engineContract,
        );

        const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
        const expected = createGraphIntegrityFileDigest({
          fileId: file.fileId,
          relPath,
          symbols,
        });
        const persisted = await ladybugDb.getGraphIntegrityFileState(
          conn,
          repoId,
          file.fileId,
        );
        assert.ok(persisted);
        assert.equal(persisted.digest, expected.digest);
        assert.equal(persisted.symbolCount, expected.symbolCount);
      }
    } finally {
      await cancelAndWaitForGraphIntegrityVerifier(repoId).catch(() => {});
      await closeLadybugDb().catch(() => {});
      if (previousConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousConfig;
      if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
      else process.env.SDL_CONFIG_PATH = previousConfigPath;
      if (previousGraphPath === undefined) delete process.env.SDL_GRAPH_DB_PATH;
      else process.env.SDL_GRAPH_DB_PATH = previousGraphPath;
      if (previousDisableNative === undefined) {
        delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
      } else {
        process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousDisableNative;
      }
      invalidateConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
