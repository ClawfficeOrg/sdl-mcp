import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEntityEvidence,
  coverageAdjustedFusionWeights,
  rrfFuse,
  rrfFuseEntities,
  type EntitySourceRanking,
  type FusionWeights,
  type SourceRanking,
} from "../../dist/retrieval/fusion.js";
import * as retrievalFusion from "../../dist/retrieval/fusion.js";

const equalWeights: FusionWeights = {
  fts: 1,
  vector: 1,
  legacyFallback: 1,
  overlay: 1,
};

function ranking(
  source: SourceRanking["source"],
  entries: Array<readonly [string, number]>,
): SourceRanking {
  return {
    source,
    ranks: new Map(entries),
    candidateCount: entries.length,
  };
}

function entityRanking(
  source: EntitySourceRanking["source"],
  entityType: EntitySourceRanking["entityType"],
  entries: Array<readonly [string, number]>,
): EntitySourceRanking {
  return {
    source,
    entityType,
    ranks: new Map(entries),
    candidateCount: entries.length,
  };
}

describe("weighted retrieval fusion", () => {
  it("scales only the vector lane by integer coverage permille", () => {
    assert.deepEqual(coverageAdjustedFusionWeights(equalWeights, 400), {
      ...equalWeights,
      vector: 0.4,
    });
    assert.equal(coverageAdjustedFusionWeights(equalWeights, -1).vector, 0);
    assert.equal(coverageAdjustedFusionWeights(equalWeights, 1001).vector, 1);
  });

  it("uses logical lane weights when ordering candidates", () => {
    const results = rrfFuse(
      [
        ranking("fts", [["lexical", 2]]),
        ranking("vector:jinacode", [["semantic", 1]]),
      ],
      0,
      10,
      { weights: { ...equalWeights, fts: 3 } },
    );

    assert.deepEqual(
      results.map((item) => item.symbolId),
      ["lexical", "semantic"],
    );
  });

  it("collapses all vector models into one best-rank contribution", () => {
    const results = rrfFuse(
      [
        ranking("fts", [["a-lexical", 1]]),
        ranking("vector:jinacode", [["z-multi-model", 1]]),
        ranking("vector:nomic", [["z-multi-model", 1]]),
      ],
      60,
      10,
      { weights: equalWeights },
    );

    assert.deepEqual(
      results.map((item) => item.symbolId),
      ["a-lexical", "z-multi-model"],
    );
    assert.deepEqual(results[1].sourceRanks, {
      "vector:jinacode": 1,
      "vector:nomic": 1,
    });
  });

  it("renormalizes weights over logical lanes that are present", () => {
    const ftsOnly = rrfFuse(
      [ranking("fts", [["candidate", 1]])],
      60,
      10,
      { weights: { ...equalWeights, fts: 1, vector: 9 } },
    );
    const bothLanes = rrfFuse(
      [
        ranking("fts", [["candidate", 1]]),
        ranking("vector:nomic", [["candidate", 1]]),
      ],
      60,
      10,
      { weights: { ...equalWeights, fts: 1, vector: 9 } },
    );

    assert.equal(ftsOnly[0].score, 1 / 61);
    assert.equal(bothLanes[0].score, 1 / 61);
  });

  it("emits absent pins before Tier-1 candidates in lexical order", () => {
    const results = rrfFuse(
      [ranking("fts", [["ordinary", 1]])],
      60,
      10,
      { weights: equalWeights, pinnedIds: ["z-pin", "a-pin"] },
    );

    assert.deepEqual(
      results.map((item) => item.symbolId),
      ["a-pin", "z-pin", "ordinary"],
    );
    assert.deepEqual(results[0].sourceRanks, {});
  });

  it("quantizes comparisons before the lexical stable-ID tie-break", () => {
    const results = rrfFuse(
      [
        ranking("overlay", [["z", 1]]),
        ranking("fts", [["a", 1]]),
      ],
      60,
      10,
      {
        weights: {
          ...equalWeights,
          overlay: 1 + 1e-14,
        },
      },
    );

    assert.deepEqual(
      results.map((item) => item.symbolId),
      ["a", "z"],
    );
  });

  it("is stable across ranking and map permutations with deterministic provenance", () => {
    const first = rrfFuse(
      [
        ranking("vector:nomic", [["shared", 1], ["other", 2]]),
        ranking("fts", [["shared", 2], ["other", 1]]),
        ranking("vector:jinacode", [["shared", 1]]),
      ],
      60,
      10,
      { weights: equalWeights },
    );
    const second = rrfFuse(
      [
        ranking("vector:jinacode", [["shared", 1]]),
        ranking("fts", [["other", 1], ["shared", 2]]),
        ranking("vector:nomic", [["other", 2], ["shared", 1]]),
      ],
      60,
      10,
      { weights: equalWeights },
    );

    assert.deepEqual(second, first);
    const shared = first.find((item) => item.symbolId === "shared");
    assert.ok(shared);
    assert.deepEqual(shared.sourceRanks, {
      fts: 2,
      "vector:jinacode": 1,
      "vector:nomic": 1,
    });
    assert.equal(shared.source, "vector:jinacode");
  });
});

describe("unified context candidate fusion", () => {
  function contextFusion(): (
    rankings: EntitySourceRanking[],
    symbolIdsByFileId: ReadonlyMap<string, readonly string[]>,
    k: number,
    limit: number,
    options: {
      weights: FusionWeights;
      coveragePermille: {
        symbolVector: number;
        fileSummaryVector: number;
      };
      pinnedIds?: readonly string[];
    },
  ) => Array<{
    symbolId: string;
    sourceRanks: Record<string, number>;
    provenance: {
      symbol?: Record<string, number>;
      fileSummary?: Record<string, number>;
    };
  }> {
    const candidateFusion = Reflect.get(
      retrievalFusion,
      "rrfFuseContextCandidates",
    );
    assert.equal(typeof candidateFusion, "function");
    return candidateFusion;
  }

  it("jointly weights symbol and mapped FileSummary source rankings", () => {
    const rankings = [
      entityRanking("fts", "symbol", [["lexical", 1]]),
      entityRanking("vector:jinacode", "symbol", [["symbol-vector", 1]]),
      entityRanking("fts", "fileSummary", [["file-fts", 1]]),
      entityRanking("vector:nomic", "fileSummary", [["file-vector", 5]]),
    ];
    const mapping = new Map<string, readonly string[]>([
      ["file-fts", ["summary-lexical"]],
      ["file-vector", ["summary-semantic"]],
    ]);

    const highVector = contextFusion()(
      rankings,
      mapping,
      60,
      10,
      {
        weights: { ...equalWeights, vector: 10 },
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
      },
    );
    assert.equal(highVector[0]?.symbolId, "symbol-vector");
    assert.ok(
      highVector.findIndex(
        (item) => item.symbolId === "summary-semantic",
      ) <
        highVector.findIndex((item) => item.symbolId === "lexical"),
      "a weighted FileSummary vector candidate must rank above lexical",
    );

    const lowFileSummaryCoverage = contextFusion()(
      rankings.filter(
        (ranking) =>
          ranking.entityType === "fileSummary" ||
          ranking.source === "fts",
      ),
      mapping,
      60,
      10,
      {
        weights: { ...equalWeights, vector: 10 },
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 10,
        },
      },
    );
    assert.ok(
      lowFileSummaryCoverage.findIndex(
        (item) => item.symbolId === "lexical",
      ) <
        lowFileSummaryCoverage.findIndex(
          (item) => item.symbolId === "summary-semantic",
        ),
      "coverage adjustment must be renormalized over the present lanes",
    );
  });

  it("collapses vector models while preserving per-lane source ranks", () => {
    const results = contextFusion()(
      [
        entityRanking("fts", "symbol", [["shared", 2]]),
        entityRanking("vector:jinacode", "symbol", [["shared", 1]]),
        entityRanking("vector:nomic", "fileSummary", [["file", 1]]),
      ],
      new Map([["file", ["shared"]]]),
      60,
      10,
      {
        weights: equalWeights,
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
      },
    );

    assert.deepEqual(results[0], {
      ...results[0],
      symbolId: "shared",
      sourceRanks: {
        fts: 2,
        "vector:jinacode": 1,
        "vector:nomic": 1,
      },
      provenance: {
        symbol: {
          fts: 2,
          "vector:jinacode": 1,
        },
        fileSummary: {
          "vector:nomic": 1,
        },
      },
    });
  });

  it("maps FileSummary ties deterministically regardless of input order", () => {
    const rankings = [
      entityRanking("fts", "fileSummary", [
        ["file-b", 1],
        ["file-a", 1],
      ]),
    ];
    const first = contextFusion()(
      rankings,
      new Map([
        ["file-b", ["zeta", "beta"]],
        ["file-a", ["alpha"]],
      ]),
      60,
      10,
      {
        weights: equalWeights,
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
      },
    );
    const second = contextFusion()(
      [...rankings].reverse(),
      new Map([
        ["file-a", ["alpha"]],
        ["file-b", ["beta", "zeta"]],
      ]),
      60,
      10,
      {
        weights: equalWeights,
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
      },
    );

    assert.deepEqual(second, first);
    assert.deepEqual(
      first.map((item) => item.symbolId),
      ["alpha", "beta", "zeta"],
    );
  });

  it("sorts pinned exact candidates ahead inside the shared fusion", () => {
    const results = contextFusion()(
      [
        entityRanking("fts", "symbol", [["lexical-winner", 1]]),
        entityRanking("exactIdentifier" as never, "symbol", [
          ["pinned-exact", 10],
          ["derived-exact", 1],
        ]),
      ],
      new Map(),
      60,
      10,
      {
        weights: equalWeights,
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
        pinnedIds: ["pinned-exact"],
      },
    );

    assert.equal(results[0]?.symbolId, "pinned-exact");
    assert.equal(
      results[0]?.provenance.symbol?.exactIdentifier,
      10,
    );
  });
});

describe("weighted entity fusion", () => {
  it("keeps identical IDs in different entity namespaces", () => {
    const results = rrfFuseEntities(
      [
        entityRanking("fts", "symbol", [["same-id", 1]]),
        entityRanking("fts", "fileSummary", [["same-id", 1]]),
      ],
      60,
      10,
      { weights: equalWeights },
    );

    assert.deepEqual(
      results.map(({ entityType, entityId }) => [entityType, entityId]),
      [
        ["fileSummary", "same-id"],
        ["symbol", "same-id"],
      ],
    );
  });

  it("uses typed deterministic evidence keys for shared physical sources", () => {
    const rankings = [
      entityRanking("fts", "symbol", [["same-id", 1]]),
      entityRanking("fts", "fileSummary", [["same-id", 1]]),
    ];
    const fused = rrfFuseEntities(rankings, 60, 10, {
      weights: equalWeights,
    });
    const evidence = buildEntityEvidence(rankings, fused, 0);

    assert.deepEqual(evidence.topRanksPerSource, {
      "fts:fileSummary": [1],
      "fts:symbol": [2],
    });
    assert.deepEqual(evidence.candidateCountPerSource, { fts: 2 });

    const reversed = buildEntityEvidence(
      [...rankings].reverse(),
      rrfFuseEntities([...rankings].reverse(), 60, 10, {
        weights: equalWeights,
      }),
      0,
    );
    assert.deepEqual(reversed, evidence);
  });

  it("emits typed entity pins even when ordinary lanes do not contain them", () => {
    const results = rrfFuseEntities([], 60, 10, {
      weights: equalWeights,
      pinnedItems: [
        { entityType: "symbol", entityId: "same-id" },
        { entityType: "fileSummary", entityId: "same-id" },
      ],
    });

    assert.deepEqual(
      results.map(({ entityType, entityId }) => [entityType, entityId]),
      [
        ["fileSummary", "same-id"],
        ["symbol", "same-id"],
      ],
    );
  });
});
