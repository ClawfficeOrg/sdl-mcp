import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectResultForUsageAccounting,
  projectToolResultForModelContent,
  projectWorkflowChildResultForModel,
} from "../../dist/mcp/context-response-projection.js";

describe("context-response-projection", () => {
  it("projects canonical v2 context without retaining internal accounting fields", () => {
    const rawContext = { rawTokens: 512 };
    const result = {
      status: "complete",
      taskType: "explain",
      retrieval: {
        mode: "hybrid",
        lanesUsed: ["lexical", "graph"],
        coveragePermille: 1000,
        confidencePermille: 900,
      },
      evidence: [{
        symbolId: "sym:1",
        rung: "card",
        card: {
          symbolId: "sym:1",
          name: "example",
          file: "src/example.ts",
        },
      }],
      edges: [],
      omitted: {
        tier0: [],
        tier1Count: 0,
        optionalRungCount: 0,
      },
      nextActions: [],
      etag: "etag-1",
      _packedStats: { rawBytes: 100 },
      _rawContext: rawContext,
    };

    const projected = projectToolResultForModelContent(
      "sdl.context",
      result,
    ) as Record<string, unknown>;
    assert.deepEqual(projected, {
      status: "complete",
      taskType: "explain",
      retrieval: result.retrieval,
      evidence: result.evidence,
      edges: [],
      omitted: result.omitted,
      nextActions: [],
    });

    const accounting = projectResultForUsageAccounting(
      "sdl.context",
      result,
    );
    assert.deepEqual(accounting, { ...projected, _rawContext: rawContext });
  });

  it("projects continuation data through the generic workflow path", () => {
    const result = {
      data: {
        status: "complete",
        evidence: [{ symbolId: "sym:1", rung: "card" }],
        generatedAt: "2026-07-27T00:00:00.000Z",
        etag: "etag-1",
        _rawContext: { rawTokens: 128 },
      },
    };

    const projected = projectWorkflowChildResultForModel(
      "workflowContinuationGet",
      result,
      {},
      {},
    );
    assert.deepEqual(projected, {
      data: {
        status: "complete",
        evidence: [{ symbolId: "sym:1", rung: "card" }],
      },
    });
    assert.deepEqual(result.data.evidence, [{
      symbolId: "sym:1",
      rung: "card",
    }]);
  });

  it("compacts workflow telemetry unless explicitly requested", () => {
    const result = {
      results: [{
        stepIndex: 0,
        fn: "repoStatus",
        status: "ok",
        tokens: 40,
        durationMs: 5,
        result: {
          repoId: "repo-1",
          status: "ready",
          graphIntegrityState: "verified",
          lastIndexedAt: "2026-07-27T00:00:00.000Z",
        },
      }],
      totalTokens: 40,
      durationMs: 5,
    };

    assert.deepEqual(
      projectToolResultForModelContent("sdl.workflow", result),
      {
        results: [{
          fn: "repoStatus",
          result: {
            repoId: "repo-1",
          },
        }],
      },
    );

    const detailed = projectToolResultForModelContent(
      "sdl.workflow",
      result,
      { includeTelemetry: true },
    ) as Record<string, unknown>;
    assert.equal(detailed.totalTokens, 40);
    assert.equal(detailed.durationMs, 5);
  });

  it("keeps validation errors out of success-only projectors", () => {
    const error = {
      error: {
        code: "INVALID_ARGS",
        message: "Unknown key: options",
      },
      diagnostics: { ignored: true },
    };

    assert.deepEqual(
      projectToolResultForModelContent("sdl.action.search", error),
      { error: error.error },
    );
  });
});
