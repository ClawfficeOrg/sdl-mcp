import assert from "node:assert/strict";
import { it } from "node:test";

import type { Connection } from "kuzu";
import type { ContextCandidateFusionItem } from "../../src/retrieval/fusion.js";

it("stable-partitions candidate rows into pins, focused rows, and the remainder", async () => {
  const { prioritizeContextCandidateRowsByFocus } = await import(
    "../../dist/retrieval/context-candidate-search.js"
  );
  const makeRow = (
    symbolId: string,
    filePath: string,
    tier: 0 | 1,
    rank: number,
  ) => {
    const sourceRanks = { fts: rank };
    const provenance = { symbol: { fts: rank } };
    return {
      symbolId,
      filePath,
      score: 100 - rank,
      source: "fts" as const,
      tier,
      sourceRanks,
      provenance,
    };
  };
  const outsideOne = makeRow("outside-one", "src/outside-one.ts", 1, 1);
  const pinnedOne = makeRow("pinned-one", "src/pinned-one.ts", 0, 2);
  const insideOne = makeRow("inside-one", "tests/inside-one.ts", 1, 3);
  const pinnedTwo = makeRow("pinned-two", "tests/pinned-two.ts", 0, 4);
  const insideTwo = makeRow("inside-two", "tests/inside-two.ts", 1, 5);
  const outsideTwo = makeRow("outside-two", "src/outside-two.ts", 1, 6);
  const rows = [
    outsideOne,
    pinnedOne,
    insideOne,
    pinnedTwo,
    insideTwo,
    outsideTwo,
  ];

  const result = prioritizeContextCandidateRowsByFocus(rows, ["tests"]);

  assert.deepEqual(
    result.map((row) => row.symbolId),
    [
      "pinned-one",
      "pinned-two",
      "inside-one",
      "inside-two",
      "outside-one",
      "outside-two",
    ],
  );
  assert.equal(result.length, rows.length);
  for (const row of rows) {
    const reordered = result.find(
      (candidate) => candidate.symbolId === row.symbolId,
    );
    assert.strictEqual(reordered, row);
    assert.equal(reordered?.score, row.score);
    assert.strictEqual(reordered?.sourceRanks, row.sourceRanks);
    assert.strictEqual(reordered?.provenance, row.provenance);
  }
});

it("treats focus prefixes as a path-boundary union and preserves empty focus order", async () => {
  const { prioritizeContextCandidateRowsByFocus } = await import(
    "../../dist/retrieval/context-candidate-search.js"
  );
  const makeRow = (symbolId: string, filePath: string) => ({
    symbolId,
    filePath,
    score: 1,
    source: "fts" as const,
    tier: 1 as const,
    sourceRanks: { fts: 1 },
    provenance: { symbol: { fts: 1 } },
  });
  const testsOther = makeRow("tests-other", "tests-other/unit.ts");
  const source = makeRow("source", "src/source.ts");
  const testsExact = makeRow("tests-exact", "tests");
  const testsNested = makeRow("tests-nested", "tests/unit/nested.ts");
  const docs = makeRow("docs", "docs/readme.ts");
  const rows = [testsOther, source, testsExact, testsNested, docs];

  const union = prioritizeContextCandidateRowsByFocus(rows, ["tests", "src"]);
  assert.deepEqual(
    union.map((row) => row.symbolId),
    ["source", "tests-exact", "tests-nested", "tests-other", "docs"],
  );

  const unchanged = prioritizeContextCandidateRowsByFocus(rows, []);
  assert.equal(JSON.stringify(unchanged), JSON.stringify(rows));
  unchanged.forEach((row, index) => assert.strictEqual(row, rows[index]));
});

it("logs and keeps unboosted candidates when context PPR fails", async (t) => {
  const seedResolver = await import("../../dist/retrieval/seed-resolver.js");
  const { logger } = await import("../../dist/util/logger.js");
  const injectedError = new Error("injected PPR seed failure");
  let logged:
    | { message: string; meta?: Record<string, unknown> }
    | undefined;
  const originalDebug = logger.debug;
  logger.debug = (message, meta) => {
    logged = { message, meta };
  };
  t.mock.module("../../dist/retrieval/seed-resolver.js", {
    namedExports: {
      ...seedResolver,
      resolveSeedSymbols: async () => {
        throw injectedError;
      },
    },
  });

  try {
    const { applyContextPpr } = await import(
      "../../dist/retrieval/context-candidate-search.js?ppr-fallback"
    );
    const candidates = [];
    const result = await applyContextPpr(
      {} as Connection,
      {
        repoId: "repo",
        query: "query",
        limit: 1,
        includeFileSummary: false,
        includeTests: true,
        symbolsPerFileSummary: 1,
        chatMentions: ["Seed"],
      },
      candidates,
    );

    assert.strictEqual(result, candidates);
    assert.equal(
      logged?.message,
      "Context PPR boost failed; using unboosted candidates",
    );
    assert.equal(logged?.meta?.repoId, "repo");
    assert.strictEqual(logged?.meta?.error, injectedError);
  } finally {
    logger.debug = originalDebug;
  }
});

it("keeps fused ordering when cached graph provenance differs from Context", async (t) => {
  const seedResolver = await import("../../dist/retrieval/seed-resolver.js");
  const graphSnapshots = await import(
    "../../dist/graph/graphSnapshotCache.js"
  );
  const ppr = await import("../../dist/retrieval/ppr.js");
  const requestedVersions: Array<string | undefined> = [];
  const loadedVersions: Array<string | undefined> = [];

  t.mock.module("../../dist/retrieval/seed-resolver.js", {
    namedExports: {
      ...seedResolver,
      resolveSeedSymbols: async () => ({
        seeds: new Map([["seed", 1]]),
        evidence: { resolved: ["seed"], unresolved: [], ambiguous: [] },
      }),
    },
  });
  t.mock.module("../../dist/graph/graphSnapshotCache.js", {
    namedExports: {
      ...graphSnapshots,
      getGraphSnapshot: (_repoId: string, graphVersionId?: string) => {
        requestedVersions.push(graphVersionId);
        return graphVersionId === "v2" ? null : {};
      },
      loadAndCacheGraphSnapshot: async (
        _conn: Connection,
        _repoId: string,
        graphVersionId?: string,
      ) => {
        loadedVersions.push(graphVersionId);
        return null;
      },
      getGraphSnapshotCreatedAt: () => 1,
    },
  });
  t.mock.module("../../dist/retrieval/ppr.js", {
    namedExports: {
      ...ppr,
      computePpr: async () => ({ scores: new Map<string, number>() }),
      applyPprBoost: (
        items: Array<{ symbolId: string; score: number }>,
      ) => ({
        items: [...items].reverse(),
      }),
    },
  });

  const { applyContextPpr } = await import(
    "../../dist/retrieval/context-candidate-search.js?ppr-version-provenance"
  );
  const candidates: ContextCandidateFusionItem[] = [
    {
      symbolId: "first",
      score: 2,
      source: "fts",
      sourceRanks: { fts: 1 },
      provenance: { symbol: { fts: 1 } },
    },
    {
      symbolId: "second",
      score: 1,
      source: "fts",
      sourceRanks: { fts: 2 },
      provenance: { symbol: { fts: 2 } },
    },
  ];

  const result = await applyContextPpr(
    {} as Connection,
    {
      repoId: "repo",
      graphVersionId: "v2",
      query: "query",
      limit: 2,
      includeFileSummary: false,
      includeTests: true,
      symbolsPerFileSummary: 1,
      chatMentions: ["Seed"],
    },
    candidates,
  );

  assert.deepStrictEqual(result, candidates);
  assert.deepStrictEqual(requestedVersions, ["v2"]);
  assert.deepStrictEqual(loadedVersions, ["v2"]);
});

it("keeps an overlay-only exact focus symbol pinned at Tier 0", async (t) => {
  const orchestrator = await import("../../dist/retrieval/orchestrator.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const symbol = {
    symbolId: "overlay-focus",
    repoId: "repo",
    fileId: "overlay-file",
    kind: "function",
    name: "OverlayFocus",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: "overlay-fingerprint",
    signatureJson: null,
    summary: "Captured overlay focus",
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: "OverlayFocus captured overlay focus",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  const file = {
    fileId: "overlay-file",
    repoId: "repo",
    relPath: "src/overlay-focus.ts",
    contentHash: "overlay-hash",
    language: "typescript",
    byteSize: 64,
    lastIndexedAt: null,
    directory: "src",
  };

  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      ...orchestrator,
      collectEntitySourceRankings: async () => ({
        conn: {} as Connection,
        rankings: [],
        capabilities: {
          fts: false,
          fileSummaryFts: false,
          vectorNomic: false,
          vectorJinaCode: false,
          coveragePermille: {
            symbolVector: 0,
            fileSummaryVector: 0,
          },
        },
        rrfK: 60,
        limit: 10,
        config: {
          fusion: {
            weights: {
              fts: 1,
              vector: 1,
              overlay: 1,
            },
          },
        },
        fusionLatencyMs: 0,
      }),
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...ladybugQueries,
      getSearchableSymbolsByIds: async () => new Map(),
      getFilesByIds: async () => new Map(),
      getSymbolsByFile: async () => [],
    },
  });

  const { searchContextCandidates } = await import(
    "../../dist/retrieval/context-candidate-search.js?overlay-exact-focus"
  );
  const result = await searchContextCandidates(
    {} as Connection,
    {
      repoId: "repo",
      query: "unrelated task text",
      limit: 10,
      includeFileSummary: false,
      includeTests: true,
      symbolsPerFileSummary: 1,
      pinnedSymbolIds: [symbol.symbolId],
      exactIdentifierSymbolIds: [symbol.symbolId],
    },
    {
      connection: {} as Connection,
      laneOutcomes: new Map(),
      healthPromises: new Map(),
      embeddingPromises: new Map(),
    },
    {
      repoId: "repo",
      touchedFileIds: new Set([file.fileId]),
      symbolsById: new Map([[symbol.symbolId, symbol]]),
      filesById: new Map([[file.fileId, file]]),
      outgoingEdgesBySymbolId: new Map(),
      contentByFileId: new Map([
        [file.fileId, "export function OverlayFocus() {}"],
      ]),
    },
  );

  assert.deepEqual(
    result.rows.map(({ symbolId, filePath, tier }) => ({
      symbolId,
      filePath,
      tier,
    })),
    [
      {
        symbolId: "overlay-focus",
        filePath: "src/overlay-focus.ts",
        tier: 0,
      },
    ],
  );
});

it("bounds FileSummary symbol materialization before candidate mapping", async (t) => {
  const orchestrator = await import("../../dist/retrieval/orchestrator.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const fileQueryBatches: string[][] = [];
  const symbolQueryLimits: Array<[fileId: string, limit: number | undefined]> =
    [];
  const makeFile = (fileId: string) => ({
    fileId,
    repoId: "repo",
    relPath: `src/${fileId}.ts`,
    contentHash: `hash-${fileId}`,
    language: "typescript",
    byteSize: 64,
    lastIndexedAt: null,
    directory: "src",
  });
  const makeSymbol = (fileId: string) => ({
    symbolId: `symbol-${fileId}`,
    repoId: "repo",
    fileId,
    kind: "function",
    name: `Symbol${fileId}`,
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: `fingerprint-${fileId}`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: `Symbol ${fileId}`,
    updatedAt: "2026-07-27T00:00:00.000Z",
  });

  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      ...orchestrator,
      collectEntitySourceRankings: async () => ({
        conn: {} as Connection,
        rankings: [
          {
            source: "fts",
            entityType: "fileSummary",
            ranks: new Map([
              ["file-b", 1],
              ["file-d", 2],
              ["file-f", 3],
              ["file-h", 4],
            ]),
            candidateCount: 4,
          },
          {
            source: "vector:nomic",
            entityType: "fileSummary",
            ranks: new Map([
              ["file-a", 1],
              ["file-c", 2],
              ["file-e", 3],
              ["file-g", 4],
            ]),
            candidateCount: 4,
          },
        ],
        capabilities: {
          fts: false,
          fileSummaryFts: true,
          vectorNomic: true,
          vectorJinaCode: false,
          coveragePermille: {
            symbolVector: 0,
            fileSummaryVector: 1_000,
          },
        },
        rrfK: 60,
        limit: 2,
        config: {
          fusion: {
            weights: {
              fts: 1,
              vector: 1,
              overlay: 1,
            },
          },
        },
        fusionLatencyMs: 0,
      }),
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...ladybugQueries,
      getSearchableSymbolsByIds: async () => new Map(),
      getFilesByIds: async (_conn: Connection, fileIds: string[]) => {
        fileQueryBatches.push([...fileIds]);
        return new Map(fileIds.map((fileId) => [fileId, makeFile(fileId)]));
      },
      getSymbolsByFile: async (
        _conn: Connection,
        fileId: string,
        limit?: number,
      ) => {
        symbolQueryLimits.push([fileId, limit]);
        return [makeSymbol(fileId)];
      },
    },
  });

  const { searchContextCandidates } = await import(
    "../../dist/retrieval/context-candidate-search.js?filesummary-db-bound"
  );
  await searchContextCandidates(
    {} as Connection,
    {
      repoId: "repo",
      query: "bounded file summary symbols",
      limit: 2,
      includeFileSummary: true,
      includeTests: true,
      symbolsPerFileSummary: 1,
    },
    {
      connection: {} as Connection,
      laneOutcomes: new Map(),
      healthPromises: new Map(),
      embeddingPromises: new Map(),
    },
    {
      repoId: "repo",
      touchedFileIds: new Set(),
      symbolsById: new Map(),
      filesById: new Map(),
      outgoingEdgesBySymbolId: new Map(),
      contentByFileId: new Map(),
    },
  );

  const candidateFileBatch = fileQueryBatches.find((batch) => batch.length > 0);
  assert.deepEqual(candidateFileBatch, [
    "file-a",
    "file-b",
    "file-c",
    "file-d",
  ]);
  assert.deepEqual(symbolQueryLimits, [
    ["file-a", 1],
    ["file-b", 1],
    ["file-c", 1],
    ["file-d", 1],
  ]);
});

it("reports source positions from the focus-partitioned candidate order", async (t) => {
  const orchestrator = await import("../../dist/retrieval/orchestrator.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const fusion = await import("../../dist/retrieval/fusion.js");
  const fused: ContextCandidateFusionItem[] = [
    {
      symbolId: "outside-one",
      score: 4,
      source: "fts",
      sourceRanks: { fts: 1 },
      provenance: { symbol: { fts: 1 } },
    },
    {
      symbolId: "inside-two",
      score: 3,
      source: "vector:nomic",
      sourceRanks: { "vector:nomic": 1 },
      provenance: { symbol: { "vector:nomic": 1 } },
    },
    {
      symbolId: "inside-one",
      score: 2,
      source: "fts",
      sourceRanks: { fts: 2 },
      provenance: { symbol: { fts: 2 } },
    },
    {
      symbolId: "outside-two",
      score: 1,
      source: "vector:nomic",
      sourceRanks: { "vector:nomic": 2 },
      provenance: { symbol: { "vector:nomic": 2 } },
    },
  ];
  const filePaths = new Map([
    ["outside-one", "src/outside-one.ts"],
    ["inside-two", "focused/inside-two.ts"],
    ["inside-one", "focused/inside-one.ts"],
    ["outside-two", "src/outside-two.ts"],
  ]);

  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      ...orchestrator,
      collectEntitySourceRankings: async () => ({
        conn: {} as Connection,
        rankings: [
          {
            source: "fts",
            entityType: "symbol",
            ranks: new Map([
              ["outside-one", 1],
              ["inside-one", 2],
            ]),
            candidateCount: 2,
          },
          {
            source: "vector:nomic",
            entityType: "symbol",
            ranks: new Map([
              ["inside-two", 1],
              ["outside-two", 2],
            ]),
            candidateCount: 2,
          },
        ],
        capabilities: {
          fts: true,
          fileSummaryFts: false,
          vectorNomic: true,
          vectorJinaCode: false,
          coveragePermille: {
            symbolVector: 1_000,
            fileSummaryVector: 0,
          },
        },
        rrfK: 60,
        limit: 4,
        config: {
          fusion: {
            weights: {
              fts: 1,
              vector: 1,
              overlay: 1,
            },
          },
        },
        fusionLatencyMs: 0,
      }),
    },
  });
  t.mock.module("../../dist/retrieval/fusion.js", {
    namedExports: {
      ...fusion,
      rrfFuseContextCandidates: () => fused,
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...ladybugQueries,
      getSearchableSymbolsByIds: async () =>
        new Map(
          [...filePaths].map(([symbolId]) => [
            symbolId,
            { symbolId, fileId: `file-${symbolId}` },
          ]),
        ),
      getFilesByIds: async (_conn: Connection, fileIds: string[]) =>
        new Map(
          fileIds.map((fileId) => {
            const symbolId = fileId.replace(/^file-/, "");
            return [
              fileId,
              { fileId, relPath: filePaths.get(symbolId) as string },
            ];
          }),
        ),
    },
  });

  const { searchContextCandidates } = await import(
    "../../dist/retrieval/context-candidate-search.js?focus-evidence-order"
  );
  const result = await searchContextCandidates(
    {} as Connection,
    {
      repoId: "repo",
      query: "focus candidate ordering",
      limit: 4,
      includeFileSummary: false,
      includeTests: true,
      symbolsPerFileSummary: 1,
      includeEvidence: true,
      focusPathPrefixes: ["focused"],
    },
    {
      connection: {} as Connection,
      laneOutcomes: new Map(),
      healthPromises: new Map(),
      embeddingPromises: new Map(),
    },
    {
      repoId: "repo",
      touchedFileIds: new Set(),
      symbolsById: new Map(),
      filesById: new Map(),
      outgoingEdgesBySymbolId: new Map(),
      contentByFileId: new Map(),
    },
  );

  assert.deepEqual(
    result.rows.map((row) => row.symbolId),
    ["inside-two", "inside-one", "outside-one", "outside-two"],
  );
  assert.deepEqual(result.evidence?.topRanksPerSource, {
    fts: [2, 3],
    "vector:nomic": [1, 4],
  });
});
