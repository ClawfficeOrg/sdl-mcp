import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import * as recoveryProjection from "../../dist/code-mode/action-reference-projection.js";
import { ACTION_DEFINITION_BY_ACTION } from "../../dist/code-mode/action-catalog.js";
import { parseWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import { getActiveFnNameMap } from "../../dist/code-mode/manual-generator.js";
import {
  PolicyDenialError,
  errorToMcpResponse,
} from "../../dist/mcp/errors.js";
import { registerTools } from "../../dist/mcp/tools/index.js";
import { MCPServer } from "../../dist/server.js";
import {
  dispatchAction,
  type ActionMap,
} from "../../dist/gateway/router.js";

interface RecoveryCall {
  action: string;
  args: Record<string, unknown>;
}

interface RecoveryBuildResult {
  nextAction?: RecoveryCall;
  invalidRecoveryCount: number;
}

interface RecoveryBuilder {
  (
    candidate: unknown,
    context: {
      repoId?: string;
      advertisedTools: readonly string[];
      failedCall?: RecoveryCall;
      continuation?: {
        handle?: string;
        view?: "model" | "raw";
        cursor?: { stream: "stdout" | "stderr"; afterLine: number };
        maxBytes?: number;
      };
    },
  ): RecoveryBuildResult;
}

interface RecoveryTestingControls {
  reset(): void;
  setStrictMode(enabled: boolean): void;
  getMetrics(): { invalidRecoveryCount: number };
}

function recoveryBuilder(): RecoveryBuilder {
  const candidate = (
    recoveryProjection as Record<string, unknown>
  ).buildValidatedRecoveryAction;
  assert.equal(
    typeof candidate,
    "function",
    "recovery projection must export buildValidatedRecoveryAction",
  );
  return candidate as RecoveryBuilder;
}

function testingControls(): RecoveryTestingControls {
  const candidate = (
    recoveryProjection as Record<string, unknown>
  )._recoveryValidationTesting;
  assert.equal(
    typeof candidate,
    "object",
    "recovery projection must expose test-only strict-mode controls",
  );
  return candidate as RecoveryTestingControls;
}

afterEach(() => {
  const candidate = (
    recoveryProjection as Record<string, unknown>
  )._recoveryValidationTesting;
  if (candidate && typeof candidate === "object") {
    (candidate as RecoveryTestingControls).reset();
  }
});

describe("generated recovery validation", () => {
  it("rejects calls that cannot materialize a required repoId", () => {
    const result = recoveryBuilder()(
      { action: "sdl.repo.status", args: {} },
      { advertisedTools: ["sdl.repo.status"] },
    );

    assert.equal(result.nextAction, undefined);
    assert.equal(result.invalidRecoveryCount, 1);
  });

  it("rejects incomplete response and runtime continuation calls", () => {
    const build = recoveryBuilder();
    const missingHandle = build(
      {
        action: "sdl.response.get",
        args: { repoId: "repo", raw: true, maxBytes: 4096 },
      },
      { repoId: "repo", advertisedTools: ["sdl.response.get"] },
    );
    const missingMaxBytes = build(
      {
        action: "sdl.response.get",
        args: { repoId: "repo", handle: "artifact", raw: true },
      },
      { repoId: "repo", advertisedTools: ["sdl.response.get"] },
    );
    const missingView = build(
      {
        action: "sdl.runtime.queryOutput",
        args: {
          repoId: "repo",
          artifactHandle: "runtime-artifact",
          cursor: { stream: "stderr", afterLine: 0 },
          queryTerms: ["error"],
        },
      },
      { repoId: "repo", advertisedTools: ["sdl.runtime.queryOutput"] },
    );
    const missingCursor = build(
      {
        action: "sdl.runtime.queryOutput",
        args: {
          repoId: "repo",
          artifactHandle: "runtime-artifact",
          view: "model",
          queryTerms: ["error"],
        },
      },
      { repoId: "repo", advertisedTools: ["sdl.runtime.queryOutput"] },
    );

    for (const result of [
      missingHandle,
      missingMaxBytes,
      missingView,
      missingCursor,
    ]) {
      assert.equal(result.nextAction, undefined);
      assert.equal(result.invalidRecoveryCount, 1);
    }
  });

  it("materializes continuation args before target-schema parsing", () => {
    const build = recoveryBuilder();
    const runtime = build(
      {
        action: "sdl.runtime.queryOutput",
        args: { queryTerms: ["error"] },
      },
      {
        repoId: "repo",
        advertisedTools: ["sdl.runtime.queryOutput"],
        continuation: {
          handle: "runtime-artifact",
          view: "model",
          cursor: { stream: "stderr", afterLine: 0 },
        },
      },
    );
    const response = build(
      {
        action: "sdl.response.get",
        args: { raw: true },
      },
      {
        repoId: "repo",
        advertisedTools: ["sdl.response.get"],
        continuation: {
          handle: "response-artifact",
          maxBytes: 4096,
        },
      },
    );

    assert.deepEqual(runtime.nextAction, {
      action: "sdl.runtime.queryOutput",
      args: {
        artifactHandle: "runtime-artifact",
        contextLines: 3,
        cursor: { afterLine: 0, stream: "stderr" },
        maxExcerpts: 10,
        queryTerms: ["error"],
        repoId: "repo",
        stream: "both",
        view: "model",
      },
    });
    assert.deepEqual(response.nextAction, {
      action: "sdl.response.get",
      args: {
        full: false,
        handle: "response-artifact",
        maxBytes: 4096,
        offsetBytes: 0,
        raw: true,
        repoId: "repo",
      },
    });
  });

  it("executes a byte-stable flat recovery through the real dispatch spine", async () => {
    const build = recoveryBuilder();
    const context = {
      repoId: "repo",
      advertisedTools: ["sdl.repo.status", "sdl.workflow"],
      failedCall: {
        action: "sdl.symbol.search",
        args: { repoId: "repo", query: "missing" },
      },
    };
    const first = build(
      { action: "sdl.repo.status", args: {} },
      context,
    );
    const second = build(
      { args: {}, action: "sdl.repo.status" },
      context,
    );

    assert.equal(first.invalidRecoveryCount, 0);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.nextAction, {
      action: "sdl.repo.status",
      args: {
        detail: "compact",
        includeTelemetry: false,
        repoId: "repo",
        surfaceMemories: false,
      },
    });

    const definition = ACTION_DEFINITION_BY_ACTION["repo.status"];
    assert.ok(definition);
    const dispatchedArgs: string[] = [];
    const actionMap: ActionMap = {
      "repo.status": {
        schema: definition.schema,
        definition,
        handler: async (args: unknown) => {
          const bytes = JSON.stringify(args);
          assert.ok(new TextEncoder().encode(bytes).byteLength <= 1024);
          dispatchedArgs.push(bytes);
          return { accepted: true, args };
        },
      },
    };
    const executeRecovery = async (
      result: RecoveryBuildResult,
    ): Promise<unknown> => {
      assert.ok(result.nextAction);
      const { action, args } = result.nextAction;
      assert.match(action, /^sdl\./);
      return dispatchAction(
        action.slice("sdl.".length),
        args,
        actionMap,
        { kind: "flat-mcp" },
      );
    };

    const firstBytes = JSON.stringify(first.nextAction);
    const secondBytes = JSON.stringify(second.nextAction);
    assert.equal(firstBytes, secondBytes);
    const firstExecution = await executeRecovery(first);
    const secondExecution = await executeRecovery(second);
    assert.equal(
      JSON.stringify(firstExecution),
      JSON.stringify(secondExecution),
    );
    assert.equal(dispatchedArgs.length, 2);
    assert.equal(dispatchedArgs[0], dispatchedArgs[1]);
  });

  it("rejects a valid flat target when no executable surface is advertised", () => {
    const result = recoveryBuilder()(
      { action: "sdl.repo.status", args: {} },
      {
        repoId: "repo",
        advertisedTools: ["sdl.action.search"],
      },
    );

    assert.equal(result.nextAction, undefined);
    assert.equal(result.invalidRecoveryCount, 1);
  });

  it("executes a byte-stable self-contained workflow without ambient context", async () => {
    const build = recoveryBuilder();
    const candidate = {
      action: "sdl.symbol.search",
      args: { query: "replacement" },
    };
    const context = {
      repoId: "repo",
      advertisedTools: ["sdl.workflow"],
      failedCall: {
        action: "sdl.symbol.search",
        args: { repoId: "repo", query: "missing" },
      },
    };

    const first = build(candidate, context);
    const second = build(
      {
        args: { query: "replacement" },
        action: "sdl.symbol.search",
      },
      context,
    );

    assert.equal(first.invalidRecoveryCount, 0);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.nextAction, {
      action: "sdl.workflow",
      args: {
        includeTelemetry: false,
        onError: "continue",
        repoId: "repo",
        steps: [
          {
            args: {
              query: "replacement",
              wireFormat: "auto",
            },
            fn: "symbolSearch",
          },
        ],
      },
    });

    const parsed = parseWorkflowRequest(first.nextAction?.args);
    const repeatedParsed = parseWorkflowRequest(second.nextAction?.args);
    assert.equal(parsed.ok, true);
    assert.equal(repeatedParsed.ok, true);
    if (!parsed.ok || !repeatedParsed.ok) {
      assert.fail("generated workflow recovery must parse independently");
    }

    const definition = ACTION_DEFINITION_BY_ACTION["symbol.search"];
    assert.ok(definition);
    const dispatchedArgs: string[] = [];
    const actionMap: ActionMap = {
      "symbol.search": {
        schema: definition.schema,
        definition,
        handler: async (args: unknown) => {
          const bytes = JSON.stringify(args);
          assert.ok(new TextEncoder().encode(bytes).byteLength <= 2048);
          dispatchedArgs.push(bytes);
          return { matched: true, args };
        },
      },
    };
    const workflowConfig = {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50_000,
      maxWorkflowDurationMs: 60_000,
      ladderValidation: "warn" as const,
      etagCaching: true,
    };

    const firstExecution = await executeWorkflow(
      parsed.request,
      actionMap,
      workflowConfig,
    );
    const secondExecution = await executeWorkflow(
      repeatedParsed.request,
      actionMap,
      workflowConfig,
    );

    assert.equal(firstExecution.results[0]?.status, "ok");
    assert.equal(secondExecution.results[0]?.status, "ok");
    assert.equal(
      JSON.stringify(firstExecution.results[0]?.result),
      JSON.stringify(secondExecution.results[0]?.result),
    );
    assert.equal(
      JSON.stringify(first.nextAction),
      JSON.stringify(second.nextAction),
    );
    assert.deepEqual(dispatchedArgs, [
      JSON.stringify(firstExecution.results[0]?.result &&
        (firstExecution.results[0]?.result as Record<string, unknown>).args),
      JSON.stringify(secondExecution.results[0]?.result &&
        (secondExecution.results[0]?.result as Record<string, unknown>).args),
    ]);
    assert.doesNotMatch(JSON.stringify(first.nextAction), /\$\d+/);
  });

  it("rejects unknown actions and args rejected by the target Zod schema", () => {
    const build = recoveryBuilder();
    const unknown = build(
      { action: "sdl.unknown.action", args: {} },
      { repoId: "repo", advertisedTools: ["sdl.workflow"] },
    );
    const invalidArgs = build(
      { action: "sdl.repo.register", args: {} },
      { repoId: "repo", advertisedTools: ["sdl.repo.register"] },
    );

    assert.equal(unknown.nextAction, undefined);
    assert.equal(invalidArgs.nextAction, undefined);
    assert.equal(unknown.invalidRecoveryCount, 1);
    assert.equal(invalidArgs.invalidRecoveryCount, 1);
  });

  it("rejects an identical logical retry but permits a cause-relevant change", () => {
    const build = recoveryBuilder();
    const failedCall = {
      action: "sdl.symbol.search",
      args: { repoId: "repo", query: "missing" },
    };
    const identical = build(
      { action: "sdl.symbol.search", args: { query: "missing" } },
      {
        repoId: "repo",
        advertisedTools: ["sdl.symbol.search"],
        failedCall,
      },
    );
    const presentationOnly = build(
      {
        action: "sdl.symbol.search",
        args: { query: "missing", detail: "full" },
      },
      {
        repoId: "repo",
        advertisedTools: ["sdl.symbol.search"],
        failedCall,
      },
    );
    const changed = build(
      { action: "sdl.symbol.search", args: { query: "replacement" } },
      {
        repoId: "repo",
        advertisedTools: ["sdl.symbol.search"],
        failedCall,
      },
    );

    assert.equal(identical.nextAction, undefined);
    assert.equal(presentationOnly.nextAction, undefined);
    assert.equal(changed.invalidRecoveryCount, 0);
    assert.equal(changed.nextAction?.action, "sdl.symbol.search");
  });

  it("omits only invalid nextAction while preserving a safe error", () => {
    const projected = recoveryProjection.projectExclusiveCodeModeRecovery(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The request could not be completed.",
        },
        nextAction: {
          action: "sdl.response.get",
          args: { handle: "artifact" },
        },
      },
      "repo",
    ) as Record<string, unknown>;

    assert.deepEqual(projected.error, {
      code: "VALIDATION_ERROR",
      message: "The request could not be completed.",
    });
    assert.equal("nextAction" in projected, false);
    assert.equal("invalidRecoveryCount" in projected, false);
    assert.equal(
      "invalidRecoveryCount" in (projected.error as Record<string, unknown>),
      false,
    );
    assert.equal(testingControls().getMetrics().invalidRecoveryCount, 1);
  });

  it("throws only in test strict mode and counts production omissions", () => {
    const controls = testingControls();
    const build = recoveryBuilder();

    const production = build(
      { action: "sdl.unknown.action", args: {} },
      { repoId: "repo", advertisedTools: ["sdl.workflow"] },
    );
    assert.equal(production.nextAction, undefined);
    assert.equal(controls.getMetrics().invalidRecoveryCount, 1);

    controls.setStrictMode(true);
    assert.throws(
      () =>
        build(
          { action: "sdl.unknown.action", args: {} },
          { repoId: "repo", advertisedTools: ["sdl.workflow"] },
        ),
      /Invalid generated recovery/,
    );
  });

  it("rejects inherited action discriminants and preserves nested __proto__ as data", () => {
    const build = recoveryBuilder();
    const inherited = Object.assign(
      Object.create({ action: "sdl.repo.status" }) as Record<string, unknown>,
      { args: {} },
    );
    const inheritedResult = build(inherited, {
      repoId: "repo",
      advertisedTools: ["sdl.repo.status"],
    });
    const protoCandidate = JSON.parse(
      '{"action":"sdl.file.write","args":{"repoId":"repo","filePath":"fixture.json","jsonPath":"payload","jsonValue":{"__proto__":{"polluted":true},"detail":"payload"},"createBackup":false}}',
    ) as unknown;
    const protoResult = build(protoCandidate, {
      repoId: "repo",
      advertisedTools: ["sdl.file.write"],
    });
    const jsonValue = (
      protoResult.nextAction?.args.jsonValue ?? {}
    ) as Record<string, unknown>;

    assert.deepEqual(
      {
        inheritedAction: inheritedResult.nextAction,
        inheritedInvalidCount: inheritedResult.invalidRecoveryCount,
        jsonValueHasOwnProto: Object.hasOwn(jsonValue, "__proto__"),
        jsonValuePrototypeIsDefault:
          Object.getPrototypeOf(jsonValue) === Object.prototype,
        inheritedPollution: jsonValue.polluted,
        ownProtoValue: jsonValue["__proto__"],
      },
      {
        inheritedAction: undefined,
        inheritedInvalidCount: 1,
        jsonValueHasOwnProto: true,
        jsonValuePrototypeIsDefault: true,
        inheritedPollution: undefined,
        ownProtoValue: { polluted: true },
      },
    );
  });

  it("accepts advertised meta recoveries when errors initializes the cold catalog", () => {
    const script = `
      import { resolve } from "node:path";
      import { pathToFileURL } from "node:url";

      const errorsUrl = pathToFileURL(resolve("dist/mcp/errors.js")).href;
      const { PolicyDenialError, errorToMcpResponse } = await import(errorsUrl);
      const error = new PolicyDenialError("denied");
      error.nextCalls = [
        { action: "sdl.action.search", args: { query: "repo" } },
        { action: "sdl.info", args: { redactPaths: true } },
        { action: "sdl.manual", args: {} },
        {
          action: "sdl.context",
          args: {
            repoId: "repo",
            taskType: "explain",
            taskText: "inspect",
            budget: { maxTokens: 1000 },
          },
        },
        {
          action: "sdl.file",
          args: { op: "read", repoId: "repo", filePath: "package.json" },
        },
        {
          action: "sdl.retrieve",
          args: {
            op: "symbolSearch",
            repoId: "repo",
            args: { query: "target" },
          },
        },
      ];
      process.stdout.write(JSON.stringify(errorToMcpResponse(error)));
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    assert.equal(child.status, 0, child.stderr);
    const output = child.stdout.trim().split(/\r?\n/).at(-1);
    assert.ok(output);
    const response = JSON.parse(output) as {
      error?: { nextCalls?: RecoveryCall[] };
    };
    assert.deepEqual(
      response.error?.nextCalls?.map((call) => call.action),
      [
        "sdl.action.search",
        "sdl.info",
        "sdl.manual",
        "sdl.context",
        "sdl.file",
        "sdl.retrieve",
      ],
    );
  });

  it("omits disabled workflow functions instead of emitting an unexecutable recovery", () => {
    const activeFnNameMap = getActiveFnNameMap();
    assert.equal(Object.hasOwn(activeFnNameMap, "memoryQuery"), false);

    const result = recoveryBuilder()(
      { action: "sdl.memory.query", args: { query: "target" } },
      { repoId: "repo", advertisedTools: ["sdl.workflow"] },
    );

    assert.equal(result.nextAction, undefined);
    assert.equal(result.invalidRecoveryCount, 1);
  });

  it("filters thrown recoveries through the memory-disabled registered flat surface", async () => {
    const server = new MCPServer();
    registerTools(server, {
      actionAvailability: { memoryTools: false, infoTool: true },
    });
    server.registerTool(
      "sdl.repo.status",
      "Throw a recovery-bearing test error.",
      z.object({}),
      async () => {
        throw Object.assign(new PolicyDenialError("denied"), {
          fallbackTools: [
            "sdl.memory.query",
            "memoryQuery",
            "sdl.repo.status",
          ],
          nextCalls: [
            {
              action: "sdl.memory.query",
              args: { repoId: "repo", query: "target" },
            },
            {
              action: "memoryQuery",
              args: { repoId: "repo", query: "target" },
            },
            {
              action: "sdl.repo.status",
              args: { repoId: "repo" },
            },
          ],
        });
      },
    );

    const client = new Client({ name: "recovery-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);

    try {
      const tools = await client.listTools();
      assert.equal(
        tools.tools.some((tool) => tool.name === "sdl.memory.query"),
        false,
      );

      const response = (await client.callTool({
        name: "sdl.repo.status",
        arguments: {},
      })) as {
        isError?: boolean;
        structuredContent?: {
          error?: {
            fallbackTools?: string[];
            nextCalls?: RecoveryCall[];
          };
        };
      };
      const detail = response.structuredContent?.error;

      assert.equal(response.isError, true);
      assert.deepEqual(detail?.fallbackTools, ["sdl.repo.status"]);
      assert.deepEqual(detail?.nextCalls, [
        {
          action: "sdl.repo.status",
          args: {
            detail: "compact",
            includeTelemetry: false,
            repoId: "repo",
            surfaceMemories: false,
          },
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(detail),
        /sdl\.memory\.query|memoryQuery/,
      );
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("projects requestSkeleton guidance through the executable retrieve surface", () => {
    const response = errorToMcpResponse(
      new PolicyDenialError("denied", "requestSkeleton", {
        requestSkeleton: { repoId: "repo", symbolId: "symbol" },
      }),
    ) as {
      error?: {
        nextBestAction?: string;
        fallbackTools?: string[];
        nextCalls?: RecoveryCall[];
      };
    };

    assert.deepEqual(
      {
        nextBestAction: response.error?.nextBestAction,
        fallbackTools: response.error?.fallbackTools,
        nextCalls: response.error?.nextCalls,
      },
      {
        nextBestAction: "requestSkeleton",
        fallbackTools: ["sdl.retrieve"],
        nextCalls: [
          {
            action: "sdl.retrieve",
            args: {
              args: { symbolId: "symbol" },
              op: "codeSkeleton",
              repoId: "repo",
            },
          },
        ],
      },
    );
  });

  it("ignores inherited policy guidance properties", () => {
    const error = new PolicyDenialError("denied");
    const mutableError = error as unknown as Record<string, unknown>;
    delete mutableError.nextBestAction;
    delete mutableError.requiredFieldsForNext;
    Object.setPrototypeOf(
      error,
      Object.assign(Object.create(PolicyDenialError.prototype), {
        nextBestAction: "requestSkeleton",
        requiredFieldsForNext: {
          requestSkeleton: { repoId: "repo", symbolId: "symbol" },
        },
      }),
    );

    const response = errorToMcpResponse(error) as {
      error?: {
        nextBestAction?: string;
        requiredFieldsForNext?: unknown;
        fallbackTools?: string[];
        nextCalls?: RecoveryCall[];
      };
    };

    assert.deepEqual(
      {
        nextBestAction: response.error?.nextBestAction,
        requiredFieldsForNext: response.error?.requiredFieldsForNext,
        fallbackTools: response.error?.fallbackTools,
        nextCalls: response.error?.nextCalls,
      },
      {
        nextBestAction: undefined,
        requiredFieldsForNext: undefined,
        fallbackTools: undefined,
        nextCalls: undefined,
      },
    );
  });

  it("canonicalizes projected key order and preserves nested detail semantics", () => {
    const first = recoveryProjection.projectExclusiveCodeModeRecovery(
      {
        nextAction: {
          action: "sdl.repo.status",
          message: "Inspect repository status.",
          args: {},
        },
      },
      "repo",
    ) as { nextAction?: RecoveryCall };
    const second = recoveryProjection.projectExclusiveCodeModeRecovery(
      {
        nextAction: {
          args: {},
          message: "Inspect repository status.",
          action: "sdl.repo.status",
        },
      },
      "repo",
    ) as { nextAction?: RecoveryCall };

    const nestedDetail = recoveryBuilder()(
      {
        action: "sdl.file.write",
        args: {
          repoId: "repo",
          filePath: "fixture.json",
          jsonPath: "payload",
          jsonValue: { detail: "after" },
          createBackup: false,
        },
      },
      {
        repoId: "repo",
        advertisedTools: ["sdl.file.write"],
        failedCall: {
          action: "sdl.file.write",
          args: {
            repoId: "repo",
            filePath: "fixture.json",
            jsonPath: "payload",
            jsonValue: { detail: "before" },
            createBackup: false,
          },
        },
      },
    );

    assert.deepEqual(
      {
        keyOrderStable:
          JSON.stringify(first.nextAction) === JSON.stringify(second.nextAction),
        nestedDetail: (
          nestedDetail.nextAction?.args.jsonValue as
            | Record<string, unknown>
            | undefined
        )?.detail,
      },
      {
        keyOrderStable: true,
        nestedDetail: "after",
      },
    );
  });
});
