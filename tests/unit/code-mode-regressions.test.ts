import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateManual,
  invalidateManualCache,
} from "../../dist/code-mode/manual-generator.js";
import {
  registerActionSearchTool,
} from "../../dist/code-mode/index.js";
import { SDL_MCP_SERVER_INSTRUCTIONS } from "../../dist/mcp/server-instructions.js";
import { resolveRefs } from "../../dist/code-mode/ref-resolver.js";
import { WorkflowRequestSchema } from "../../dist/code-mode/types.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("code-mode regressions", () => {
  let tmpDir: string;

  before(() => {
    // Create a config with memory enabled so manual contains all signatures
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-regressions-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: [{ repoId: "test", rootPath: tmpDir, memory: { enabled: true } }],
      policy: {},
    }));
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
  });

  after(() => {
    if (originalSdlConfig !== undefined) {
      process.env.SDL_CONFIG = originalSdlConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    invalidateConfigCache();
    invalidateManualCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hardcoded manual signatures match the live tool contracts", () => {
    invalidateManualCache();
    const manual = generateManual();

    // contextSummary was removed from the API
    assert.match(
      manual,
      /function codeHotPath\(p: \{ symbolId: string; identifiersToFind: string\[]; contextLines\?: number; ifNoneMatch\?: string \}\): \{ excerpt: string; foundIdentifiers: string\[]; etag: string \} \| \{ notModified: true; etag: string \}/,
    );
    assert.match(
      manual,
      /function repoStatus\(p\?: \{ detail\?: "minimal" \| "standard" \| "full"; includeTelemetry\?: boolean \}\): \{ status: object \}/,
    );
    assert.match(
      manual,
      /function repoOverview\(p: \{ level\?: "stats" \| "directories" \| "full"; ifNoneMatch\?: string \}\): object/,
    );
    // agentContext was removed from the API
    assert.match(
      manual,
      /function prRiskAnalyze\(p: \{ fromVersion: string; toVersion: string; riskThreshold\?: number \}\)/,
    );
    assert.match(
      manual,
      /function memoryStore\(p: \{ type: "decision"\|"bugfix"\|"task_context"\|"pattern"\|"convention"\|"architecture"\|"performance"\|"security"; title: string; content: string; tags\?: string\[]; symbolIds\?: string\[]; fileRelPaths\?: string\[] \}\)/,
    );
    assert.match(
      manual,
      /function usageStats\(p: \{ scope\?: "session" \| "history" \| "lifetime" \| "both" \| "all"; since\?: string; limit\?: number; persist\?: boolean; detail\?: "compact" \| "full" \}\): \{ formattedSummary: string \} \| object/,
    );
    assert.doesNotMatch(manual, /totalSdlTokens: number; totalSavedTokens: number; savingsPercent: number/);
  });


  it("does not instruct agents to call usageStats by habit", () => {
    assert.doesNotMatch(SDL_MCP_SERVER_INSTRUCTIONS, /Before completion, call `usageStats`/);
    assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /Call `usageStats` only when/);
  });
  it("action.search supports offset-based pagination", async () => {
    let handler: ((args: unknown) => Promise<unknown>) | null = null;
    let inputSchema: Record<string, unknown> | null = null;
    let outputSchema: {
      parse(value: unknown): Record<string, unknown>;
    } | null = null;

    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        toolHandler: (args: unknown) => Promise<unknown>,
        wireSchema: unknown,
        _presentation: unknown,
        toolOutputSchema: {
          parse(value: unknown): Record<string, unknown>;
        },
      ) {
        if (name === "sdl.action.search") {
          handler = toolHandler;
          inputSchema = wireSchema as Record<string, unknown>;
          outputSchema = toolOutputSchema;
        }
      },
    };

    registerActionSearchTool(fakeServer as never, { liveIndex: undefined } as never);
    assert.ok(handler);

    const firstPage = await handler({
      query: "*",
      limit: 2,
      offset: 0,
    }) as { actions: Array<{ action: string }>; total: number; hasMore: boolean };
    assert.ok(outputSchema);
    const parsedFirstPage = outputSchema.parse(firstPage);
    assert.equal(parsedFirstPage.offset, 0);
    assert.equal(parsedFirstPage.limit, 2);
    assert.equal(parsedFirstPage.nextOffset, 2);
    const parsedKeys = Object.keys(parsedFirstPage);
    const tokenEstimateIndex = parsedKeys.indexOf("tokenEstimate");
    assert.deepEqual(
      parsedKeys.slice(tokenEstimateIndex, tokenEstimateIndex + 4),
      ["tokenEstimate", "offset", "limit", "nextOffset"],
    );
    const secondPage = await handler({
      query: "*",
      limit: 2,
      offset: 1,
    }) as { actions: Array<{ action: string }>; total: number; hasMore: boolean };

    assert.equal(firstPage.actions.length, 2);
    assert.equal(secondPage.actions.length, 2);
    assert.equal(firstPage.total, secondPage.total);
    assert.equal(secondPage.hasMore, true);
    assert.notEqual(firstPage.actions[0]?.action, secondPage.actions[0]?.action);
    assert.equal(firstPage.actions[1]?.action, secondPage.actions[0]?.action);
    assert.equal(
      (inputSchema?.properties as Record<string, { maximum?: number }>).limit?.maximum,
      50,
    );
    assert.equal(
      (inputSchema?.properties as Record<string, { minimum?: number }>).offset?.minimum,
      0,
    );
  });

  it("optional workflow references resolve to undefined instead of throwing", () => {
    const resolved = resolveRefs(
      {
        symbolId: "$0.results[1]?.symbolId",
        fallback: "$0.results[0].symbolId",
      },
      [{ results: [{ symbolId: "sym-0" }] }],
    );

    assert.equal(resolved.symbolId, undefined);
    assert.equal(resolved.fallback, "sym-0");
  });
  it("preserves child projection controls outside handler args", () => {
    const parsed = WorkflowRequestSchema.parse({
      repoId: "repo",
      detail: "compact",
      steps: [{ fn: "repoStatus", args: {}, detail: "full", includeDiagnostics: true }],
    });

    assert.equal(parsed.steps[0].detail, "full");
    assert.equal(parsed.steps[0].includeDiagnostics, true);
    assert.deepEqual(parsed.steps[0].args, {});
  });
});
