import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import {
  aggregateCoveragePermille,
  checkRetrievalHealth,
  hasExactHealthyIndex,
  resolveRequiredRetrievalIndexes,
} from "../../dist/retrieval/health.js";

const exactIndexes = [
  {
    name: "symbol_search_text_v1",
    tableName: "Symbol",
    type: "fts" as const,
    property: "searchText",
    extensionLoaded: true,
    status: "healthy" as const,
  },
];

describe("strict retrieval health", () => {
  it("requires an exact table, name, type, and property match", () => {
    const required = {
      name: "symbol_search_text_v1",
      tableName: "Symbol",
      type: "fts" as const,
      property: "searchText",
    };

    assert.equal(hasExactHealthyIndex(exactIndexes, required), true);
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], property: "wrongProperty" }],
        required,
      ),
      false,
    );
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], tableName: "FileSummary" }],
        required,
      ),
      false,
    );
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], type: "vector" }],
        required,
      ),
      false,
    );
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], extensionLoaded: false }],
        required,
      ),
      false,
    );
  });

  it("derives only active specialized-model indexes from shared mappings", () => {
    const required = resolveRequiredRetrievalIndexes(undefined);

    assert.deepEqual(required.symbolVectors, [
      {
        model: "jina-embeddings-v2-base-code",
        tableName: "Symbol",
        name: "symbol_vec_jina_code_v2",
        type: "vector",
        property: "embeddingJinaCodeVec",
      },
    ]);
    assert.deepEqual(required.fileSummaryVectors, [
      {
        model: "nomic-embed-text-v1.5",
        tableName: "FileSummary",
        name: "filesummary_vec_nomic_embed_v15",
        type: "vector",
        property: "embeddingNomicVec",
      },
    ]);
  });

  it("converts bigint coverage counts and rounds once after aggregation", () => {
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 1n, covered: 1n, indexHealthy: true },
        { eligible: 2n, covered: 1n, indexHealthy: true },
      ]),
      667,
    );
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 1n, covered: 1n, indexHealthy: true },
        { eligible: 4n, covered: 1n, indexHealthy: true },
      ]),
      400,
    );
  });

  it("handles zero, partial, and full eligible coverage", () => {
    assert.equal(aggregateCoveragePermille([]), 1000);
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 100n, covered: 40n, indexHealthy: true },
      ]),
      400,
    );
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 100n, covered: 100n, indexHealthy: true },
      ]),
      1000,
    );
  });

  it("counts a missing required index as zero covered rows", () => {
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 100n, covered: 100n, indexHealthy: false },
      ]),
      0,
    );
  });

  it("keeps health errors unavailable instead of promoting extensions", async () => {
    const conn = {
      query: async () => {
        throw new Error("SHOW_INDEXES failed");
      },
    } as unknown as Connection;

    const health = await checkRetrievalHealth(conn, "repo", undefined);

    assert.equal(health.fts, false);
    assert.equal(health.fileSummaryFts, false);
    assert.equal(health.vectorNomic, false);
    assert.equal(health.vectorJinaCode, false);
    assert.deepEqual(health.coveragePermille, {
      symbolVector: 0,
      fileSummaryVector: 0,
    });
    assert.equal(health.degradationReasons?.[0]?.code, "health-check-error");
  });
});
