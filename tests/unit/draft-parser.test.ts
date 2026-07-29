import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setDraftSymbolFallbackObserverForTests,
  parseDraftFile,
} from "../../dist/live-index/draft-parser.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getAdapterForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";

const TEST_CASE_JSON =
  '{"framework":"node:test","title":"keeps sdl.info callable","suitePath":["Code Mode"],"modifiers":["only"]}';

describe("parseDraftFile", () => {
  const testDbDir = mkdtempSync(join(tmpdir(), "sdl-draft-parser-test-"));
  const testDbPath = join(testDbDir, "test.lbug");

  const prevGraphDbPath = process.env.SDL_GRAPH_DB_PATH;

  before(async () => {
    process.env.SDL_GRAPH_DB_PATH = testDbPath;
    try {
      await closeLadybugDb();
    } catch {
      /* may already be closed */
    }
    await initLadybugDb(testDbPath);
    loadBuiltInAdapters();
  });

  after(async () => {
    try {
      await closeLadybugDb();
    } catch {
      /* ignore */
    }
    // Restore env var but don't re-init DB - let the next process handle it.
    // Re-initializing here leaves a connection open that causes segfault on exit.
    if (prevGraphDbPath) {
      process.env.SDL_GRAPH_DB_PATH = prevGraphDbPath;
    } else {
      delete process.env.SDL_GRAPH_DB_PATH;
    }
    // Clean up test DB and WAL file
    rmSync(testDbDir, { recursive: true, force: true });
  });

  it("extracts file-owned symbols, edges, and references from unsaved content", async () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);
    const extractSymbols = adapter.extractSymbols;
    adapter.extractSymbols = (...args) =>
      extractSymbols.call(adapter, ...args).map((symbol, index) =>
        index === 0
          ? {
              ...symbol,
              testCase: {
                framework: "node:test",
                title: "keeps sdl.info callable",
                suitePath: ["Code Mode"],
                modifiers: ["only"],
              },
            }
          : symbol,
      );
    let result: Awaited<ReturnType<typeof parseDraftFile>>;
    try {
      result = await parseDraftFile({
        repoId: "demo-repo",
        repoRoot: process.cwd(),
        filePath: "tests/example.test.ts",
        content: [
          "export function alpha() {",
          "  return beta();",
          "}",
          "",
          "function beta() {",
          "  return 1;",
          "}",
        ].join("\n"),
        languages: ["ts"],
        language: "typescript",
        version: 5,
      });
    } finally {
      adapter.extractSymbols = extractSymbols;
    }

    assert.strictEqual(result.file.relPath, "tests/example.test.ts");
    assert.strictEqual(result.symbols.length, 2);
    assert.ok(result.symbols.some((symbol) => symbol.name === "alpha"));
    assert.ok(result.symbols.some((symbol) => symbol.name === "beta"));
    const alpha = result.symbols.find((symbol) => symbol.name === "alpha");
    const beta = result.symbols.find((symbol) => symbol.name === "beta");
    assert.strictEqual(alpha?.testCaseJson, TEST_CASE_JSON);
    assert.strictEqual(beta?.testCaseJson ?? null, null);
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.edgeType === "call" &&
          edge.fromSymbolId === alpha?.symbolId &&
          edge.toSymbolId === beta?.symbolId,
      ),
    );
    assert.ok(result.references.some((ref) => ref.symbolName === "alpha"));
  });

  it("reports durable SymbolID fallback without changing draft output", async () => {
    const input = {
      repoId: "durable-fallback-repo",
      repoRoot: process.cwd(),
      filePath: "src/durable.ts",
      content: "export function stable() { return 1; }\n",
      languages: ["ts"],
      language: "typescript",
      version: 1,
    };
    const initial = await parseDraftFile(input);
    const durableSymbol = initial.symbols.find((symbol) => symbol.name === "stable");
    assert.ok(durableSymbol);

    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: input.repoId,
      rootPath: input.repoRoot,
      configJson: "{}",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await ladybugDb.upsertFile(conn, initial.file);
    await ladybugDb.upsertSymbol(conn, durableSymbol);

    const fallbacks: string[] = [];
    _setDraftSymbolFallbackObserverForTests((matchKey) => fallbacks.push(matchKey));
    try {
      const changed = await parseDraftFile({
        ...input,
        content: "export function stable() { return 2; }\n",
        version: 2,
      });
      assert.deepEqual(fallbacks, ["function:stable:1:7"]);
      assert.equal(changed.symbols[0]?.symbolId, durableSymbol.symbolId);
    } finally {
      _setDraftSymbolFallbackObserverForTests();
    }
  });


  it("normalizes static test cases from retained draft content", async () => {
    const content = readFileSync(
      join(
        process.cwd(),
        "tests",
        "fixtures",
        "semantic-test-cases",
        "sample.test.ts",
      ),
      "utf8",
    );
    const result = await parseDraftFile({
      repoId: "draft-test-case-repo",
      repoRoot: process.cwd(),
      filePath: "src/embedded-cases.ts",
      content,
      languages: ["ts"],
      language: "typescript",
      version: 1,
    });

    const cases = result.symbols.filter(
      (symbol) => symbol.testCaseJson !== null,
    );
    assert.equal(cases.length, 2);
    assert.deepEqual(
      cases.map((symbol) => ({
        name: symbol.name,
        range: [
          symbol.rangeStartLine,
          symbol.rangeStartCol,
          symbol.rangeEndLine,
          symbol.rangeEndCol,
        ],
        testCaseJson: symbol.testCaseJson,
      })),
      [
        {
          name: "duplicate case",
          range: [13, 2, 21, 4],
          testCaseJson:
            '{"framework":"jest","title":"duplicate case","suitePath":["outer suite"]}',
        },
        {
          name: "duplicate case",
          range: [23, 2, 25, 4],
          testCaseJson:
            '{"framework":"jest","title":"duplicate case","suitePath":["outer suite"]}',
        },
      ],
    );
    assert.ok(cases.every((symbol) => symbol.symbolId.length > 0));
    assert.notEqual(cases[0]?.symbolId, cases[1]?.symbolId);
    assert.ok(cases.every((symbol) => symbol.astFingerprint.length > 0));

    const caseTarget = result.symbols.find(
      (symbol) => symbol.name === "caseTarget",
    );
    const helperTarget = result.symbols.find(
      (symbol) => symbol.name === "helperTarget",
    );
    const nestedHelper = result.symbols.find(
      (symbol) => symbol.name === "nestedHelper",
    );
    assert.ok(caseTarget && helperTarget && nestedHelper);
    assert.equal(
      result.edges.filter(
        (edge) =>
          edge.edgeType === "call" &&
          edge.toSymbolId === caseTarget.symbolId &&
          cases.some((testCase) => testCase.symbolId === edge.fromSymbolId),
      ).length,
      2,
    );
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.edgeType === "call" &&
          edge.fromSymbolId === nestedHelper.symbolId &&
          edge.toSymbolId === helperTarget.symbolId,
      ),
    );
  });


});
