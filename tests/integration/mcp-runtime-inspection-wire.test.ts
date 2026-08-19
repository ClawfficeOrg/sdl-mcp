import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { WorkflowOutputSchema } from "../../dist/code-mode/types.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { RUNTIME_REPOSITORY_INSPECTION_DISALLOWED } from "../../dist/domain/errors.js";
import { createMCPServer, type MCPServer } from "../../dist/server.js";

const TEST_ROOT = join(
  tmpdir(),
  `sdl-runtime-inspection-wire-${process.pid}-${randomUUID()}`,
);
const DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl.config.json");
const ARTIFACT_DIR = join(TEST_ROOT, "runtime-artifacts");
const REPO_ID = "runtime-inspection-wire";
const REPOSITORY_SOURCE = "repository-source.ts";
const SOURCE_SECRET = "SOURCE_SNIPPET_MUST_NOT_LEAK";

interface ToolEnvelope {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface PublicWorkflowStep {
  stepIndex?: number;
  fn?: string;
  status?: string;
  error?: unknown;
}

const TYPED_ERROR = {
  message: RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
  code: "POLICY_ERROR",
  classification: "policy_denied",
  retryable: false,
};

async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: `runtime-inspection-wire-${randomUUID()}`,
    version: "1.0.0",
  });
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function inspectionArgs(): Record<string, unknown> {
  return {
    repoId: REPO_ID,
    runtime: "node",
    args: [
      "-e",
      `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(REPOSITORY_SOURCE)}, 'utf8');`,
    ],
    persistOutput: false,
    outputMode: "summary",
  };
}

function workflowSteps(sentinelName: string): Array<Record<string, unknown>> {
  return [
    {
      fn: "runtimeExecute",
      args: {
        runtime: "node",
        args: inspectionArgs().args as string[],
        persistOutput: false,
        outputMode: "summary",
      },
    },
    {
      fn: "runtimeExecute",
      args: {
        runtime: "node",
        args: [
          "-e",
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinelName)}, 'ran', 'utf8');`,
        ],
        persistOutput: false,
        outputMode: "minimal",
      },
    },
    {
      fn: "runtimeExecute",
      args: {
        runtime: "node",
        code: "$0.message",
        persistOutput: false,
        outputMode: "minimal",
      },
    },
  ];
}

function workflowResults(response: ToolEnvelope): PublicWorkflowStep[] {
  return (
    (response.structuredContent as { results?: PublicWorkflowStep[] })
      ?.results ?? []
  );
}

function assertTypedFirstStep(response: ToolEnvelope): void {
  const first = workflowResults(response)[0];
  assert.deepEqual(first, {
    stepIndex: 0,
    fn: "runtimeExecute",
    status: "error",
    error: TYPED_ERROR,
  });
}

function assertNoInspectionLeak(response: ToolEnvelope): void {
  const publicJson = JSON.stringify(response);
  for (const privateValue of [
    SOURCE_SECRET,
    REPOSITORY_SOURCE,
    "inlineStaticRead",
    '"category"',
    '"ruleId"',
    '"durationMs"',
    '"timing"',
    TEST_ROOT,
  ]) {
    assert.equal(publicJson.includes(privateValue), false, privateValue);
  }
}

describe(
  "runtime repository-inspection MCP wire contract",
  { concurrency: false },
  () => {
    let server: MCPServer;
    let client: Client;
    const previousEnv = {
      config: process.env.SDL_CONFIG,
      graphDb: process.env.SDL_GRAPH_DB_PATH,
      db: process.env.SDL_DB_PATH,
      native: process.env.SDL_MCP_DISABLE_NATIVE_ADDON,
    };

    before(async () => {
      mkdirSync(TEST_ROOT, { recursive: true });
      writeFileSync(
        join(TEST_ROOT, REPOSITORY_SOURCE),
        `export const repositorySecret = ${JSON.stringify(SOURCE_SECRET)};\n`,
        "utf8",
      );
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          repos: [],
          policy: {},
          graphDatabase: { path: DB_PATH },
          liveIndex: { enabled: false },
          semantic: { enabled: false, generateSummaries: false },
          semanticEnrichment: { enabled: false, autoRunOnIndexRefresh: false },
          prefetch: { enabled: false },
          memory: { enabled: false },
          observability: { enabled: false },
          security: { allowedRepoRoots: [TEST_ROOT] },
          runtime: { artifactBaseDir: ARTIFACT_DIR },
        }),
        "utf8",
      );

      process.env.SDL_CONFIG = CONFIG_PATH;
      process.env.SDL_GRAPH_DB_PATH = DB_PATH;
      process.env.SDL_DB_PATH = DB_PATH;
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
      invalidateConfigCache();

      await closeLadybugDb();
      await initLadybugDb(DB_PATH);
      const conn = await getLadybugConn();
      // Seed registration directly so this fixture never invokes registration
      // or indexing behavior through the public MCP surface.
      await ladybugDb.upsertRepo(conn, {
        repoId: REPO_ID,
        rootPath: TEST_ROOT,
        configJson: JSON.stringify({ policy: {} }),
        createdAt: "2026-08-14T00:00:00.000Z",
      });

      server = await createMCPServer({
        gatewayConfig: { enabled: false, emitLegacyTools: true },
        codeModeConfig: {
          enabled: true,
          exclusive: false,
          maxWorkflowSteps: 20,
          maxWorkflowTokens: 50_000,
          maxWorkflowDurationMs: 60_000,
          ladderValidation: "warn",
          etagCaching: true,
        },
      });
      client = await connect(server);
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((tool) => tool.name === "sdl.runtime.execute"),
      );
      assert.ok(tools.tools.some((tool) => tool.name === "sdl.workflow"));
    });

    after(async () => {
      await client?.close();
      await server?.stop();
      await closeLadybugDb();
      invalidateConfigCache();

      if (previousEnv.config === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousEnv.config;
      if (previousEnv.graphDb === undefined)
        delete process.env.SDL_GRAPH_DB_PATH;
      else process.env.SDL_GRAPH_DB_PATH = previousEnv.graphDb;
      if (previousEnv.db === undefined) delete process.env.SDL_DB_PATH;
      else process.env.SDL_DB_PATH = previousEnv.db;
      if (previousEnv.native === undefined) {
        delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
      } else {
        process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousEnv.native;
      }
      if (existsSync(TEST_ROOT)) {
        rmSync(TEST_ROOT, { recursive: true, force: true });
      }
    });

    it("returns the exact classified domain error without inspection details", async () => {
      const response = (await client.callTool({
        name: "sdl.runtime.execute",
        arguments: inspectionArgs(),
      })) as ToolEnvelope;

      assert.equal(response.isError, true);
      assert.deepEqual(response.structuredContent, { error: TYPED_ERROR });
      assertNoInspectionLeak(response);
    });

    it("keeps empty code in code mode through direct and workflow execution", async () => {
      for (const runtime of ["node", "python"] as const) {
        const sentinel = `empty-code-${runtime}-wire-must-not-run.txt`;
        const source =
          runtime === "node"
            ? `const fs=require('node:fs'); fs.readFileSync(${JSON.stringify(REPOSITORY_SOURCE)}, 'utf8'); fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran')`
            : `from pathlib import Path; Path(${JSON.stringify(REPOSITORY_SOURCE)}).read_text(); Path(${JSON.stringify(sentinel)}).write_text('ran')`;
        const runtimeArgs = {
          runtime,
          code: "",
          args: [runtime === "node" ? "-e" : "-c", source],
          persistOutput: false,
          outputMode: "minimal",
        };
        const direct = (await client.callTool({
          name: "sdl.runtime.execute",
          arguments: { repoId: REPO_ID, ...runtimeArgs },
        })) as ToolEnvelope;
        const workflow = (await client.callTool({
          name: "sdl.workflow",
          arguments: {
            repoId: REPO_ID,
            steps: [{ fn: "runtimeExecute", args: runtimeArgs }],
            onError: "stop",
          },
        })) as ToolEnvelope;

        assert.notEqual(direct.isError, true, runtime);
        assert.notEqual(workflow.isError, true, runtime);
        assert.equal(existsSync(join(TEST_ROOT, sentinel)), false, runtime);
      }
    });

    it("stop returns a typed child error and prevents every later step", async () => {
      const sentinel = "stop-must-not-run.txt";
      const response = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_ID,
          steps: workflowSteps(sentinel),
          onError: "stop",
        },
      })) as ToolEnvelope;

      assert.equal(response.isError, true);
      WorkflowOutputSchema.parse(response.structuredContent);
      assertTypedFirstStep(response);
      assert.deepEqual(
        workflowResults(response).map((step) => step.status),
        ["error", "skipped", "skipped"],
      );
      assert.equal(existsSync(join(TEST_ROOT, sentinel)), false);
      assertNoInspectionLeak(response);
    });

    it("continue runs independent work and skips only the dependent step", async () => {
      const sentinel = "continue-independent-ran.txt";
      const response = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_ID,
          steps: workflowSteps(sentinel),
          onError: "continue",
        },
      })) as ToolEnvelope;
      const results = workflowResults(response);

      assert.equal(response.isError, true);
      WorkflowOutputSchema.parse(response.structuredContent);
      assertTypedFirstStep(response);
      assert.deepEqual(
        results.map((step) => step.status),
        ["error", undefined, "skipped"],
      );
      assert.equal(existsSync(join(TEST_ROOT, sentinel)), true);
      assertNoInspectionLeak(response);
    });

    it("continueAll attempts dependent work and preserves ref-resolution failure", async () => {
      const sentinel = "continue-all-independent-ran.txt";
      const response = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_ID,
          steps: workflowSteps(sentinel),
          onError: "continueAll",
        },
      })) as ToolEnvelope;
      const results = workflowResults(response);

      assert.equal(response.isError, true);
      WorkflowOutputSchema.parse(response.structuredContent);
      assertTypedFirstStep(response);
      assert.deepEqual(
        results.map((step) => step.status),
        ["error", undefined, "error"],
      );
      assert.equal(existsSync(join(TEST_ROOT, sentinel)), true);
      assert.equal(
        results[2].error,
        "Cannot navigate into null/undefined at segment 'message' in reference '$0.message'",
      );
      assertNoInspectionLeak(response);
    });

    it("persistOutput false creates no direct or workflow artifact", async () => {
      const runtimeArgs = {
        runtime: "node",
        code: `process.stdout.write("x".repeat(100_000));`,
        persistOutput: false,
        outputMode: "minimal",
      };
      const direct = (await client.callTool({
        name: "sdl.runtime.execute",
        arguments: { repoId: REPO_ID, ...runtimeArgs },
      })) as ToolEnvelope;
      const workflow = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_ID,
          steps: [{ fn: "runtimeExecute", args: runtimeArgs }],
          onError: "stop",
        },
      })) as ToolEnvelope;

      assert.notEqual(direct.isError, true);
      assert.notEqual(workflow.isError, true);
      for (const response of [direct, workflow]) {
        const publicJson = JSON.stringify(response);
        assert.equal(publicJson.includes("artifactHandle"), false);
        assert.equal(publicJson.includes("runtime.queryOutput"), false);
      }
      assert.equal(existsSync(ARTIFACT_DIR), false);
    });
  },
);
