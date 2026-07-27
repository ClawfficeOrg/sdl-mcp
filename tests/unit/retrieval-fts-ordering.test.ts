import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("stabilizes equal-score FTS rows for symbols and file summaries", async (t) => {
  const ladybug = await import("../../dist/db/ladybug.js");
  const ladybugCore = await import("../../dist/db/ladybug-core.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const configTypes = await import("../../dist/config/types.js");
  const graphAdmission = await import(
    "../../dist/services/graph-retrieval-availability.js"
  );
  const healthModule = await import("../../dist/retrieval/health.js");

  const semantic = configTypes.SemanticConfigSchema.parse({
    enabled: true,
    embeddingProfile: "specialized",
    symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
    fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
    retrieval: { mode: "hybrid" },
  });
  const caps = {
    fts: true,
    fileSummaryFts: true,
    vectorNomic: false,
    vectorJinaCode: false,
    vectorByEntityModel: {
      symbol: { "jina-embeddings-v2-base-code": false },
      fileSummary: { "nomic-embed-text-v1.5": false },
    },
    coveragePermille: {
      symbolVector: 0,
      fileSummaryVector: 0,
    },
  };
  let symbolRows = [
    { node: { symbolId: "symbol-b" }, score: 1 },
    { node: { symbolId: "symbol-a" }, score: 1 + 1e-14 },
  ];
  let fileSummaryRows = [
    { node: { fileId: "file-b" }, score: 1 },
    { node: { fileId: "file-a" }, score: 1 + 1e-14 },
  ];

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      ...ladybug,
      getLadybugConn: async () => ({} as Connection),
    },
  });
  t.mock.module("../../dist/db/ladybug-core.js", {
    namedExports: {
      ...ladybugCore,
      queryStoredProcAll: async (_conn: Connection, query: string) => {
        // Return the supplied permutation unchanged to model unspecified stored-proc order.
        return query.includes("'FileSummary'")
          ? fileSummaryRows
          : symbolRows;
      },
    },
  });
  t.mock.module("../../dist/config/loadConfig.js", {
    namedExports: {
      ...loadConfigModule,
      loadConfig: () => ({ semantic }),
    },
  });
  t.mock.module("../../dist/services/graph-retrieval-availability.js", {
    namedExports: {
      ...graphAdmission,
      assertGraphRetrievalAvailable: async () => undefined,
    },
  });
  t.mock.module("../../dist/retrieval/health.js", {
    namedExports: {
      ...healthModule,
      checkRetrievalHealth: async () => caps,
    },
  });

  const { entitySearch, hybridSearch } = await import(
    "../../dist/retrieval/orchestrator.js?fts-ordering"
  );

  const symbolOrders: string[][] = [];
  const fileSummaryOrders: string[][] = [];
  for (let iteration = 0; iteration < 2; iteration++) {
    const symbolResult = await hybridSearch({
      repoId: "repo",
      query: "equal score",
      limit: 10,
      ftsEnabled: true,
      vectorEnabled: false,
    });
    symbolOrders.push(symbolResult.results.map((item) => item.symbolId));

    const fileSummaryResult = await entitySearch({
      repoId: "repo",
      query: "equal score",
      limit: 10,
      entityTypes: ["fileSummary"],
      ftsEnabled: true,
      vectorEnabled: false,
    });
    fileSummaryOrders.push(
      fileSummaryResult.results.map((item) => item.entityId),
    );

    symbolRows = [...symbolRows].reverse();
    fileSummaryRows = [...fileSummaryRows].reverse();
  }

  assert.deepEqual(symbolOrders, [
    ["symbol-a", "symbol-b"],
    ["symbol-a", "symbol-b"],
  ]);
  assert.deepEqual(fileSummaryOrders, [
    ["file-a", "file-b"],
    ["file-a", "file-b"],
  ]);
});
