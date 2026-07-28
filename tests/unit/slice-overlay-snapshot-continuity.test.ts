import assert from "node:assert/strict";
import { describe, it } from "node:test";

function makeSnapshot(touchedFileIds: string[]) {
  return {
    repoId: "repo",
    touchedFileIds: new Set(touchedFileIds),
    symbolsById: new Map(),
    filesById: new Map(),
    outgoingEdgesBySymbolId: new Map(),
    contentByFileId: new Map(),
  };
}

describe("standalone slice overlay snapshot continuity", () => {
  it("retains slice caching for a captured empty snapshot", async (t) => {
    const snapshot = makeSnapshot([]);
    const cachedSlice = { cards: [] };
    let cacheReads = 0;

    const overlayReader = await import("../../dist/live-index/overlay-reader.js");
    const sliceCache = await import("../../dist/graph/sliceCache.js");
    const configModule = await import("../../dist/config/loadConfig.js");
    const ladybugModule = await import("../../dist/db/ladybug.js");
    const config = configModule.loadConfig();

    t.mock.module("../../dist/live-index/overlay-reader.js", {
      namedExports: {
        ...overlayReader,
        getOverlaySnapshot: () => snapshot,
      },
    });
    t.mock.module("../../dist/graph/sliceCache.js", {
      namedExports: {
        ...sliceCache,
        getCachedSlice: () => {
          cacheReads++;
          return cachedSlice;
        },
      },
    });
    t.mock.module("../../dist/config/loadConfig.js", {
      namedExports: {
        ...configModule,
        loadConfig: () => ({
          ...config,
          cache: {
            ...config.cache,
            enabled: true,
            graphSliceMaxEntries: config.cache?.graphSliceMaxEntries ?? 100,
          },
        }),
      },
    });
    t.mock.module("../../dist/db/ladybug.js", {
      namedExports: {
        ...ladybugModule,
        getLadybugConn: async () => {
          throw new Error("empty snapshot should have returned the cached slice");
        },
      },
    });

    const { buildSlice } = await import(
      "../../dist/graph/slice.js?empty-overlay-cache"
    );
    const result = await buildSlice({
      repoId: "repo",
      versionId: "version",
      taskText: "cached task",
    });

    assert.equal(cacheReads, 1);
    assert.strictEqual(result.slice, cachedSlice);
  });

  it("threads one touched snapshot through resolver, DB beam, and hydration", async (t) => {
    const snapshot = makeSnapshot(["draft-file"]);
    let resolverSnapshot: unknown;
    let beamSnapshot: unknown;
    let hydrationSnapshot: unknown;
    let graphCacheReads = 0;
    let sliceCacheReads = 0;
    let sliceCacheWrites = 0;

    const overlayReader = await import("../../dist/live-index/overlay-reader.js");
    const sliceCache = await import("../../dist/graph/sliceCache.js");
    const graphCache = await import("../../dist/graph/graphSnapshotCache.js");
    const resolver = await import(
      "../../dist/graph/slice/start-node-resolver.js"
    );
    const beam = await import("../../dist/graph/slice/beam-search-engine.js");
    const hydrator = await import("../../dist/graph/slice/card-hydrator.js");
    const edgeProjector = await import(
      "../../dist/graph/slice/edge-projector.js"
    );
    const ladybugModule = await import("../../dist/db/ladybug.js");
    const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
    const configModule = await import("../../dist/config/loadConfig.js");
    const config = configModule.loadConfig();

    t.mock.module("../../dist/live-index/overlay-reader.js", {
      namedExports: {
        ...overlayReader,
        getOverlaySnapshot: () => snapshot,
      },
    });
    t.mock.module("../../dist/graph/sliceCache.js", {
      namedExports: {
        ...sliceCache,
        getCachedSlice: () => {
          sliceCacheReads++;
          return null;
        },
        setCachedSlice: () => {
          sliceCacheWrites++;
        },
      },
    });
    t.mock.module("../../dist/graph/graphSnapshotCache.js", {
      namedExports: {
        ...graphCache,
        getGraphSnapshot: () => {
          graphCacheReads++;
          return null;
        },
      },
    });
    t.mock.module("../../dist/graph/slice/start-node-resolver.js", {
      namedExports: {
        ...resolver,
        resolveStartNodesLadybug: async (...args: unknown[]) => {
          resolverSnapshot = args[4];
          return {
            startNodes: [{ symbolId: "seed", source: "taskText" }],
          };
        },
      },
    });
    t.mock.module("../../dist/graph/slice/beam-search-engine.js", {
      namedExports: {
        ...beam,
        beamSearchLadybug: async (...args: unknown[]) => {
          beamSnapshot = args[9];
          return {
            sliceCards: new Set(["seed"]),
            frontier: [],
            wasTruncated: false,
            droppedCandidates: 0,
            maxFrontierSize: 0,
          };
        },
      },
    });
    t.mock.module("../../dist/graph/slice/card-hydrator.js", {
      namedExports: {
        ...hydrator,
        loadSymbolCards: async (...args: unknown[]) => {
          hydrationSnapshot = args.at(-1);
          return {
            cards: [],
            sliceDepsBySymbol: new Map(),
          };
        },
      },
    });
    t.mock.module("../../dist/graph/slice/edge-projector.js", {
      namedExports: {
        ...edgeProjector,
        loadEdgesBetweenSymbols: async () => [],
      },
    });
    t.mock.module("../../dist/db/ladybug.js", {
      namedExports: {
        ...ladybugModule,
        getLadybugConn: async () => ({}),
      },
    });
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        ...ladybugQueries,
        getClustersForSymbols: async () => new Map(),
      },
    });
    t.mock.module("../../dist/config/loadConfig.js", {
      namedExports: {
        ...configModule,
        loadConfig: () => ({
          ...config,
          cache: {
            ...config.cache,
            enabled: true,
            graphSliceMaxEntries: config.cache?.graphSliceMaxEntries ?? 100,
          },
        }),
      },
    });

    const { buildSlice } = await import(
      "../../dist/graph/slice.js?touched-overlay-continuity"
    );
    await buildSlice({
      repoId: "repo",
      versionId: "version",
      taskText: "overlay-only seed",
      budget: { maxCards: 4, maxEstimatedTokens: 1_000 },
    });

    assert.strictEqual(resolverSnapshot, snapshot);
    assert.strictEqual(beamSnapshot, snapshot);
    assert.strictEqual(hydrationSnapshot, snapshot);
    assert.equal(graphCacheReads, 0);
    assert.equal(sliceCacheReads, 0);
    assert.equal(sliceCacheWrites, 0);
  });
});
