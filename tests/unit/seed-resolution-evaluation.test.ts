import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const artifactPath = join(
  process.cwd(),
  "devdocs/benchmarks/seed-resolution-evaluation-v2.json",
);
const corpusPath = join(
  process.cwd(),
  "devdocs/benchmarks/seed-resolution-corpus-v2.json",
);

const expectedCaseIds = [
  "debug-precise-feedback-boost",
  "debug-precise-executor-card-rung",
  "debug-precise-planner-budget",
  "debug-broad-entity-search-fallback",
];

describe("Seed Resolution evaluation", () => {
  it("persists the v2 two-interface hard-floor contract", () => {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
      schemaVersion: number;
      cases: Array<{
        id: string;
        expected: { sliceTokens: string[] };
      }>;
    };
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      schemaVersion: number;
      corpus: { version: number; caseCount: number };
      cases: Array<{
        id: string;
        taskType: string;
        focusPaths: string[];
        contextRetrieval: {
          rankedMentions: string[];
          recall: number;
          evidence: string;
        };
        sliceStartNodes: {
          rankedTaskTokens: Array<{ token: string; rank: number }>;
          recall: number;
          evidence: string;
        };
      }>;
      quality: {
        metric: string;
        contextRetrievalRecall: number;
        sliceStartNodeRecall: number;
      };
    };

    assert.equal(corpus.schemaVersion, 2);
    assert.deepEqual(corpus.cases.map(({ id }) => id), expectedCaseIds);
    assert.equal(artifact.schemaVersion, 2);
    assert.equal(artifact.corpus.version, 2);
    assert.equal(artifact.corpus.caseCount, 4);
    assert.deepEqual(artifact.cases.map(({ id }) => id), expectedCaseIds);

    const plannerCorpusCase = corpus.cases.find(
      ({ id }) => id === "debug-precise-planner-budget",
    );
    const plannerArtifactCase = artifact.cases.find(
      ({ id }) => id === "debug-precise-planner-budget",
    );
    assert.ok(plannerCorpusCase);
    assert.ok(plannerArtifactCase);
    assert.ok(plannerCorpusCase.expected.sliceTokens.includes("hotpath"));
    assert.ok(
      plannerArtifactCase.sliceStartNodes.rankedTaskTokens.some(
        ({ token }) => token === "hotpath.",
      ),
    );
    assert.deepEqual(Object.keys(artifact.quality), [
      "metric",
      "contextRetrievalRecall",
      "sliceStartNodeRecall",
    ]);
    assert.equal(
      artifact.quality.metric,
      "labeled seed recall within each retained retrieval interface",
    );
    assert.equal(artifact.quality.contextRetrievalRecall, 1);
    assert.equal(artifact.quality.sliceStartNodeRecall, 1);
    for (const item of artifact.cases) {
      assert.deepEqual(Object.keys(item), [
        "id",
        "taskType",
        "focusPaths",
        "contextRetrieval",
        "sliceStartNodes",
      ]);
      assert.deepEqual(Object.keys(item.contextRetrieval), [
        "rankedMentions",
        "recall",
        "evidence",
      ]);
      assert.deepEqual(Object.keys(item.sliceStartNodes), [
        "rankedTaskTokens",
        "recall",
        "evidence",
      ]);
      assert.equal(item.contextRetrieval.recall, 1, item.id);
      assert.equal(item.sliceStartNodes.recall, 1, item.id);
    }
  });

  it("keeps the checked artifact byte-stable", () => {
    const before = readFileSync(artifactPath, "utf8");

    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/evaluate-seed-resolution.ts", "--check"],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    assert.equal(readFileSync(artifactPath, "utf8"), before);
  });
});
