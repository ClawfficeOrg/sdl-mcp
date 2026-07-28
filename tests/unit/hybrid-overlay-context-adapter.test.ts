import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("preserves overlay context and provenance through the hybrid adapter", async (t) => {
  const orchestrator = await import("../../dist/retrieval/orchestrator.js");
  const coordinator = await import("../../dist/live-index/coordinator.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const embeddingCache = await import(
    "../../dist/live-index/overlay-embedding-cache.js"
  );
  const queryContext = orchestrator.createRetrievalQueryContext();
  let receivedContext: unknown;

  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      ...orchestrator,
      hybridSearch: async (_options: unknown, context: unknown) => {
        receivedContext = context;
        return {
          results: [],
          evidence: {
            sources: ["fts"],
            topRanksPerSource: { fts: [] },
            candidateCountPerSource: { fts: 0 },
          },
        };
      },
    },
  });
  t.mock.module("../../dist/live-index/coordinator.js", {
    namedExports: {
      ...coordinator,
      getDefaultOverlayStore: () => ({
        getSnapshotVersion: () => 1,
        listDrafts: () => [
          {
            content: "export function NeedOverlay() {}",
            parseResult: {
              file: {
                fileId: "overlay-file",
                repoId: "repo",
                relPath: "src/draft.ts",
              },
              symbols: [
                {
                  symbolId: "overlay-symbol",
                  repoId: "repo",
                  fileId: "overlay-file",
                  name: "NeedOverlay",
                  kind: "function",
                  exported: true,
                  summary: "NeedOverlay draft symbol",
                  searchText: "NeedOverlay draft symbol",
                },
              ],
              edges: [],
            },
          },
        ],
      }),
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: { ...ladybugQueries },
  });
  t.mock.module("../../dist/live-index/overlay-embedding-cache.js", {
    namedExports: {
      ...embeddingCache,
      getOverlayEmbeddingCache: () => ({
        computeAndCacheSymbol: async () => undefined,
      }),
    },
  });

  const { searchSymbolsHybridWithOverlay } = await import(
    "../../dist/live-index/overlay-reader.js?overlay-context-provenance"
  );
  const result = await searchSymbolsHybridWithOverlay(
    {} as Connection,
    "repo",
    "NeedOverlay",
    10,
    {
      includeEvidence: true,
      queryContext,
    },
  );

  assert.strictEqual(receivedContext, queryContext);
  assert.deepEqual(result.rows.map((row) => row.sourceRanks), [
    { overlay: 1 },
  ]);
  assert.deepEqual(result.evidence?.sources, ["fts", "overlay"]);
  assert.deepEqual(result.evidence?.topRanksPerSource, {
    fts: [],
    overlay: [1],
  });
  assert.deepEqual(result.evidence?.candidateCountPerSource, {
    fts: 0,
    overlay: 1,
  });
});
