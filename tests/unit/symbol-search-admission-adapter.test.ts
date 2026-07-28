import assert from "node:assert/strict";
import { it } from "node:test";

it("reuses the Symbol connection and preserves IndexError", async (t) => {
  const ladybug = await import("../../dist/db/ladybug.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const configTypes = await import("../../dist/config/types.js");
  const { IndexError } = await import("../../dist/domain/errors.js");

  const semantic = configTypes.SemanticConfigSchema.parse({
    enabled: true,
  });
  const connections: object[] = [];
  let hybridConn: unknown;
  let hybridQueryContext: { connection?: unknown } | undefined;
  let lexicalCalls = 0;

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      ...ladybug,
      getLadybugConn: async () => {
        const conn = { id: connections.length + 1 };
        connections.push(conn);
        return conn;
      },
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...ladybugQueries,
      getRepo: async () => ({ repoId: "repo" }),
      findSymbolByExactName: async () => null,
    },
  });
  t.mock.module("../../dist/config/loadConfig.js", {
    namedExports: {
      ...loadConfigModule,
      loadConfig: () => ({ semantic }),
    },
  });
  t.mock.module("../../dist/live-index/overlay-reader.js", {
    namedExports: {
      getOverlaySnapshot: async () => ({ files: [], symbols: [] }),
      getOverlaySymbol: () => null,
      getShadowedDurableSymbol: () => null,
      getTargetNamesWithOverlay: async () => [],
      resolveSymbolsWithOverlay: async () => ({ items: [] }),
      searchSymbolsHybridWithOverlay: async (
        conn: unknown,
        _repoId: string,
        _query: string,
        _limit: number,
        options: { queryContext?: { connection?: unknown } },
      ) => {
        hybridConn = conn;
        hybridQueryContext = options.queryContext;
        throw new IndexError("graph retrieval rejected");
      },
      searchSymbolsWithOverlay: async () => {
        lexicalCalls += 1;
        return [
          {
            symbolId: "symbol-1",
            name: "NeedThing",
            kind: "function",
            fileId: "file-1",
            filePath: "src/need.ts",
          },
        ];
      },
    },
  });

  const { handleSymbolSearch } = await import(
    "../../dist/mcp/tools/symbol.js?strict-symbol-admission"
  );

  await assert.rejects(
    () =>
      handleSymbolSearch({
        repoId: "repo",
        query: "NeedThing",
        semantic: true,
        limit: 10,
      }),
    (error: unknown) => error instanceof IndexError,
  );
  assert.equal(connections.length, 1);
  assert.strictEqual(hybridConn, connections[0]);
  assert.strictEqual(hybridQueryContext?.connection, connections[0]);
  assert.equal(lexicalCalls, 0);
});

it("recovers lexical results truthfully when semantic lanes are unavailable", async (t) => {
  const ladybug = await import("../../dist/db/ladybug.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const configTypes = await import("../../dist/config/types.js");
  const telemetryModule = await import("../../dist/mcp/telemetry.js");
  const { computeRelevance } = await import(
    "../../dist/util/symbol-relevance.js"
  );
  const semantic = configTypes.SemanticConfigSchema.parse({ enabled: true });
  const conn = { id: "symbol-search" };
  const query = "retrieval unrelated";
  const lexicalName = "RetrievalCoordinator";
  const baseRelevance = computeRelevance(lexicalName, query);
  assert.ok(baseRelevance >= 0.3 && baseRelevance < 0.4);

  let lexicalCalls = 0;
  let telemetry:
    | {
        semanticEnabled?: boolean;
        retrievalMode?: string;
        retrievalType?: string;
        fallbackReason?: string;
      }
    | undefined;

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      ...ladybug,
      getLadybugConn: async () => conn,
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...ladybugQueries,
      getRepo: async () => ({ repoId: "repo" }),
      findSymbolByExactName: async () => null,
    },
  });
  t.mock.module("../../dist/config/loadConfig.js", {
    namedExports: {
      ...loadConfigModule,
      loadConfig: () => ({ semantic }),
    },
  });
  t.mock.module("../../dist/mcp/telemetry.js", {
    namedExports: {
      ...telemetryModule,
      logSemanticSearchTelemetry: (event: typeof telemetry) => {
        telemetry = event;
      },
    },
  });
  t.mock.module("../../dist/live-index/overlay-reader.js", {
    namedExports: {
      getOverlaySnapshot: async () => ({ files: [], symbols: [] }),
      getOverlaySymbol: () => null,
      getShadowedDurableSymbol: () => null,
      getTargetNamesWithOverlay: async () => [],
      resolveSymbolsWithOverlay: async () => ({ items: [] }),
      searchSymbolsHybridWithOverlay: async () => ({
        rows: [],
        evidence: {
          sources: [],
          candidateCountPerSource: {},
          topRanksPerSource: {},
          fusionLatencyMs: 0,
          fallbackReason: "all-backends-returned-empty",
        },
      }),
      searchSymbolsWithOverlay: async () => {
        lexicalCalls += 1;
        return [
          {
            symbolId: "lexical-symbol",
            name: lexicalName,
            kind: "function",
            fileId: "lexical-file",
            filePath: "src/retrieval-coordinator.ts",
          },
        ];
      },
    },
  });

  const { handleSymbolSearch } = await import(
    "../../dist/mcp/tools/symbol.js?lexical-recovery"
  );
  const response = await handleSymbolSearch({
    repoId: "repo",
    query,
    semantic: true,
    includeRetrievalEvidence: true,
    limit: 10,
  });

  assert.equal(lexicalCalls, 1);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.symbolId, "lexical-symbol");
  assert.equal(
    response.results[0]?.relevance,
    Math.round(baseRelevance * 100) / 100,
  );
  assert.deepEqual(response.retrievalEvidence, [
    { symbolId: "lexical-symbol", retrievalSource: "legacy" },
  ]);
  assert.equal(telemetry?.semanticEnabled, false);
  assert.equal(telemetry?.retrievalMode, "lexical");
  assert.equal(telemetry?.retrievalType, "lexical-only");
  assert.equal(telemetry?.fallbackReason, "all-backends-returned-empty");
});
