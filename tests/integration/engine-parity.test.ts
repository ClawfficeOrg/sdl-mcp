// Engine parity integration test (Task 1.13).
//
// Walks every fixture under tests/fixtures/<lang>/ with a supported indexed
// source extension and asserts that the TypeScript Pass-1 engine and the
// Rust Pass-1 engine produce identical ExtractedSymbol[] / ExtractedImport[] /
// ExtractedCall[] arrays under the allowlist documented in
// tests/harness/engine-parity-runner.ts.
//
// Skips cleanly when the native addon is unavailable (e.g. CI set
// SDL_MCP_DISABLE_NATIVE_ADDON=1).
//
// Baseline mode: set SDL_PARITY_HARNESS_BASELINE=1 to log diffs without
// failing. This is intended for use during the Tasks 1.8–1.10 rollout,
// when parity is being actively improved and failing the suite would block
// unrelated work.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RepoConfigSchema } from "../../dist/config/types.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import type { SymbolRow } from "../../dist/db/ladybug-queries.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { markGraphIntegrityVerified } from "../../dist/db/ladybug-derived-state.js";
import { isRustEngineAvailable } from "../../dist/indexer/rustIndexer.js";
import { applyTestCaseCandidates } from "../../dist/indexer/test-case-normalizer.js";
import {
  getAdapterForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";
import { parseDraftFile } from "../../dist/live-index/draft-parser.js";
import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";
import { parseAndExtract } from "../../dist/indexer/parser/parse-and-extract.js";
import { processFileFromRustResult } from "../../dist/indexer/parser/rust-process-file.js";
import { buildSymbolDetails } from "../../dist/indexer/parser/symbol-mapping.js";
import { providerFactsToGraphRows } from "../../dist/indexer/provider-first/materializer.js";
import { capturePersistedGraphIntegrity } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import type { ProviderFactSet } from "../../dist/indexer/provider-first/types.js";
import type { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { serializeTestCaseFacet } from "../../dist/util/test-case.js";
import {
  runEngineParityCheck,
  type ParityResult,
} from "../harness/engine-parity-runner.ts";

// Indexed source extensions supported by the SDL Pass-1 engine. Must match
// the registry in src/indexer/adapter/registry.ts; kept in sync manually.
const INDEXED_EXTENSIONS = new Set<string>([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyw",
  "go",
  "java",
  "cs",
  "c", "h", "cpp", "hpp", "cc", "cxx", "hxx",
  "php",
  "rs",
  "sh", "bash",
]);

// Skip large / synthetic fixture trees that aren't meant to be parsed as
// standalone single-file inputs (they depend on sibling files, package.json,
// node_modules, etc.).
const SKIP_DIRS = new Set<string>([
  "clustered-repo",
  "native-addon",
]);

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "tests", "fixtures");
const BASELINE_MODE = /^(1|true)$/i.test(process.env.SDL_PARITY_HARNESS_BASELINE ?? "");

function collectFixtures(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFixtures(abs, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
    if (!INDEXED_EXTENSIONS.has(ext)) continue;
    acc.push(abs);
  }
  return acc;
}

function totalDiffs(result: ParityResult): number {
  return (
    result.symbolDiffs.length +
    result.importDiffs.length +
    result.callDiffs.length +
    (result.testCaseIdentityDiffs?.length ?? 0)
  );
}

describe("Engine parity: TS Pass-1 vs Rust Pass-1 (Task 1.13)", () => {
  if (!isRustEngineAvailable()) {
    it("skipped - native addon unavailable", () => {
      assert.ok(true);
    });
    return;
  }

  let fixtures: string[];
  try {
    const stat = statSync(FIXTURES_ROOT);
    if (!stat.isDirectory()) {
      it("skipped - fixtures root is not a directory", () => assert.ok(true));
      return;
    }
    fixtures = collectFixtures(FIXTURES_ROOT).sort();
  } catch (err) {
    it("skipped - fixtures root missing", () => {
      assert.ok(true, String(err));
    });
    return;
  }

  if (fixtures.length === 0) {
    it("skipped - no fixtures discovered", () => assert.ok(true));
    return;
  }

  for (const fixture of fixtures) {
    const label = fixture.slice(REPO_ROOT.length + 1).split(/[\\/]/).join("/");
    it(`${label}`, async () => {
      const result = await runEngineParityCheck(fixture, REPO_ROOT);
      if (result.skipped) {
        // Parity is skipped for this fixture (unsupported language, parse
        // error, etc.). Not a failure.
        return;
      }
      assert.ok(Array.isArray(result.engineIdentityDiffs));
      if (BASELINE_MODE && result.engineIdentityDiffs.length > 0) {
        console.warn(
          `[parity-identity] ${label}: ${result.engineIdentityDiffs.length} diagnostic difference(s)`,
          JSON.stringify(result.engineIdentityDiffs.slice(0, 3), null, 2),
        );
      }
      const diffCount = totalDiffs(result);
      if (diffCount === 0) return;
      if (BASELINE_MODE) {
        console.warn(
          `[parity-baseline] ${label}: ${diffCount} diff(s)`,
          JSON.stringify(
            {
              symbolDiffs: result.symbolDiffs.slice(0, 3),
              importDiffs: result.importDiffs.slice(0, 3),
              callDiffs: result.callDiffs.slice(0, 3),
            },
            null,
            2,
          ),
        );
        return;
      }
      assert.deepEqual(
        {
          symbolDiffs: result.symbolDiffs,
          importDiffs: result.importDiffs,
          callDiffs: result.callDiffs,
          testCaseIdentityDiffs: result.testCaseIdentityDiffs,
        },
        {
          symbolDiffs: [],
          importDiffs: [],
          callDiffs: [],
          testCaseIdentityDiffs: [],
        },
        `Engine parity mismatch for ${label} (${diffCount} diff(s)). Set SDL_PARITY_HARNESS_BASELINE=1 to log without failing.`,
      );
    });
  }
});


it("preserves attached Python test identity across parity engines", async () => {
  loadBuiltInAdapters();
  const fixture = resolve(
    FIXTURES_ROOT,
    "semantic-test-cases",
    "test_sample.py",
  );
  const content = readFileSync(fixture, "utf8");
  const adapter = getAdapterForExtension(".py");
  assert.ok(adapter?.detectTestCases);
  const tree = adapter.parse(content, fixture);
  assert.ok(tree);
  const relPath = "tests/fixtures/semantic-test-cases/test_sample.py";
  const fileMeta = {
    path: relPath,
    size: Buffer.byteLength(content, "utf8"),
    mtime: Date.now(),
  };
  const rawSymbols = adapter.extractSymbols(tree, content, fixture);
  const rawCalls = adapter.extractCalls(tree, content, fixture, rawSymbols);
  const rawDetail = buildSymbolDetails({
    symbolsWithNodeIds: rawSymbols,
    tree,
    repoId: "parity-harness",
    fileMeta,
  }).find((detail) => detail.extractedSymbol.name === "test_named_case");
  assert.ok(rawDetail);

  const normalized = applyTestCaseCandidates({
    relPath,
    symbols: rawSymbols,
    calls: rawCalls,
    candidates: adapter.detectTestCases({
      tree,
      content,
      filePath: fixture,
      symbols: rawSymbols,
    }),
  });
  const attached = buildSymbolDetails({
    symbolsWithNodeIds: normalized.symbols,
    tree,
    repoId: "parity-harness",
    fileMeta,
  }).filter((detail) => detail.extractedSymbol.testCase !== undefined);
  assert.equal(attached.length, 1);
  assert.equal(
    serializeTestCaseFacet(attached[0]!.extractedSymbol.testCase!),
    '{"framework":"pytest","title":"test_named_case"}',
  );
  assert.equal(attached[0]!.symbolId, rawDetail.symbolId);

  const result = await runEngineParityCheck(fixture, REPO_ROOT);
  if (result.skipped === "native-addon-unavailable") return;
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.testCaseIdentityDiffs, []);
});

it("emits exact semantic case projections across indexing pipelines", async () => {
  loadBuiltInAdapters();
  const fixture = resolve(
    FIXTURES_ROOT,
    "semantic-test-cases",
    "sample.test.ts",
  );
  const content = readFileSync(fixture, "utf8");
  const adapter = getAdapterForExtension(".ts");
  assert.ok(adapter?.detectTestCases);
  const tree = adapter.parse(content, fixture);
  assert.ok(tree);
  const rawSymbols = adapter.extractSymbols(tree, content, fixture);
  const rawImports = adapter.extractImports(tree, content, fixture);
  const rawCalls = adapter.extractCalls(tree, content, fixture, rawSymbols);
  const repoId = "semantic-pipeline-parity";
  const relPath = "src/embedded-cases.ts";
  const contentHash = "1".repeat(64);
  const fileMeta = {
    path: relPath,
    size: Buffer.byteLength(content, "utf8"),
    mtime: Date.now(),
    contentHash,
  };
  const base = {
    filePath: fixture,
    fileMeta,
    content,
    extWithDot: ".ts",
    adapter,
    repoId,
    relPath,
    contentHash,
    fileId: `${repoId}:${relPath}`,
  };
  const workerPool = {
    parse: async () => ({
      symbols: rawSymbols.map((symbol) => ({
        ...symbol,
        astFingerprint: "",
      })),
      imports: rawImports,
      calls: rawCalls,
    }),
  } as unknown as ParserWorkerPool;
  const [sync, worker] = await Promise.all([
    parseAndExtract(base),
    parseAndExtract({ ...base, workerPool }),
  ]);
  assert.equal(sync.status, "parsed");
  assert.equal(worker.status, "parsed");
  if (sync.status !== "parsed" || worker.status !== "parsed") return;

  type SemanticProjection = {
    order: number;
    testCaseJson: string;
    symbolId: string;
    range: [number, number, number, number];
    astFingerprint: string;
  };
  const projectParsed = (data: typeof sync.data): SemanticProjection[] =>
    buildSymbolDetails({
      symbolsWithNodeIds: data.symbolsWithNodeIds,
      tree: data.tree,
      repoId,
      fileMeta,
    })
      .flatMap((detail): SemanticProjection[] => {
        const testCaseJson = detail.extractedSymbol.testCase
          ? serializeTestCaseFacet(detail.extractedSymbol.testCase)
          : null;
        if (!testCaseJson) return [];
        return [
          {
            order: 0,
            testCaseJson,
            symbolId: detail.symbolId,
            range: [
              detail.extractedSymbol.range.startLine,
              detail.extractedSymbol.range.startCol,
              detail.extractedSymbol.range.endLine,
              detail.extractedSymbol.range.endCol,
            ],
            astFingerprint: detail.astFingerprint,
          },
        ];
      })
      .map((projection, order) => ({ ...projection, order }));
  const projectRows = (rows: readonly SymbolRow[]): SemanticProjection[] =>
    rows
      .filter(
        (row): row is SymbolRow & { testCaseJson: string } =>
          row.testCaseJson !== null,
      )
      .map((row, order) => ({
        order,
        testCaseJson: row.testCaseJson,
        symbolId: row.symbolId,
        range: [
          row.rangeStartLine,
          row.rangeStartCol,
          row.rangeEndLine,
          row.rangeEndCol,
        ],
        astFingerprint: row.astFingerprint,
      }));

  const nativeRoot = mkdtempSync(join(tmpdir(), "sdl-semantic-parity-"));
  await initLadybugDb(join(nativeRoot, "graph.lbug"));
  const conn = await getLadybugConn();
  const indexedAt = "2026-08-07T00:00:00.000Z";
  await ladybugDb.upsertRepo(conn, {
    repoId,
    rootPath: REPO_ROOT,
    configJson: JSON.stringify({ repoId, rootPath: REPO_ROOT, languages: ["ts"] }),
    createdAt: indexedAt,
  });
  await ladybugDb.createVersion(conn, {
    versionId: "v1",
    repoId,
    createdAt: indexedAt,
    reason: "engine parity baseline",
    prevVersionHash: null,
    versionHash: null,
  });
  await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
    files: [],
    fileless: [],
  });
  const baseline = await capturePersistedGraphIntegrity(conn, repoId);
  const coverageDigest =
    await ladybugDb.verifyExactParserCoverageInTransaction(conn, repoId);
  await ladybugDb.upsertRepoParserStateInTransaction(conn, {
    repoId,
    coverageState: "complete",
    graphVersionId: "v1",
    graphRevision: 0,
    coverageDigest,
  });
  await markGraphIntegrityVerified(repoId, "v1", baseline.digest);
  const draft = await parseDraftFile({
    repoId,
    repoRoot: REPO_ROOT,
    filePath: relPath,
    content,
    languages: ["ts"],
    language: "typescript",
    version: 1,
  });
  const candidates = adapter.detectTestCases({
    tree,
    content,
    filePath: relPath,
    symbols: rawSymbols,
  });
  const emittedAt = "2026-07-29T00:00:00.000Z";
  const providerBase = {
    repoId,
    generationId: "gen-semantic-parity",
    providerType: "scip" as const,
    providerId: "scip-typescript",
    providerVersion: "1.0.0",
    emittedAt,
  };
  const providerFacts: ProviderFactSet = {
    files: [
      {
        ...providerBase,
        kind: "file",
        fileId: `${repoId}:${relPath}`,
        relPath,
        languageId: "typescript",
        contentHash,
        byteSize: Buffer.byteLength(content, "utf8"),
      },
    ],
    symbols: [],
    occurrences: [],
    edges: [],
    externalSymbols: [],
    diagnostics: [],
    coverage: [],
    providerRuns: [],
  };
  const providerRows = providerFactsToGraphRows({
    facts: providerFacts,
    indexedAt: emittedAt,
    testCaseCandidatesByPath: new Map([[relPath, candidates]]),
  });

  const nativeRows: SymbolRow[] = [];
  class CapturingAccumulator extends BatchPersistAccumulator {
    override addSymbols(rows: SymbolRow[]): void {
      nativeRows.push(...rows);
      super.addSymbols(rows);
    }
  }
  try {
    await processFileFromRustResult({
      repoId,
      repoRoot: nativeRoot,
      fileMeta,
      rustResult: {
        relPath,
        contentHash,
        content,
        symbols: rawSymbols.map((symbol, index) => ({
          ...symbol,
          symbolId: `${repoId}:native:${index}`,
          astFingerprint: `native-${index}`,
          summary: "",
          invariantsJson: "[]",
          sideEffectsJson: "[]",
          roleTagsJson: "[]",
          decorators: [],
          searchText: symbol.name,
        })),
        imports: rawImports,
        calls: rawCalls,
        parseError: null,
      },
      languages: ["ts"],
      mode: "full",
      symbolIndex: new Map(),
      pendingCallEdges: [],
      createdCallEdges: new Set(),
      tsResolver: null,
      config: RepoConfigSchema.parse({
        repoId,
        rootPath: nativeRoot,
        languages: ["ts"],
      }),
      allSymbolsByName: new Map(),
      skipCallResolution: true,
      batchAccumulator: new CapturingAccumulator(10_000, {
        autoDrain: false,
      }),
    });
  } finally {
    await closeLadybugDb().catch(() => {});
    rmSync(nativeRoot, { recursive: true, force: true });
  }

  const syncProjection = projectParsed(sync.data);
  const projections = {
    sync: syncProjection,
    worker: projectParsed(worker.data),
    native: projectRows(nativeRows),
    draft: projectRows(draft.symbols),
    provider: projectRows(providerRows.symbols),
  };
  const projectSemantics = ({
    order,
    range,
    testCaseJson,
  }: SemanticProjection) => ({ order, range, testCaseJson });
  const expectedSemantics = syncProjection.map(projectSemantics);
  assert.deepEqual(
    expectedSemantics,
    [
      {
        order: 0,
        range: [13, 2, 21, 4],
        testCaseJson:
          '{"framework":"jest","title":"duplicate case","suitePath":["outer suite"]}',
      },
      {
        order: 1,
        range: [23, 2, 25, 4],
        testCaseJson:
          '{"framework":"jest","title":"duplicate case","suitePath":["outer suite"]}',
      },
    ],
  );
  for (const [pipeline, projection] of Object.entries(projections)) {
    assert.deepEqual(
      projection.map(projectSemantics),
      expectedSemantics,
      `${pipeline} semantic projection diverged from sync`,
    );
    assert.ok(
      projection.every(
        (item) =>
          item.symbolId.length > 0 && item.astFingerprint.length > 0,
      ),
    );
    assert.notEqual(projection[0]?.symbolId, projection[1]?.symbolId);
  }
});
