import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connection } from "kuzu";

import {
  createRetrievalQueryContext,
  getOrCreateEmbeddingPromise,
  getOrCreateHealthPromise,
  runAfterGraphRetrievalAdmission,
  sortVectorRowsByDistance,
} from "../../dist/retrieval/orchestrator.js";
import type { RetrievalCapabilities } from "../../dist/retrieval/types.js";

const healthy: RetrievalCapabilities = {
  fts: true,
  fileSummaryFts: true,
  vectorNomic: true,
  vectorJinaCode: true,
  coveragePermille: {
    symbolVector: 1000,
    fileSummaryVector: 1000,
  },
};

describe("request-scoped retrieval work", () => {
  it("shares one pending health promise per repository", async () => {
    const context = createRetrievalQueryContext();
    let calls = 0;
    let release: ((value: RetrievalCapabilities) => void) | undefined;
    const factory = () => {
      calls += 1;
      return new Promise<RetrievalCapabilities>((resolve) => {
        release = resolve;
      });
    };

    const first = getOrCreateHealthPromise(context, "repo", factory);
    const second = getOrCreateHealthPromise(context, "repo", factory);

    assert.strictEqual(first, second);
    assert.equal(calls, 0, "promise is cached before deferred work starts");
    assert.equal(context.healthPromises.size, 1);
    await Promise.resolve();
    assert.equal(calls, 1);
    release?.(healthy);
    assert.deepEqual(await first, healthy);
  });

  it("keys embeddings by both model and prefixed query", async () => {
    const context = createRetrievalQueryContext();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return [calls];
    };

    const first = getOrCreateEmbeddingPromise(
      context,
      "model-a",
      "query: shared",
      factory,
    );
    const duplicate = getOrCreateEmbeddingPromise(
      context,
      "model-a",
      "query: shared",
      factory,
    );
    const otherModel = getOrCreateEmbeddingPromise(
      context,
      "model-b",
      "query: shared",
      factory,
    );
    const otherQuery = getOrCreateEmbeddingPromise(
      context,
      "model-a",
      "query: other",
      factory,
    );

    assert.strictEqual(first, duplicate);
    assert.equal(context.embeddingPromises.size, 3);
    assert.deepEqual(await Promise.all([first, duplicate, otherModel, otherQuery]), [
      [1],
      [1],
      [2],
      [3],
    ]);
    assert.equal(calls, 3);
  });

  it("sorts raw HNSW rows by numeric distance then stable ID", () => {
    const sorted = sortVectorRowsByDistance([
      { node: { symbolId: "b" }, distance: 0.2 },
      { node: { symbolId: "c" }, distance: 0.1 },
      { node: { symbolId: "a" }, distance: 0.2 },
    ]);

    assert.deepEqual(
      sorted.map((row) => row.node?.symbolId),
      ["c", "a", "b"],
    );
  });

  it("runs zero downstream work when graph integrity rejects admission", async () => {
    const conn = {} as unknown as Connection;
    let healthCalls = 0;
    let storedProcedureCalls = 0;
    let embeddingCalls = 0;

    const run = async () => {
      await runAfterGraphRetrievalAdmission(
        conn,
        "repo",
        async () => {
          healthCalls += 1;
          storedProcedureCalls += 1;
          embeddingCalls += 1;
          return healthy;
        },
        async () => {
          throw new Error("graph integrity rejected");
        },
      );
    };

    await assert.rejects(run, /graph integrity rejected/);
    assert.deepEqual(
      { healthCalls, storedProcedureCalls, embeddingCalls },
      { healthCalls: 0, storedProcedureCalls: 0, embeddingCalls: 0 },
    );
  });
});
