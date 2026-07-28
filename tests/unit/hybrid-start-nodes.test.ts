import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";

const resolverSource = readFileSync(
  new URL("../../src/graph/slice/start-node-resolver.ts", import.meta.url),
  "utf8",
);

const emptyOverlaySnapshot = {
  repoId: "repo",
  touchedFileIds: new Set<string>(),
  symbolsById: new Map(),
  filesById: new Map(),
  outgoingEdgesBySymbolId: new Map(),
};

function mockStartNodeModules(
  t: TestContext,
  options: {
    searchContextCandidates: (...args: unknown[]) => Promise<unknown>;
    ladybug?: Record<string, unknown>;
  },
): void {
  t.mock.module("../../dist/retrieval/context-candidate-search.js", {
    namedExports: {
      searchContextCandidates: options.searchContextCandidates,
    },
  });
  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      createRetrievalQueryContext: () => ({
        healthPromises: new Map(),
        embeddingPromises: new Map(),
      }),
      hybridSearch: async () => ({ results: [] }),
    },
  });
  t.mock.module("../../dist/live-index/overlay-reader.js", {
    namedExports: {
      getOverlaySnapshot: () => emptyOverlaySnapshot,
      rankOverlaySymbolsForQuery: () => [],
    },
  });
  t.mock.module("../../dist/retrieval/feedback-boost.js", {
    namedExports: {
      queryFeedbackBoosts: async () => ({ boosts: new Map() }),
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      getSymbolsByIds: async () => new Map(),
      getFilesByIds: async () => new Map(),
      getFileByRepoPath: async () => null,
      getSymbolIdsByFile: async () => [],
      getCallersOfSymbols: async () => [],
      searchSymbolsLiteBatch: async () => [],
      ...options.ladybug,
    },
  });
}

describe("start-node resolver unified retrieval", () => {
  it("routes task text through the shared candidate core", () => {
    assert.match(resolverSource, /searchContextCandidates\(/);
    assert.doesNotMatch(resolverSource, /isHybridRetrievalAvailable/);
    assert.doesNotMatch(resolverSource, /shouldFallbackToLegacy/);
    assert.doesNotMatch(resolverSource, /from "\.\.\/\.\.\/retrieval\/fallback\.js"/);
  });

  it("retains slice-owned exact recovery sources", () => {
    assert.match(resolverSource, /extractSymbolsFromStackTraceLadybug\(/);
    assert.match(resolverSource, /getSymbolsByPathLadybug\(/);
    assert.match(resolverSource, /searchSymbolsLiteBatch\(/);
  });

  it("preserves retrieval evidence for slice responses", () => {
    assert.match(resolverSource, /retrievalEvidence = sharedResult\.evidence/);
    assert.match(resolverSource, /hybridSearchItems = sharedResult\.rows/);
  });

  it("uses the admitted connection for shared task-text candidates", async (t) => {
    const conn = { id: "admitted" };
    const queryContext: { connection?: unknown } = {};
    let receivedConn: unknown;
    let receivedQueryContext: { connection?: unknown } | undefined;

    mockStartNodeModules(t, {
      searchContextCandidates: async (
        candidateConn,
        _options,
        candidateQueryContext,
      ) => {
        receivedConn = candidateConn;
        receivedQueryContext = candidateQueryContext as {
          connection?: unknown;
        };
        return {
          rows: [
            {
              symbolId: "shared-symbol",
              filePath: "src/shared.ts",
              score: 1,
              source: "fts",
              tier: 1,
              sourceRanks: { fts: 1 },
              provenance: {},
            },
          ],
          capabilities: {},
          evidence: {
            sources: ["fts"],
            candidateCountPerSource: { fts: 1 },
            topRanksPerSource: { fts: [1] },
            fusionLatencyMs: 0,
          },
        };
      },
    });

    const { resolveStartNodesLadybug } = await import(
      "../../dist/graph/slice/start-node-resolver.js?shared-connection"
    );
    const result = await resolveStartNodesLadybug(
      conn as never,
      "repo",
      { taskText: "shared symbol" },
      queryContext as never,
      emptyOverlaySnapshot as never,
    );

    assert.strictEqual(receivedConn, conn);
    assert.strictEqual(receivedQueryContext, queryContext);
    assert.strictEqual(queryContext.connection, conn);
    assert.deepEqual(result.startNodes, [
      { symbolId: "shared-symbol", source: "taskText" },
    ]);
  });

  it("retains raw task-text recovery alongside structural seeds", async (t) => {
    const conn = { id: "admitted" };
    const queryContext: { connection?: unknown } = {};
    let lexicalCalls = 0;

    mockStartNodeModules(t, {
      searchContextCandidates: async () => ({
        rows: [],
        capabilities: {},
        evidence: {
          sources: [],
          candidateCountPerSource: {},
          topRanksPerSource: {},
          fusionLatencyMs: 0,
          fallbackReason: "all-backends-returned-empty",
        },
      }),
      ladybug: {
        getFileByRepoPath: async () => ({
          fileId: "edited-file",
          repoId: "repo",
          relPath: "src/edited.ts",
        }),
        getSymbolIdsByFile: async () => ["edited-symbol"],
        getCallersOfSymbols: async () => [],
        searchSymbolsLiteBatch: async (
          _conn: unknown,
          _repoId: string,
          words: string[],
        ) => {
          lexicalCalls += 1;
          return words.map((_, index) =>
            index === 0
              ? [{ symbolId: "lexical-symbol", fileId: "lexical-file" }]
              : [],
          );
        },
        getSymbolsByIds: async () =>
          new Map([
            [
              "edited-symbol",
              {
                symbolId: "edited-symbol",
                fileId: "edited-file",
                name: "EditedSymbol",
                kind: "function",
                exported: true,
              },
            ],
            [
              "lexical-symbol",
              {
                symbolId: "lexical-symbol",
                fileId: "lexical-file",
                name: "DurableKeyword",
                kind: "function",
                exported: true,
              },
            ],
          ]),
        getFilesByIds: async () =>
          new Map([
            [
              "edited-file",
              { fileId: "edited-file", relPath: "src/edited.ts" },
            ],
            [
              "lexical-file",
              { fileId: "lexical-file", relPath: "src/durable.ts" },
            ],
          ]),
      },
    });

    const { resolveStartNodesLadybug } = await import(
      "../../dist/graph/slice/start-node-resolver.js?mixed-recovery"
    );
    const result = await resolveStartNodesLadybug(
      conn as never,
      "repo",
      {
        editedFiles: ["src/edited.ts"],
        taskText: "durable keyword",
      },
      queryContext as never,
      emptyOverlaySnapshot as never,
    );

    assert.equal(lexicalCalls, 1);
    assert.strictEqual(queryContext.connection, conn);
    assert.deepEqual(result.startNodes, [
      { symbolId: "edited-symbol", source: "editedFile" },
      { symbolId: "lexical-symbol", source: "taskText" },
    ]);
  });

  it("does not run raw recovery when a shared row duplicates a structural seed", async (t) => {
    let lexicalCalls = 0;
    mockStartNodeModules(t, {
      searchContextCandidates: async () => ({
        rows: [
          {
            symbolId: "edited-symbol",
            filePath: "src/edited.ts",
            score: 1,
            source: "fts",
            tier: 1,
            sourceRanks: { fts: 1 },
            provenance: {},
          },
        ],
        capabilities: {},
      }),
      ladybug: {
        getFileByRepoPath: async () => ({
          fileId: "edited-file",
          repoId: "repo",
          relPath: "src/edited.ts",
        }),
        getSymbolIdsByFile: async () => ["edited-symbol"],
        getCallersOfSymbols: async () => [],
        searchSymbolsLiteBatch: async () => {
          lexicalCalls += 1;
          return [];
        },
      },
    });

    const { resolveStartNodesLadybug } = await import(
      "../../dist/graph/slice/start-node-resolver.js?duplicate-structural"
    );
    const result = await resolveStartNodesLadybug(
      {} as never,
      "repo",
      {
        editedFiles: ["src/edited.ts"],
        taskText: "edited symbol",
      },
      {} as never,
      emptyOverlaySnapshot as never,
    );

    assert.equal(lexicalCalls, 0);
    assert.deepEqual(result.startNodes, [
      { symbolId: "edited-symbol", source: "editedFile" },
    ]);
  });

  it("does not turn shared retrieval admission errors into lexical fallback", async (t) => {
    const { IndexError } = await import("../../dist/domain/errors.js");
    let lexicalCalls = 0;

    mockStartNodeModules(t, {
      searchContextCandidates: async () => {
        throw new IndexError("graph retrieval rejected");
      },
      ladybug: {
        searchSymbolsLiteBatch: async () => {
          lexicalCalls += 1;
          return [];
        },
      },
    });

    const { resolveStartNodesLadybug } = await import(
      "../../dist/graph/slice/start-node-resolver.js?admission-error"
    );
    await assert.rejects(
      () =>
        resolveStartNodesLadybug(
          {} as never,
          "repo",
          { taskText: "durable keyword" },
          {} as never,
          emptyOverlaySnapshot as never,
        ),
      (error: unknown) => error instanceof IndexError,
    );
    assert.equal(lexicalCalls, 0);
  });
});
