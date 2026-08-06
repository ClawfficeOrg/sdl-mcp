import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as hnswBenchmark from "../../scripts/benchmark-hnsw-efc.ts";
import {
  parseHnswBenchmarkArgs,
  recallAtK,
  summarizeHnswCandidate,
} from "../../scripts/benchmark-hnsw-efc.ts";

describe("HNSW efc benchmark", () => {
  it("parses a source path and bounded benchmark controls", () => {
    const options = parseHnswBenchmarkArgs([
      "--source",
      "F:\\graphs\\candidate.lbug",
      "--efc",
      "200,100",
      "--queries",
      "12",
      "--k",
      "8",
    ]);

    assert.deepEqual(options, {
      sourcePath: "F:\\graphs\\candidate.lbug",
      loadMode: "create",
      efcValues: [200, 100],
      queryCount: 12,
      k: 8,
      efs: 200,
      pageSize: 256,
    });
  });

  it("accepts update and validated-clone load modes", () => {
    assert.equal(
      parseHnswBenchmarkArgs([
        "--source",
        "F:\\graphs\\candidate.lbug",
        "--load-mode",
        "update",
      ]).loadMode,
      "update",
    );
    assert.equal(
      parseHnswBenchmarkArgs([
        "--source",
        "F:\\graphs\\candidate.lbug",
        "--load-mode",
        "clone",
      ]).loadMode,
      "clone",
    );
    assert.throws(
      () =>
        parseHnswBenchmarkArgs([
          "--source",
          "F:\\graphs\\candidate.lbug",
          "--load-mode",
          "copy",
        ]),
      /--load-mode must be create, update, or clone/,
    );
  });

  it("accepts a clone index override only in clone mode", () => {
    assert.equal(
      parseHnswBenchmarkArgs([
        "--source",
        "F:\\graphs\\candidate.lbug",
        "--load-mode",
        "clone",
        "--index-name",
        "custom_jina_index",
      ]).indexName,
      "custom_jina_index",
    );
    assert.throws(
      () =>
        parseHnswBenchmarkArgs([
          "--source",
          "F:\\graphs\\candidate.lbug",
          "--index-name",
          "custom_jina_index",
        ]),
      /--index-name is only valid with --load-mode clone/,
    );
  });

  it("discovers the clone's unique Jina vector index", () => {
    const resolver = (
      hnswBenchmark as unknown as {
        resolveCloneVectorIndexName?: (
          indexes: Array<{
            name: string;
            tableName?: string;
            type: "fts" | "vector";
            property: string;
          }>,
          vectorProperty: string,
          requestedIndexName: string | undefined,
          fallbackIndexName: string,
        ) => string;
      }
    ).resolveCloneVectorIndexName;
    assert.equal(typeof resolver, "function");
    if (!resolver) return;

    const customIndex = {
      name: "custom_jina_index",
      tableName: "Symbol",
      type: "vector" as const,
      property: "embeddingJinaCodeVec",
    };
    assert.equal(
      resolver(
        [customIndex],
        "embeddingJinaCodeVec",
        undefined,
        "symbol_vec_jina_code_v2",
      ),
      "custom_jina_index",
    );
    assert.equal(
      resolver(
        [],
        "embeddingJinaCodeVec",
        "custom_jina_index",
        "symbol_vec_jina_code_v2",
      ),
      "custom_jina_index",
    );
    assert.throws(
      () =>
        resolver(
          [customIndex],
          "embeddingJinaCodeVec",
          "different_index",
          "symbol_vec_jina_code_v2",
        ),
      /already contains custom_jina_index/,
    );
    assert.throws(
      () =>
        resolver(
          [customIndex, { ...customIndex, name: "second_jina_index" }],
          "embeddingJinaCodeVec",
          undefined,
          "symbol_vec_jina_code_v2",
        ),
      /multiple Symbol vector indexes/,
    );
    assert.throws(
      () =>
        resolver(
          [{ ...customIndex, property: "embeddingNomicVec" }],
          "embeddingJinaCodeVec",
          "custom_jina_index",
          "symbol_vec_jina_code_v2",
        ),
      /custom_jina_index.*already used.*embeddingNomicVec/,
    );
  });

  it("rejects a relative source path before opening LadybugDB", () => {
    assert.throws(
      () => parseHnswBenchmarkArgs(["--source", "candidate.lbug"]),
      /absolute path/i,
    );
  });

  it("computes exact-set recall and candidate latency summaries", () => {
    assert.equal(recallAtK(["a", "c", "x"], ["a", "b", "c"], 3), 2 / 3);
    assert.deepEqual(summarizeHnswCandidate(1_250, [1, 0.8, 0.9], [3, 1, 2]), {
      buildMs: 1_250,
      meanRecall: 0.9,
      minRecall: 0.8,
      queryP50Ms: 2,
      queryP95Ms: 3,
    });
  });

  it("compares projected logical IDs against non-null exact vectors", () => {
    const source = readFileSync("scripts/benchmark-hnsw-efc.ts", "utf8");
    assert.match(
      source,
      /WHERE v\.\$\{targetVectorProperty\} IS NOT NULL[\s\S]*array_cosine_similarity/,
    );
    assert.match(
      source,
      /RETURN node\.\$\{targetIdProperty\} AS id, distance/,
    );
  });
});
