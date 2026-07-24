import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import {
  BufferCheckpointResponseSchema,
  CodeNeedWindowResponseSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  InfoResponseSchema,
  RepoOverviewResponseSchema,
  SearchEditResponseSchema,
  SemanticEnrichmentRefreshResponseSchema,
  SemanticEnrichmentStatusResponseSchema,
  SymbolEditResponseSchema,
} from "../../dist/mcp/tools.js";
import {
  createMCPServer,
  type MCPServer,
} from "../../dist/server.js";

const TEMP_BASE =
  process.platform === "win32" ? join(homedir(), ".codex", "tmp") : tmpdir();
mkdirSync(TEMP_BASE, { recursive: true });

const TEST_ROOT = mkdtempSync(join(TEMP_BASE, "sdl-output-schema-wire-"));
const REPO_ROOT = join(TEST_ROOT, "repo");
const DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl.config.json");
const REPO_ID = "output-schema-wire";

interface ToolEnvelope {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface WireCase {
  name: string;
  schema: z.ZodType;
  successArgs: () => Record<string, unknown>;
  errorArgs: () => Record<string, unknown>;
  errorTextPattern: RegExp;
}

const GenericStructuredErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().min(1),
        code: z.string().min(1),
        details: z.array(z.unknown()).optional(),
        classification: z.string().optional(),
        retryable: z.boolean().optional(),
        fallbackTools: z.array(z.string()).optional(),
        fallbackRationale: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function responseText(response: ToolEnvelope): string {
  return (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function assertConciseText(response: ToolEnvelope, label: string): void {
  const text = responseText(response);
  assert.ok(text.length > 0, `${label}: expected non-empty text`);
  assert.ok(text.length <= 4_000, `${label}: text should remain concise`);
}

async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: `output-schema-wire-${randomUUID()}`,
    version: "1.0.0",
  });
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MCP output-schema wire contracts", { concurrency: false }, () => {
  let server: MCPServer;
  let client: Client;
  let symbolId = "";
  const previousEnv = {
    config: process.env.SDL_CONFIG,
    graphDb: process.env.SDL_GRAPH_DB_PATH,
    db: process.env.SDL_DB_PATH,
    native: process.env.SDL_MCP_DISABLE_NATIVE_ADDON,
  };

  before(async () => {
    mkdirSync(join(REPO_ROOT, "src"), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "greeting.ts"),
      [
        "export function greet(name: string): string {",
        "  const message = `Hello ${name}`;",
        "  return message;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(REPO_ROOT, "notes.txt"),
      "oldName appears in this disposable fixture.\n",
      "utf8",
    );
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          repos: [],
          policy: {
            maxWindowLines: 180,
            maxWindowTokens: 1_400,
            requireIdentifiers: true,
            allowBreakGlass: true,
            defaultDenyRaw: false,
          },
          graphDatabase: { path: DB_PATH },
          indexing: {
            pipeline: "legacy",
            engine: "typescript",
            enableFileWatching: false,
            algorithmRefresh: {
              enabled: false,
              pageRank: { enabled: false },
              kCore: { enabled: false },
              louvain: { enabled: false, maxCallEdges: 0 },
            },
          },
          liveIndex: { enabled: false },
          semantic: { enabled: false, generateSummaries: false },
          semanticEnrichment: {
            enabled: false,
            autoRunOnIndexRefresh: false,
          },
          prefetch: { enabled: false, warmTopN: 0 },
          memory: { enabled: false },
          scip: { enabled: false, generator: { enabled: false } },
          observability: { enabled: false },
          security: { allowedRepoRoots: [REPO_ROOT] },
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.SDL_CONFIG = CONFIG_PATH;
    process.env.SDL_GRAPH_DB_PATH = DB_PATH;
    process.env.SDL_DB_PATH = DB_PATH;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    invalidateConfigCache();
    resetSearchEditPlanStore();

    await closeLadybugDb();
    await initLadybugDb(DB_PATH);
    server = await createMCPServer({
      gatewayConfig: { enabled: false, emitLegacyTools: true },
    });
    client = await connect(server);
    await client.listTools();

    for (const setupCall of [
      {
        name: "sdl.repo.register",
        arguments: {
          repoId: REPO_ID,
          rootPath: REPO_ROOT,
          languages: ["ts"],
          updateExisting: true,
        },
      },
      {
        name: "sdl.index.refresh",
        arguments: { repoId: REPO_ID, mode: "full" },
      },
    ]) {
      const response = (await client.callTool(setupCall)) as ToolEnvelope;
      assert.notEqual(
        response.isError,
        true,
        `${setupCall.name}: ${JSON.stringify(response.structuredContent)}`,
      );
    }

    const search = (await client.callTool({
      name: "sdl.symbol.search",
      arguments: {
        repoId: REPO_ID,
        query: "greet",
        semantic: false,
        wireFormat: "json",
        limit: 5,
      },
    })) as ToolEnvelope;
    assert.notEqual(search.isError, true);
    const results = (
      search.structuredContent as {
        results?: Array<{ symbolId?: string; name?: string }>;
      }
    )?.results;
    symbolId =
      results?.find((result) => result.name === "greet")?.symbolId ?? "";
    assert.ok(symbolId, "expected the indexed greet symbol");
  });

  after(async () => {
    await client?.close();
    await server?.stop();
    resetSearchEditPlanStore();
    await closeLadybugDb();
    invalidateConfigCache();

    if (previousEnv.config === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousEnv.config;
    if (previousEnv.graphDb === undefined) delete process.env.SDL_GRAPH_DB_PATH;
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

  const cases: WireCase[] = [
    {
      name: "sdl.info",
      schema: InfoResponseSchema,
      successArgs: () => ({ redactPaths: true }),
      errorArgs: () => ({ redactPaths: "yes" }),
      errorTextPattern: /redactPaths/u,
    },
    {
      name: "sdl.repo.overview",
      schema: RepoOverviewResponseSchema,
      successArgs: () => ({ repoId: REPO_ID, level: "full" }),
      errorArgs: () => ({ repoId: REPO_ID, level: "invalid" }),
      errorTextPattern: /level/u,
    },
    {
      name: "sdl.symbol.edit",
      schema: SymbolEditResponseSchema,
      successArgs: () => ({
        mode: "preview",
        repoId: REPO_ID,
        symbolId,
        operation: {
          kind: "replaceBody",
          content: "return `Hi ${name}`;\n",
        },
        createBackup: false,
      }),
      errorArgs: () => ({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: "missing-symbol-edit-plan",
      }),
      errorTextPattern: /planHandle/u,
    },
    {
      name: "sdl.code.needWindow",
      schema: CodeNeedWindowResponseSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        symbolId,
        reason: "Inspect the greeting implementation",
        expectedLines: 4,
        identifiersToFind: ["message"],
        maxTokens: 256,
        refsMode: "off",
        responseMode: "inline",
      }),
      errorArgs: () => ({
        repoId: REPO_ID,
        reason: "Missing target",
        expectedLines: 0,
        identifiersToFind: [],
      }),
      errorTextPattern: /expectedLines|symbolId/u,
    },
    {
      name: "sdl.file.read",
      schema: FileReadResponseSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        filePath: "notes.txt",
        responseMode: "inline",
      }),
      errorArgs: () => ({ repoId: REPO_ID, filePath: "" }),
      errorTextPattern: /filePath/u,
    },
    {
      name: "sdl.file.write",
      schema: FileWriteResponseSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        filePath: "wire-created.txt",
        content: "created by the output-schema wire test\n",
        createIfMissing: true,
        createBackup: false,
      }),
      errorArgs: () => ({
        repoId: REPO_ID,
        filePath: "",
        content: "invalid path",
      }),
      errorTextPattern: /filePath/u,
    },
    {
      name: "sdl.semantic.enrichment.refresh",
      schema: SemanticEnrichmentRefreshResponseSchema,
      successArgs: () => ({ repoId: REPO_ID, dryRun: true }),
      errorArgs: () => ({ repoId: "" }),
      errorTextPattern: /repoId/u,
    },
    {
      name: "sdl.semantic.enrichment.status",
      schema: SemanticEnrichmentStatusResponseSchema,
      successArgs: () => ({ repoId: REPO_ID, detail: "compact" }),
      errorArgs: () => ({ repoId: "", detail: "compact" }),
      errorTextPattern: /repoId/u,
    },
    {
      name: "sdl.search.edit",
      schema: SearchEditResponseSchema,
      successArgs: () => ({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
        },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
        maxFiles: 5,
        createBackup: false,
        responseMode: "inline",
      }),
      errorArgs: () => ({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: "missing-search-edit-plan",
      }),
      errorTextPattern: /planHandle/u,
    },
  ];

  for (const wireCase of cases) {
    it(`${wireCase.name} returns schema-valid success and generic error envelopes`, async () => {
      const success = (await client.callTool({
        name: wireCase.name,
        arguments: wireCase.successArgs(),
      })) as ToolEnvelope;

      assert.notEqual(
        success.isError,
        true,
        `${wireCase.name}: ${JSON.stringify(success.structuredContent)}`,
      );
      assertConciseText(success, `${wireCase.name} success`);
      wireCase.schema.parse(success.structuredContent);

      const failure = (await client.callTool({
        name: wireCase.name,
        arguments: wireCase.errorArgs(),
      })) as ToolEnvelope;

      assert.equal(failure.isError, true, wireCase.name);
      assertConciseText(failure, `${wireCase.name} error`);
      assert.match(responseText(failure), wireCase.errorTextPattern);
      GenericStructuredErrorSchema.parse(failure.structuredContent);
    });
  }

  it("returns response.get failures in the generic structured error envelope", async () => {
    const failure = (await client.callTool({
      name: "sdl.response.get",
      arguments: {
        repoId: REPO_ID,
        handle: `response-${REPO_ID}-1784866000000-deadbeefdeadbeef`,
      },
    })) as ToolEnvelope;

    assert.equal(failure.isError, true);
    GenericStructuredErrorSchema.parse(failure.structuredContent);
    assert.match(responseText(failure), /Response artifact not found/u);
  });

  it("returns the exact static no-op checkpoint payload through the SDK wire", async () => {
    const expected = {
      repoId: REPO_ID,
      requested: false,
      pending: false,
      message: "No checkpoint-eligible buffers were pending.",
    };
    await client.listTools();

    const first = (await client.callTool({
      name: "sdl.buffer.checkpoint",
      arguments: { repoId: REPO_ID, reason: "wire-regression" },
    })) as ToolEnvelope;
    const second = (await client.callTool({
      name: "sdl.buffer.checkpoint",
      arguments: { repoId: REPO_ID, reason: "wire-regression" },
    })) as ToolEnvelope;

    assert.notEqual(first.isError, true);
    assert.notEqual(second.isError, true);
    assert.strictEqual(
      JSON.stringify(first.structuredContent),
      JSON.stringify(second.structuredContent),
    );
    assert.deepStrictEqual(first.structuredContent, expected);
    assert.deepStrictEqual(second.structuredContent, expected);
    BufferCheckpointResponseSchema.parse(first.structuredContent);
  });
});
