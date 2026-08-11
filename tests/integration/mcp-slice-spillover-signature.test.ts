import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { beginGraphIntegrityVersion } from "../../dist/db/ladybug-derived-state.js";
import { createGraphIntegrityExpectationFromManifest } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import type { ActionMap } from "../../dist/gateway/router.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import { buildToolResponseEnvelope, MCPServer } from "../../dist/server.js";
import { handleSliceSpilloverGet } from "../../dist/mcp/tools/slice.js";
import {
  SliceSpilloverGetRequestSchema,
  SliceSpilloverGetResponseSchema,
} from "../../dist/mcp/tools.js";

function toStructuredContent(
  toolName: string,
  result: unknown,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return buildToolResponseEnvelope(result, null, "", toolName, args).structuredContent;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-mcp-slice-spillover-signature-test-db.lbug");

describe("MCP slice spillover signatures", () => {
  const repoId = "mcp-slice-spillover-signature-repo";
  const publicRepoId = `${repoId}-public`;
  const symbolId = "sym-rust-spillover";
  const spilloverHandle = "spillover-handle-1";

  before(async () => {
    rmSync(TEST_DB_PATH + ".sdl-lineage.json", { recursive: true, force: true });
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(TEST_DB_PATH);
    const conn = await getLadybugConn();
    const now = "2026-03-11T14:30:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "integration",
      prevVersionHash: null,
      versionHash: "v1-hash",
    });
    await beginGraphIntegrityVersion(conn, repoId, "v1", "0".repeat(64), true);

    await ladybugDb.upsertFile(conn, {
      fileId: "file-rs-1",
      repoId,
      relPath: "src/lib.rs",
      contentHash: "hash-rs-1",
      language: "rs",
      byteSize: 256,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId,
      repoId,
      fileId: "file-rs-1",
      kind: "function",
      name: "compute_total",
      exported: true,
      visibility: "public",
      language: "rust",
      rangeStartLine: 10,
      rangeStartCol: 0,
      rangeEndLine: 18,
      rangeEndCol: 1,
      astFingerprint: "sym-rust-spillover-fp",
      signatureJson: JSON.stringify({
        params: [{ name: "input", type: "&Item" }],
        returns: "Result<i64>",
        generics: ["T"],
      }),
      summary: "Computes totals for spillover regression coverage.",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    await ladybugDb.upsertSliceHandle(conn, {
      handle: spilloverHandle,
      repoId,
      createdAt: now,
      expiresAt: "2026-03-12T14:30:00.000Z",
      minVersion: "v1",
      maxVersion: "v1",
      sliceHash: "slice-hash-1",
      spilloverRef: JSON.stringify([
        {
          symbolId,
          reason: "budget",
          priority: "should",
        },
      ]),
    });

    const publicVersionId = "public-v1";
    await ladybugDb.upsertRepo(conn, {
      repoId: publicRepoId,
      rootPath: "C:/public-repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });
    await ladybugDb.createVersion(conn, {
      versionId: publicVersionId,
      repoId: publicRepoId,
      createdAt: now,
      reason: "public missing-handle probe",
      prevVersionHash: null,
      versionHash: null,
    });
    await ladybugDb.replaceGraphIntegrityManifestInTransaction(
      conn,
      publicRepoId,
      { files: [], fileless: [] },
    );
    const publicExpectation = createGraphIntegrityExpectationFromManifest(
      [],
      [],
    );
    await beginGraphIntegrityVersion(
      conn,
      publicRepoId,
      publicVersionId,
      publicExpectation.digest,
      true,
    );
  });

  after(async () => {
    await closeLadybugDb();
    rmSync(TEST_DB_PATH + ".sdl-lineage.json", { recursive: true, force: true });
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("preserves stored signature details even when signatureJson omits name", async () => {
    const response = await handleSliceSpilloverGet({ repoId, spilloverHandle });

    const payload = JSON.parse(
      JSON.stringify(
        toStructuredContent("sdl.slice.spillover.get", response, {
          repoId,
          spilloverHandle,
        }),
      ),
    );
    assert.deepStrictEqual(SliceSpilloverGetResponseSchema.parse(payload), payload);
    assert.equal(response.hasMore, false);
    assert.equal(response.symbols.length, 1);
    assert.deepStrictEqual(response.symbols[0]?.signature, {
      name: "compute_total",
      params: [{ name: "input", type: "&Item" }],
      returns: "Result<i64>",
      generics: ["T"],
    });
  });

  it("returns one stable missing-handle error through public and workflow boundaries", async () => {
    const missingHandle = "missing-spillover-handle";
    const expectedError = {
      error: {
        message: `Spillover handle not found: ${missingHandle}`,
        code: "NOT_FOUND",
        classification: "not_found",
        retryable: false,
      },
    };

    await assert.rejects(
      handleSliceSpilloverGet({ repoId, spilloverHandle: missingHandle }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "NotFoundError");
        assert.equal(
          (error as Error & { code?: string }).code,
          "NOT_FOUND",
        );
        assert.equal(error.message, expectedError.error.message);
        return true;
      },
    );

    const server = new MCPServer();
    server.registerTool(
      "sdl.slice.spillover.get",
      "Get slice spillover",
      SliceSpilloverGetRequestSchema,
      handleSliceSpilloverGet,
      undefined,
      undefined,
      SliceSpilloverGetResponseSchema,
    );
    const client = new Client({
      name: "spillover-test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);

    try {
      const catalog = await client.listTools();
      const advertised = catalog.tools.find(
        (tool) => tool.name === "sdl.slice.spillover.get",
      );
      assert.ok(advertised?.outputSchema);
      const advertisedProperties = (
        advertised.outputSchema as {
          properties?: Record<string, {
            type?: string;
            required?: string[];
          }>;
        }
      ).properties;
      assert.equal(advertisedProperties?.error?.type, "object");
      assert.deepEqual(advertisedProperties?.error?.required, ["message"]);

      const response = await client.callTool({
        name: "sdl.slice.spillover.get",
        arguments: { repoId: publicRepoId, spilloverHandle: missingHandle },
      });
      assert.equal(response.isError, true);
      assert.deepEqual(response.structuredContent, expectedError);
      assert.equal(
        SliceSpilloverGetResponseSchema.safeParse(
          response.structuredContent,
        ).success,
        false,
      );

      const workflowRequest: ParsedWorkflowRequest = {
        repoId: publicRepoId,
        onError: "stop",
        steps: [{
          fn: "sliceSpilloverGet",
          action: "slice.spillover.get",
          args: { repoId: publicRepoId, spilloverHandle: missingHandle },
        }],
      };
      const actionMap: ActionMap = {
        "slice.spillover.get": {
          schema: SliceSpilloverGetRequestSchema,
          handler: async (args) =>
            handleSliceSpilloverGet(SliceSpilloverGetRequestSchema.parse(args)),
        },
      };
      const workflowConfig: CodeModeConfig = {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 60_000,
        ladderValidation: "warn",
        etagCaching: false,
      };
      const executed = await executeWorkflow(
        workflowRequest,
        actionMap,
        workflowConfig,
      );
      const [failedStep] = executed.results;
      assert.equal(failedStep?.status, "error");
      assert.equal(failedStep?.result, null);
      assert.deepEqual(failedStep?.error, expectedError.error);

      const workflow = projectToolResultForModelContent(
        "sdl.workflow",
        executed,
        {
          repoId: publicRepoId,
          detail: "compact",
          steps: workflowRequest.steps,
        },
      ) as { results: Array<Record<string, unknown>> };
      assert.deepEqual(workflow.results[0], {
        fn: "sliceSpilloverGet",
        status: "error",
        error: expectedError.error,
      });
      const serializedFailure = JSON.stringify(workflow.results[0]);
      assert.equal(
        (serializedFailure.match(/Spillover handle not found/g) ?? []).length,
        1,
      );
      assert.equal("failureTrace" in workflow.results[0]!, false);
      assert.equal("fallbackTools" in workflow.results[0]!, false);
    } finally {
      await client.close();
      await server.getServer().close();
    }
  });
});
