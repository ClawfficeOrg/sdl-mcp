import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contextEngine } from "../../dist/agent/context-engine.js";
import type { ContextResult } from "../../dist/agent/types.js";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { createActionMap } from "../../dist/gateway/router.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import {
  calculateContextRawEquivalentTokens,
  handleAgentContext,
} from "../../dist/mcp/tools/context.js";
import {
  _setResponseRepoExistsForTesting,
  handleResponseGet,
} from "../../dist/mcp/tools/response.js";
import { maybeStoreLargeResponse } from "../../dist/runtime/response-artifacts.js";

const originalSdlConfig = process.env.SDL_CONFIG;
const originalBuildContext = contextEngine.buildContext.bind(contextEngine);
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-context-response-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  _setResponseRepoExistsForTesting();
  contextEngine.buildContext = originalBuildContext;
  if (originalSdlConfig === undefined) {
    delete process.env.SDL_CONFIG;
  } else {
    process.env.SDL_CONFIG = originalSdlConfig;
  }
  invalidateConfigCache();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("sdl.context response artifacts", () => {
  it("stores context responses behind response.get without storing _rawContext", async () => {
    _setResponseRepoExistsForTesting(async () => true);
    const baseDir = makeTempDir();
    const configPath = join(baseDir, "sdlmcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: baseDir }],
        policy: {},
        runtime: { artifactBaseDir: baseDir },
      }),
      "utf-8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    contextEngine.buildContext = async (): Promise<ContextResult> => ({
      taskId: "task-a",
      taskType: "explain",
      actionsTaken: [],
      path: {
        rungs: ["card"],
        estimatedTokens: 10,
        estimatedDurationMs: 1,
        reasoning: "test",
      },
      finalEvidence: [
        {
          type: "symbolCard",
          reference: "sym-a",
          summary: "A".repeat(2048),
          timestamp: Date.now(),
        },
      ],
      summary: "large context response",
      success: true,
      truncation: {
        originalTokens: 6000,
        truncatedTokens: 512,
        fieldsAffected: ["finalEvidence"],
        continuationHandle: "cont-context-response",
        continuationAction: "workflowContinuationGet",
      },
      metrics: {
        totalDurationMs: 1,
        totalTokens: 6000,
        totalActions: 1,
        successfulActions: 1,
        failedActions: 0,
        cacheHits: 0,
      },
    });

    const response = await handleAgentContext({
      repoId: "repo-a",
      taskType: "explain",
      taskText: "explain the large response",
      responseMode: "handle",
      wireFormat: "json",
    }) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(response.action, "response.get");
    assert.equal((response.metadata as Record<string, unknown>).toolName, "sdl.context");
    const expectedRawTokens = calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: 1,
      resolvedEvidenceCount: 0,
    });

    assert.deepEqual((response as Record<string, unknown>)._rawContext, {
      rawTokens: expectedRawTokens,
    });

    const full = await handleResponseGet({
      repoId: "repo-a",
      handle: response.handle,
      full: true,
    }) as Record<string, unknown>;
    const content = full.content as Record<string, unknown>;
    assert.equal(content.taskId, "task-a");
    assert.equal(content._rawContext, undefined);
    assert.deepEqual(content.truncation, {
      originalTokens: 6000,
      truncatedTokens: 512,
      fieldsAffected: ["finalEvidence"],
      continuationHandle: "cont-context-response",
      continuationAction: "workflowContinuationGet",
    });
  });

  it("keeps invalid response.get recovery actionable through workflow projection", async () => {
    _setResponseRepoExistsForTesting(async () => true);
    const baseDir = makeTempDir();
    const configPath = join(baseDir, "sdlmcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: baseDir }],
        policy: {},
        runtime: { artifactBaseDir: baseDir },
      }),
      "utf-8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: {
        summary: "compact summary",
        finalEvidence: [{ reference: "symbol:target" }],
      },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "fedcbafedcbafedc",
    });
    assert.equal(stored.responseMode, "handle");
    const handle = stored.payload.handle;
    const actionMap = createActionMap(undefined, { memoryTools: false });
    const workflowConfig = {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50_000,
      maxWorkflowDurationMs: 60_000,
      ladderValidation: "warn" as const,
      etagCaching: true,
    };
    const invalidRequest: ParsedWorkflowRequest = {
      repoId: "repo-a",
      steps: [{
        fn: "responseGet",
        action: "response.get",
        args: { handle, jsonPath: "missing.path" },
      }],
      onError: "continueAll",
    };

    const rawFailure = await executeWorkflow(
      invalidRequest,
      actionMap,
      workflowConfig,
    );
    assert.deepEqual(rawFailure.results[0].failureTrace?.details?.details, [
      "Available top-level keys: finalEvidence, summary",
    ]);
    const projectedFailure = projectToolResultForModelContent(
      "sdl.workflow",
      rawFailure as unknown as Record<string, unknown>,
      {},
    ) as { results: Array<{ failureTrace?: { details?: Record<string, unknown> } }> };
    const recovery = projectedFailure.results[0].failureTrace?.details;
    assert.deepEqual(recovery?.details, [
      "Available top-level keys: finalEvidence, summary",
    ]);
    assert.equal(
      recovery?.fallbackRationale,
      "Retry response.get against the same artifact handle with an available JSON path.",
    );
    assert.deepEqual(recovery?.nextCalls, [{
      action: "response.get",
      args: {
        repoId: "repo-a",
        handle,
        jsonPath: "finalEvidence",
        offset: 0,
        limit: 5,
      },
    }]);

    const retryRequest: ParsedWorkflowRequest = {
      ...invalidRequest,
      steps: [{
        fn: "responseGet",
        action: "response.get",
        args: { handle, jsonPath: "finalEvidence", offset: 0, limit: 5 },
      }],
    };
    const retry = await executeWorkflow(retryRequest, actionMap, workflowConfig);
    assert.equal(retry.results[0].status, "ok");
    assert.equal((retry.results[0].result as Record<string, unknown>).handle, handle);
  });
});
