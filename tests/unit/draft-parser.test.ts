import { after, before, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setDraftSymbolFallbackObserverForTests,
  parseDraftFile,
  parserCoverageMatchesVerifiedGraph,
  resolveDraftSymbolRemap,
  type DraftParserPreflight,
} from "../../dist/live-index/draft-parser.js";
import { BUILTIN_TYPESCRIPT_PARSER_CONTRACT } from "../../dist/indexer/parser-provenance.js";
import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import {
  getAdapterForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";

const TEST_CASE_JSON =
  '{"framework":"node:test","title":"keeps sdl.info callable","suitePath":["Code Mode"],"modifiers":["only"]}';

function newFilePreflight(
  repoId: string,
  relPath: string,
): DraftParserPreflight {
  return {
    repoId,
    relPath,
    durableFile: null,
    durableSymbols: [],
    contract: BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
    graphVersionId: "v1",
    graphRevision: 0,
    pruningSupported: true,
    repoParserState: {
      repoId,
      coverageState: "complete",
      graphVersionId: "v1",
      graphRevision: 0,
      coverageDigest: "a".repeat(64),
    },
  };
}

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
      result = await parseDraftFile(
        {
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
        },
        newFilePreflight("demo-repo", "tests/example.test.ts"),
      );
    } finally {
      adapter.extractSymbols = extractSymbols;
    }

    assert.strictEqual(result.parserContract, BUILTIN_TYPESCRIPT_PARSER_CONTRACT);
    assert.equal(result.graphVersionId, "v1");
    assert.equal(result.graphRevision, 0);
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
    const initial = await parseDraftFile(
      input,
      newFilePreflight(input.repoId, input.filePath),
    );
    const durableSymbol = initial.symbols.find(
      (symbol) => symbol.name === "stable",
    );
    assert.ok(durableSymbol);

    const fallbacks: string[] = [];
    _setDraftSymbolFallbackObserverForTests((matchKey) =>
      fallbacks.push(matchKey),
    );
    try {
      const changed = await parseDraftFile(
        {
          ...input,
          content: "export function stable() { return 2; }\n",
          version: 2,
        },
        {
          ...newFilePreflight(input.repoId, input.filePath),
          durableFile: initial.file,
          durableSymbols: [durableSymbol],
        },
      );
      assert.deepEqual(fallbacks, ["function:stable:1:0"]);
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
    const result = await parseDraftFile(
      {
        repoId: "draft-test-case-repo",
        repoRoot: process.cwd(),
        filePath: "src/embedded-cases.ts",
        content,
        languages: ["ts"],
        language: "typescript",
        version: 1,
      },
      newFilePreflight("draft-test-case-repo", "src/embedded-cases.ts"),
    );

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

test("rejects duplicate durable symbol remap keys", () => {
  assert.throws(
    () =>
      resolveDraftSymbolRemap(
        [
          {
            symbolId: "old-a",
            kind: "function",
            name: "run",
            rangeStartLine: 1,
            rangeStartCol: 0,
          },
          {
            symbolId: "old-b",
            kind: "function",
            name: "run",
            rangeStartLine: 1,
            rangeStartCol: 0,
          },
        ],
        [
          {
            symbolId: "native-new",
            kind: "function",
            name: "run",
            range: { startLine: 1, startCol: 0 },
          },
        ],
        "src/example.ts",
        "native:1",
      ),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "PARSER_SYMBOL_REMAP");
      return true;
    },
  );
});

test("binds parser coverage to the same verified version and revision", () => {
  const graph = {
    graphIntegrityState: "verified",
    graphIntegrityVersionId: "v1",
    graphIntegrityRevision: 3,
    graphIntegrityVerifiedRevision: 3,
    graphIntegrityDigest: "b".repeat(64),
    graphIntegrityFilelessPruningSupported: true,
    graphIntegrityManifestEstablished: true,
  };
  const coverage = {
    repoId: "repo",
    coverageState: "complete",
    graphVersionId: "v1",
    graphRevision: 3,
    coverageDigest: "a".repeat(64),
  };

  assert.equal(parserCoverageMatchesVerifiedGraph(graph, "v1", coverage), true);
  assert.equal(
    parserCoverageMatchesVerifiedGraph(
      graph,
      "v1",
      { ...coverage, coverageState: "partial" },
    ),
    true,
  );
  for (const candidate of [
    { graph: { ...graph, graphIntegrityState: "verifying" } },
    { graph: { ...graph, graphIntegrityVerifiedRevision: 2 } },
    { coverage: { ...coverage, coverageState: "incomplete" } },
    { coverage: { ...coverage, graphVersionId: "v2" } },
    { coverage: { ...coverage, graphRevision: 2 } },
  ]) {
    assert.equal(
      parserCoverageMatchesVerifiedGraph(
        candidate.graph ?? graph,
        "v1",
        candidate.coverage ?? coverage,
      ),
      false,
    );
  }
});

test("retains only an exact same-position durable symbol ID", () => {
  const durable = [{
    symbolId: "durable",
    kind: "function",
    name: "run",
    rangeStartLine: 1,
    rangeStartCol: 0,
  }];
  const exact = resolveDraftSymbolRemap(
    durable,
    [{
      symbolId: "selected-engine",
      kind: "function",
      name: "run",
      range: { startLine: 1, startCol: 0 },
    }],
    "src/example.ts",
    "typescript:1",
  );
  assert.equal(exact.get("selected-engine"), "durable");

  const moved = resolveDraftSymbolRemap(
    durable,
    [{
      symbolId: "moved-engine-id",
      kind: "function",
      name: "run",
      range: { startLine: 2, startCol: 0 },
    }],
    "src/example.ts",
    "typescript:1",
  );
  assert.equal(moved.size, 0);
});

test("rejects duplicate parsed keys and final ID collisions", () => {
  const durable = [{
    symbolId: "durable",
    kind: "function",
    name: "run",
    rangeStartLine: 1,
    rangeStartCol: 0,
  }];
  const assertRemapRejected = (
    candidates: Parameters<typeof resolveDraftSymbolRemap>[1],
  ) => assert.throws(
    () => resolveDraftSymbolRemap(
      durable,
      candidates,
      "src/example.ts",
      "typescript:1",
    ),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "PARSER_SYMBOL_REMAP");
      return true;
    },
  );

  assertRemapRejected([
    {
      symbolId: "one",
      kind: "function",
      name: "run",
      range: { startLine: 1, startCol: 0 },
    },
    {
      symbolId: "two",
      kind: "function",
      name: "run",
      range: { startLine: 1, startCol: 0 },
    },
  ]);
  assertRemapRejected([
    {
      symbolId: "selected",
      kind: "function",
      name: "run",
      range: { startLine: 1, startCol: 0 },
    },
    {
      symbolId: "durable",
      kind: "function",
      name: "other",
      range: { startLine: 2, startCol: 0 },
    },
  ]);
});
