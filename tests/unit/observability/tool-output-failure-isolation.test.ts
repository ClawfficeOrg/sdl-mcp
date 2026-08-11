import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { MCPServer } from "../../../dist/server.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
} from "../../../dist/observability/event-tap.js";
import type { ToolCallEvent } from "../../../dist/mcp/telemetry.js";

type CallToolHandler = (
  request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  },
  extra: {
    _meta: Record<string, unknown>;
    sendNotification: () => Promise<void>;
    signal: AbortSignal;
  },
) => Promise<Record<string, unknown>>;

function getCallToolHandler(server: MCPServer): CallToolHandler {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, CallToolHandler>;
  };
  const handler = sdkServer._requestHandlers.get("tools/call");
  assert.ok(handler);
  return handler;
}

function server(): MCPServer {
  const instance = new MCPServer();
  instance.registerTool(
    "sdl.runtime.execute",
    "Observability isolation test tool",
    z.object({ detail: z.enum(["compact", "full"]) }),
    async () => ({
      status: "error",
      exitCode: 7,
      durationMs: 23,
      stderrSummary: "expected failure",
      nextAction: {
        action: "sdl.runtime.execute",
        args: { runtime: "node", code: "process.exit(0)" },
      },
    }),
  );
  return instance;
}

function tapWith(
  toolCall: (event: ToolCallEvent) => void | Promise<void>,
): ObservabilityTap {
  return new Proxy({} as ObservabilityTap, {
    get: (_target, property) =>
      property === "toolCall" ? toolCall : () => {},
  });
}

async function call(instance: MCPServer): Promise<Record<string, unknown>> {
  return getCallToolHandler(instance)(
    {
      method: "tools/call",
      params: {
        name: "sdl.runtime.execute",
        arguments: { detail: "compact" },
      },
    },
    {
      _meta: {},
      sendNotification: async () => {},
      signal: new AbortController().signal,
    },
  );
}

afterEach(() => {
  resetObservabilityTap();
});

describe("tool output observability failure isolation", () => {
  it("preserves the complete envelope when a tap throws synchronously", async () => {
    const control = await call(server());
    installObservabilityTap(tapWith(() => {
      throw new Error("sync tap failure");
    }));

    const observed = await call(server());

    assert.equal(JSON.stringify(observed), JSON.stringify(control));
    assert.deepEqual(Object.keys(observed), Object.keys(control));
    assert.equal(observed.isError, control.isError);
    assert.deepEqual(
      (observed.structuredContent as Record<string, unknown>).nextAction,
      (control.structuredContent as Record<string, unknown>).nextAction,
    );
  });

  it("preserves the complete envelope when a tap rejects asynchronously", async () => {
    const control = await call(server());
    installObservabilityTap(tapWith(async () => {
      throw new Error("async tap failure");
    }));

    const observed = await call(server());
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(JSON.stringify(observed), JSON.stringify(control));
    assert.deepEqual(Object.keys(observed), Object.keys(control));
    assert.equal(observed.isError, control.isError);
    assert.deepEqual(
      (observed.structuredContent as Record<string, unknown>).nextAction,
      (control.structuredContent as Record<string, unknown>).nextAction,
    );
  });
});
