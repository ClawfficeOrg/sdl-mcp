import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { MCPServer } from "../../dist/server.js";

describe("MCP readiness admission", () => {
  it("keeps reads and tools/list available while rejecting writes centrally", async () => {
    let readCalls = 0;
    let writeCalls = 0;
    let hookCalls = 0;
    const server = new MCPServer({
      getStartupReadiness: () => ({
        state: "degraded",
        reason: "storage_preflight_failed",
        watchers: { expected: 2, ready: 0 },
      }),
    });

    server.registerTool(
      "sdl.repo.status",
      "status",
      z.object({ repoId: z.string() }),
      async () => {
        readCalls += 1;
        return { status: "ok" };
      },
    );
    server.registerTool(
      "sdl.index.refresh",
      "refresh",
      z.object({ repoId: z.string() }),
      async () => {
        writeCalls += 1;
        return { status: "ok" };
      },
    );
    server.registerPostDispatchHook(async () => {
      hookCalls += 1;
    });

    const client = new Client({ name: "readiness-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);

    try {
      const before = await client.listTools();
      const read = await client.callTool({
        name: "sdl.repo.status",
        arguments: { repoId: "test" },
      });
      const write = await client.callTool({
        name: "sdl.index.refresh",
        arguments: { repoId: "test" },
      });
      const after = await client.listTools();

      assert.equal(read.isError, undefined);
      assert.equal(readCalls, 1);
      assert.equal(writeCalls, 0);
      assert.equal(hookCalls, 0);
      assert.equal(write.isError, true);
      assert.equal(
        (
          write.structuredContent as {
            error?: { code?: string };
          }
        ).error?.code,
        "STORAGE_NOT_WRITE_READY",
      );
      assert.equal(JSON.stringify(after), JSON.stringify(before));
    } finally {
      await client.close();
    }
  });

  it("preserves existing write behavior when readiness is not supplied", async () => {
    let calls = 0;
    const server = new MCPServer();
    server.registerTool(
      "sdl.index.refresh",
      "refresh",
      z.object({ repoId: z.string() }),
      async () => {
        calls += 1;
        return { status: "ok" };
      },
    );

    const client = new Client({ name: "readiness-default-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);

    try {
      const result = await client.callTool({
        name: "sdl.index.refresh",
        arguments: { repoId: "test" },
      });
      assert.equal(result.isError, undefined);
      assert.equal(calls, 1);
    } finally {
      await client.close();
    }
  });
});
