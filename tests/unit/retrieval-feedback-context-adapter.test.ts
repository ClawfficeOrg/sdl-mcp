import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("threads the request context through feedback entity retrieval", async (t) => {
  const orchestrator = await import("../../dist/retrieval/orchestrator.js");
  const feedbackDb = await import("../../dist/db/ladybug-feedback.js");
  const context = orchestrator.createRetrievalQueryContext();
  context.healthPromises.set(
    "repo",
    Promise.resolve({
      fts: true,
      fileSummaryFts: true,
      vectorNomic: true,
      vectorJinaCode: true,
      coveragePermille: { symbolVector: 1000, fileSummaryVector: 1000 },
    }),
  );
  context.embeddingPromises.set(
    "nomic-embed-text-v1.5\u0000query: shared",
    Promise.resolve([0.1]),
  );

  let nestedContext: unknown;
  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      ...orchestrator,
      entitySearch: async (_options: unknown, queryContext: unknown) => {
        nestedContext = queryContext;
        return {
          results: [
            {
              entityType: "agentFeedback",
              entityId: "feedback-1",
              score: 0.5,
              source: "fts",
              sourceRanks: { fts: 1 },
            },
          ],
        };
      },
    },
  });
  t.mock.module("../../dist/db/ladybug-feedback.js", {
    namedExports: {
      ...feedbackDb,
      hasAgentFeedbackForRepo: async () => true,
      getAgentFeedbackBoostRows: async () => [
        {
          feedbackId: "feedback-1",
          usefulSymbolsJson: "[\"symbol-1\"]",
          missingSymbolsJson: "[]",
          taskType: null,
        },
      ],
    },
  });

  const { queryFeedbackBoosts } = await import(
    "../../dist/retrieval/feedback-boost.js?shared-query-context"
  );
  const result = await queryFeedbackBoosts(
    {} as Connection,
    {
      repoId: "repo",
      query: "shared",
    },
    context,
  );

  assert.strictEqual(nestedContext, context);
  assert.equal(context.healthPromises.size, 1);
  assert.equal(context.embeddingPromises.size, 1);
  assert.equal(result.boosts.get("symbol-1"), 0.15);
});
