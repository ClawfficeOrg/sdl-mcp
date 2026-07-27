import assert from "node:assert/strict";
import { it } from "node:test";

it("uses admitted Symbol connection and preserves IndexError", async (t) => {
  const ladybug = await import("../../dist/db/ladybug.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const configTypes = await import("../../dist/config/types.js");
  const graphAdmission = await import(
    "../../dist/services/graph-retrieval-availability.js"
  );
  const healthModule = await import("../../dist/retrieval/health.js");
  const { IndexError } = await import("../../dist/domain/errors.js");

  const semantic = configTypes.SemanticConfigSchema.parse({
    enabled: true,
    retrieval: { mode: "hybrid" },
  });
  const connections: object[] = [];
  let strictHealthConn: unknown;
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
  t.mock.module("../../dist/services/graph-retrieval-availability.js", {
    namedExports: {
      ...graphAdmission,
      assertGraphRetrievalAvailable: async () => undefined,
    },
  });
  t.mock.module("../../dist/retrieval/health.js", {
    namedExports: {
      ...healthModule,
      checkRetrievalHealth: async (conn: unknown) => {
        strictHealthConn = conn;
        return {
          fts: true,
          fileSummaryFts: true,
          vectorNomic: true,
          vectorJinaCode: true,
          coveragePermille: {
            symbolVector: 1000,
            fileSummaryVector: 1000,
          },
        };
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
      searchSymbolsHybridWithOverlay: async () => {
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
  assert.strictEqual(strictHealthConn, connections[0]);
  assert.equal(lexicalCalls, 0);
});
