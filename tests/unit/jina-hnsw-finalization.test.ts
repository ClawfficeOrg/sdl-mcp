import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppConfigSchema } from "../../dist/config/types.js";
import {
  prepareReopenedJinaHnsw,
  resolveConfiguredJinaHnswSpec,
  validateReopenedJinaHnsw,
} from "../../dist/indexer/jina-hnsw-finalization.js";

const JINA_CODE_MODEL = "jina-embeddings-v2-base-code";

function parseConfig(semantic: Record<string, unknown>) {
  return AppConfigSchema.parse({ repos: [], policy: {}, semantic });
}

describe("resolveConfiguredJinaHnswSpec", () => {
  const cases = [
    {
      name: "returns undefined when semantic indexing is disabled",
      config: parseConfig({ enabled: false, retrieval: {} }),
      expected: undefined,
    },
    {
      name: "returns undefined when vector retrieval is disabled",
      config: parseConfig({ retrieval: { vector: { enabled: false } } }),
      expected: undefined,
    },
    {
      name: "returns undefined when Jina is absent from the Symbol model plan",
      config: parseConfig({
        symbolEmbeddingModels: ["nomic-embed-text-v1.5"],
        retrieval: {},
      }),
      expected: undefined,
    },
    {
      name: "resolves the default Jina HNSW specification",
      config: parseConfig({ retrieval: {} }),
      expected: {
        model: JINA_CODE_MODEL,
        indexName: "symbol_vec_jina_code_v2",
        vectorProperty: "embeddingJinaCodeVec",
        dimension: 768,
        efc: 200,
      },
    },
    {
      name: "uses the configured Jina index name and efc",
      config: parseConfig({
        retrieval: {
          vector: {
            efc: 321,
            indexes: {
              [JINA_CODE_MODEL]: { indexName: "custom_jina_hnsw" },
            },
          },
        },
      }),
      expected: {
        model: JINA_CODE_MODEL,
        indexName: "custom_jina_hnsw",
        vectorProperty: "embeddingJinaCodeVec",
        dimension: 768,
        efc: 321,
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.deepStrictEqual(
        resolveConfiguredJinaHnswSpec(testCase.config),
        testCase.expected,
      );
    });
  }
});

const SPEC = {
  model: JINA_CODE_MODEL,
  indexName: "configured_jina_hnsw",
  vectorProperty: "embeddingJinaCodeVec",
  dimension: 2,
  efc: 321,
} as const;
const CONNECTION = {} as never;
const PROBE = { repoId: "full-a", symbolId: "probe", vector: [1, 0] };

function healthyIndex(overrides: Record<string, unknown> = {}) {
  return {
    name: SPEC.indexName,
    tableName: "Symbol",
    property: SPEC.vectorProperty,
    type: "vector",
    status: "healthy",
    extensionLoaded: true,
    ...overrides,
  };
}

function finalizerDependencies(overrides: Record<string, unknown> = {}) {
  const calls = {
    create: [] as unknown[][],
    repoProbe: [] as string[],
    query: 0,
    showIndexes: 0,
  };
  const dependencies = {
    getLadybugConn: async () => CONNECTION,
    withWriteConn: async (work: (conn: never) => Promise<unknown>) =>
      work(CONNECTION),
    runHnswRebuildCycle: async (
      _pre: string,
      _post: string,
      rebuild: () => Promise<unknown>,
      _timeout?: number,
      recordTiming?: (phase: string, durationMs: number) => void,
    ) => {
      recordTiming?.("checkpoint.pre", 2);
      const result = await rebuild();
      recordTiming?.("checkpoint.post", 3);
      return result;
    },
    showIndexesStrict: async () => {
      calls.showIndexes++;
      return [];
    },
    createVectorIndex: async (...args: unknown[]) => {
      calls.create.push(args);
      return true;
    },
    readRepoSymbolVectorProbe: async (_conn: never, repoId: string) => {
      calls.repoProbe.push(repoId);
      return { symbolCount: 0, probe: null };
    },
    readDeterministicSymbolVectorProbe: async () => PROBE,
    readSymbolNumericVector: async () => PROBE.vector,
    queryVectorIndexProbe: async () => {
      calls.query++;
      return [{ symbolId: PROBE.symbolId, distance: 0 }];
    },
    assertPhysicalSymbolUniqueness: async () => ({
      physicalTotal: 0,
      distinctTotal: 0,
    }),
    ...overrides,
  };
  return { calls, dependencies };
}

describe("reopened Jina HNSW finalization", () => {
  it("skips creation when every selected full repo and the global Symbol table are empty", async () => {
    const { calls, dependencies } = finalizerDependencies({
      readDeterministicSymbolVectorProbe: async () => null,
    });

    const result = await prepareReopenedJinaHnsw(
      {
        spec: SPEC,
        selectedFullRepoIds: ["full-a", "full-b"],
        requireAbsent: false,
      },
      dependencies,
    );

    assert.equal(result.outcome, "skipped-empty");
    assert.equal(result.catalogMutated, false);
    assert.equal(result.probe, null);
    assert.equal(result.createMs, 0);
    assert.equal(result.queryMs, 0);
    assert.equal(result.checkpointMs, 0);
    assert.deepEqual(calls.repoProbe, ["full-a", "full-b"]);
    assert.equal(calls.create.length, 0);
  });

  it("checks requireAbsent before treating an empty candidate as skipped", async () => {
    let probeReads = 0;
    const { calls, dependencies } = finalizerDependencies({
      showIndexesStrict: async () => [healthyIndex()],
      readRepoSymbolVectorProbe: async () => {
        probeReads++;
        return { symbolCount: 0, probe: null };
      },
      readDeterministicSymbolVectorProbe: async () => {
        probeReads++;
        return null;
      },
    });

    await assert.rejects(
      prepareReopenedJinaHnsw(
        {
          spec: SPEC,
          selectedFullRepoIds: ["full-a"],
          requireAbsent: true,
        },
        dependencies,
      ),
      /deferral failed.*already exists/i,
    );
    assert.equal(probeReads, 0);
    assert.equal(calls.create.length, 0);
  });

  it("fails when any non-empty selected full repo lacks a valid Jina vector", async () => {
    const { dependencies } = finalizerDependencies({
      readRepoSymbolVectorProbe: async (_conn: never, repoId: string) =>
        repoId === "full-with-vector"
          ? { symbolCount: 1, probe: PROBE }
          : { symbolCount: 1, probe: null },
    });

    await assert.rejects(
      prepareReopenedJinaHnsw(
        {
          spec: SPEC,
          selectedFullRepoIds: ["full-with-vector", "full-without-vector"],
          requireAbsent: false,
        },
        dependencies,
      ),
      /full-without-vector.*no valid Jina vector/i,
    );
  });

  for (const [name, index] of [
    ["wrong table", healthyIndex({ tableName: "FileSummary" })],
    ["wrong property", healthyIndex({ property: "embeddingOtherVec" })],
    ["wrong type", healthyIndex({ type: "fts" })],
    ["unhealthy", healthyIndex({ status: "unknown" })],
    ["extension unloaded", healthyIndex({ extensionLoaded: false })],
  ] as const) {
    it(`fails closed without replacing a configured index with ${name}`, async () => {
      const { calls, dependencies } = finalizerDependencies({
        showIndexesStrict: async () => [index],
      });

      await assert.rejects(
        prepareReopenedJinaHnsw(
          {
            spec: SPEC,
            selectedFullRepoIds: ["full-a"],
            requireAbsent: false,
          },
          dependencies,
        ),
        /configured index.*not healthy/i,
      );
      assert.equal(calls.create.length, 0);
    });
  }

  it("validates a healthy existing configured index in direct mode", async () => {
    const { calls, dependencies } = finalizerDependencies({
      showIndexesStrict: async () => [healthyIndex()],
      readRepoSymbolVectorProbe: async () => ({ symbolCount: 1, probe: PROBE }),
    });

    const result = await prepareReopenedJinaHnsw(
      {
        spec: SPEC,
        selectedFullRepoIds: ["full-a"],
        requireAbsent: false,
      },
      dependencies,
    );

    assert.equal(result.outcome, "validated-existing");
    assert.equal(result.catalogMutated, false);
    assert.equal(result.probe, PROBE);
    assert.equal(result.createMs, 0);
    assert.equal(result.checkpointMs, 0);
    assert.equal(calls.query, 1);
    assert.equal(calls.create.length, 0);
  });

  it("rejects any existing configured index when requireAbsent is true", async () => {
    const { calls, dependencies } = finalizerDependencies({
      showIndexesStrict: async () => [healthyIndex({ type: "fts" })],
    });
    await assert.rejects(
      prepareReopenedJinaHnsw(
        {
          spec: SPEC,
          selectedFullRepoIds: [],
          requireAbsent: true,
        },
        dependencies,
      ),
      /deferral failed.*already exists/i,
    );
    assert.equal(calls.create.length, 0);
  });

  it("creates an absent configured index once with the exact specification", async () => {
    let catalogReads = 0;
    const { calls, dependencies } = finalizerDependencies({
      showIndexesStrict: async () => {
        catalogReads++;
        return catalogReads === 1 ? [] : [healthyIndex()];
      },
      readRepoSymbolVectorProbe: async () => ({ symbolCount: 1, probe: PROBE }),
    });

    const result = await prepareReopenedJinaHnsw(
      {
        spec: SPEC,
        selectedFullRepoIds: ["full-a"],
        requireAbsent: true,
      },
      dependencies,
    );

    assert.equal(result.outcome, "created");
    assert.equal(result.catalogMutated, true);
    assert.equal(result.probe, PROBE);
    assert.equal(result.queryMs, 0);
    assert.equal(result.checkpointMs, 5);
    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.create[0].slice(1), [
      "Symbol",
      SPEC.vectorProperty,
      SPEC.indexName,
      SPEC.dimension,
      SPEC.efc,
    ]);
  });

  for (const [name, createVectorIndex] of [
    ["false", async () => false],
    ["failure", async () => Promise.reject(new Error("create exploded"))],
  ] as const) {
    it(`fails closed when create returns ${name}`, async () => {
      const { dependencies } = finalizerDependencies({
        readRepoSymbolVectorProbe: async () => ({
          symbolCount: 1,
          probe: PROBE,
        }),
        createVectorIndex,
      });
      await assert.rejects(
        prepareReopenedJinaHnsw(
          {
            spec: SPEC,
            selectedFullRepoIds: ["full-a"],
            requireAbsent: false,
          },
          dependencies,
        ),
        /could not create|create exploded/i,
      );
    });
  }

  it("accepts any near-zero logical ID whose persisted vector matches the probe", async () => {
    const { dependencies } = finalizerDependencies({
      showIndexesStrict: async () => [healthyIndex()],
      queryVectorIndexProbe: async () => [
        { symbolId: "different-logical-symbol", distance: 0 },
      ],
      readSymbolNumericVector: async () => [2, 0],
    });

    assert.ok(
      (await validateReopenedJinaHnsw(
        { spec: SPEC, probe: PROBE },
        dependencies,
      )) >= 0,
    );
  });

  for (const [name, overrides, message] of [
    ["no rows", { queryVectorIndexProbe: async () => [] }, /no rows/i],
    [
      "no near-zero row",
      {
        queryVectorIndexProbe: async () => [
          { symbolId: "other", distance: 0.25 },
        ],
      },
      /no near-zero/i,
    ],
    [
      "missing returned vector",
      {
        queryVectorIndexProbe: async () => [
          { symbolId: "other", distance: 0 },
        ],
        readSymbolNumericVector: async () => null,
      },
      /no persisted vector matching/i,
    ],
    [
      "vector mismatch",
      {
        queryVectorIndexProbe: async () => [
          { symbolId: "other", distance: 0 },
        ],
        readSymbolNumericVector: async () => [0, 1],
      },
      /no persisted vector matching/i,
    ],
  ] as const) {
    it(`rejects validation with ${name}`, async () => {
      const { dependencies } = finalizerDependencies({
        showIndexesStrict: async () => [healthyIndex()],
        ...overrides,
      });
      await assert.rejects(
        validateReopenedJinaHnsw(
          { spec: SPEC, probe: PROBE },
          dependencies,
        ),
        message,
      );
    });
  }
});
