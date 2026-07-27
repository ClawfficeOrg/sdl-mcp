import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SemanticRetrievalConfigSchema } from "../../dist/config/types.js";

describe("retrieval fusion config", () => {
  it("defaults every fixed logical source weight and the coverage threshold", () => {
    const fusion = SemanticRetrievalConfigSchema.parse({}).fusion;

    assert.deepEqual(fusion.weights, {
      fts: 1,
      vector: 1,
      legacyFallback: 1,
      overlay: 1,
    });
    assert.equal(fusion.partialCoverageThresholdPermille, 1000);
  });

  it("accepts explicit fixed weights and an integer permille threshold", () => {
    const fusion = SemanticRetrievalConfigSchema.parse({
      fusion: {
        weights: {
          fts: 3,
          vector: 2,
          legacyFallback: 1,
          overlay: 4,
        },
        partialCoverageThresholdPermille: 750,
      },
    }).fusion;

    assert.deepEqual(fusion.weights, {
      fts: 3,
      vector: 2,
      legacyFallback: 1,
      overlay: 4,
    });
    assert.equal(fusion.partialCoverageThresholdPermille, 750);
  });

  it("rejects unknown weight keys and non-integer or out-of-range thresholds", () => {
    assert.throws(() =>
      SemanticRetrievalConfigSchema.parse({
        fusion: {
          weights: {
            fts: 1,
            vector: 1,
            legacyFallback: 1,
            overlay: 1,
            other: 1,
          },
        },
      }),
    );
    for (const threshold of [-1, 1.5, 1001]) {
      assert.throws(() =>
        SemanticRetrievalConfigSchema.parse({
          fusion: { partialCoverageThresholdPermille: threshold },
        }),
      );
    }
  });
});
