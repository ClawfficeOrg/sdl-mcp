import assert from "node:assert/strict";
import { it } from "node:test";
import type { GraphSlice } from "../../dist/domain/types.js";

it("shares one query context across task-text slice and memory retrieval", async (t) => {
  const ladybug = await import("../../dist/db/ladybug.js");
  const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  const retrieval = await import("../../dist/retrieval/index.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const memoryConfig = await import("../../dist/config/memory-config.js");
  const memorySurface = await import("../../dist/memory/surface.js");

  const slice: GraphSlice = {
    repoId: "repo",
    versionId: "v1",
    budget: { maxCards: 10, maxEstimatedTokens: 1000 },
    startSymbols: [],
    symbolIndex: [],
    cards: [],
    edges: [],
  };
  let sliceContext: unknown;
  let memoryContext: unknown;

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      ...ladybug,
      getLadybugConn: async () => ({}),
      withWriteConn: async (fn: (conn: object) => Promise<unknown>) => fn({}),
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...ladybugQueries,
      getRepo: async () => ({ configJson: "{}" }),
      getLatestVersion: async () => ({ versionId: "v1" }),
      upsertSliceHandle: async () => undefined,
    },
  });
  t.mock.module("../../dist/services/graph-retrieval-availability.js", {
    namedExports: {
      assertGraphRetrievalAvailable: async () => undefined,
    },
  });
  t.mock.module("../../dist/graph/slice.js", {
    namedExports: {
      buildSlice: async (request: { queryContext?: unknown }) => {
        sliceContext = request.queryContext;
        return { slice, hybridSearchItems: [] };
      },
    },
  });
  t.mock.module("../../dist/retrieval/index.js", {
    namedExports: {
      ...retrieval,
      entitySearch: async (_options: unknown, queryContext: unknown) => {
        memoryContext = queryContext;
        return { results: [] };
      },
    },
  });
  t.mock.module("../../dist/config/loadConfig.js", {
    namedExports: {
      ...loadConfigModule,
      loadConfig: () => ({}),
    },
  });
  t.mock.module("../../dist/config/memory-config.js", {
    namedExports: {
      ...memoryConfig,
      getMemoryCapabilities: () => ({
        enabled: true,
        toolsEnabled: true,
        fileSyncEnabled: true,
        surfacingEnabled: true,
        hintsEnabled: true,
        defaultSurfaceLimit: 5,
      }),
    },
  });
  t.mock.module("../../dist/memory/surface.js", {
    namedExports: {
      ...memorySurface,
      loadCentralitySignals: async () => new Map(),
      surfaceRelevantMemories: async () => [],
    },
  });
  t.mock.module("../../dist/policy/code-access.js", {
    namedExports: {
      decideCodeAccess: () => ({ kind: "approve", reason: "test" }),
      toLegacyPolicyDecision: () => ({
        decision: "allow",
        reason: "test",
        auditHash: "test",
        evidenceUsed: [],
        deniedReasons: [],
      }),
    },
  });
  t.mock.module("../../dist/graph/prefetch.js", {
    namedExports: {
      consumePrefetchedKey: () => undefined,
      prefetchSliceFrontier: () => undefined,
    },
  });
  t.mock.module("../../dist/graph/prefetch-model.js", {
    namedExports: { recordToolTrace: () => undefined },
  });

  const { handleSliceBuild } = await import(
    "../../dist/mcp/tools/slice.js?shared-slice-query-context"
  );
  await handleSliceBuild({
    repoId: "repo",
    taskText: "find task context",
    includeMemories: true,
    wireFormat: "readable",
  });

  assert.ok(sliceContext);
  assert.strictEqual(memoryContext, sliceContext);
});
