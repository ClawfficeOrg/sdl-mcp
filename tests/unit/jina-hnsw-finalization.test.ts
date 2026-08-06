import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppConfigSchema } from "../../dist/config/types.js";
import { resolveConfiguredJinaHnswSpec } from "../../dist/indexer/jina-hnsw-finalization.js";

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
