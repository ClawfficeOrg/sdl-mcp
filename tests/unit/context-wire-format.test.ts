/**
 * sdl.context wire-format gate tests. Mirrors symbol/slice tests:
 * gate decisions for json/packed/auto on small + large responses,
 * tap publish for both decisions, packed payload round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentContextRequestSchema } from "../../dist/mcp/tools.js";
import {
  publishContextWireDecision,
  serializeContextForWireFormat,
} from "../../dist/mcp/tools/context-wire-format.js";
import {
  buildContextPackedStats,
  shouldAttachPackedPayloadForContext,
} from "../../dist/mcp/tools/context.js";
import { decodePacked } from "../../dist/mcp/wire/packed/decoder.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PackedWireTapEvent,
} from "../../dist/observability/event-tap.js";

const SMALL_RESPONSE: Record<string, unknown> = {
  status: "empty",
  taskType: "explain",
  retrieval: {
    level: "lexical",
    lanes: [{ id: "symbolFts", available: true }],
  },
  evidence: [],
  edges: [],
  omitted: { total: 0, byReason: { budget: 0 }, highestRanked: [] },
  nextActions: [],
};

const LARGE_RESPONSE: Record<string, unknown> = {
  status: "budgetLimited",
  taskType: "debug",
  retrieval: {
    level: "hybrid-partial",
    lanes: [
      { id: "exactIdentifier", available: true },
      { id: "symbolFts", available: true },
      { id: "symbolVec", available: true, coveragePermille: 800 },
    ],
  },
  evidence: Array.from({ length: 20 }, (_, i) => ({
    rung: i % 2 === 0 ? "card" : "skeleton",
    symbolId: `${"a".repeat(48)}-${i}`,
    path: `src/some/long/path/module-${i}.ts`,
    rank: i + 1,
    tier: i < 2 ? 0 : 1,
    lanes: i < 2 ? ["exactIdentifier", "symbolFts"] : ["symbolFts"],
    content:
      i % 2 === 0
        ? { kind: "function", name: `someFunctionName${i}` }
        : `function someFunctionName${i}(): void`,
  })),
  edges: Array.from({ length: 10 }, (_, i) => ({
    from: `${"a".repeat(48)}-${i}`,
    to: `${"a".repeat(48)}-${i + 1}`,
    kind: "call",
    confidencePermille: 900,
  })),
  omitted: {
    total: 1,
    byReason: { budget: 1 },
    highestRanked: [
      {
        symbolId: `${"b".repeat(48)}-1`,
        path: "src/some/long/path/omitted.ts",
        rung: "hotPath",
        rank: 21,
        tier: 1,
        reason: "budget",
        action: {
          id: "codeHotPath",
          args: {
            symbolId: `${"b".repeat(48)}-1`,
            identifiersToFind: ["someFunctionName"],
          },
        },
      },
    ],
  },
  nextActions: [
    {
      id: "codeHotPath",
      args: {
        symbolId: `${"b".repeat(48)}-1`,
        identifiersToFind: ["someFunctionName"],
      },
    },
  ],
};

function captureTap(): {
  events: PackedWireTapEvent[];
  uninstall: () => void;
} {
  const events: PackedWireTapEvent[] = [];
  const noop = () => {};
  const tap: ObservabilityTap = {
    toolCall: noop,
    indexEvent: noop,
    semanticSearch: noop,
    policyDecision: noop,
    prefetch: noop,
    watcherHealth: noop,
    edgeResolution: noop,
    runtimeExecution: noop,
    setupPipeline: noop,
    summaryGeneration: noop,
    summaryQuality: noop,
    pprResult: noop,
    scipIngest: noop,
    packedWire: (event) => events.push(event),
    poolSample: noop,
    resourceSample: noop,
    indexPhase: noop,
    cacheLookup: noop,
    sliceBuild: noop,
    auditBufferSample: noop,
    postIndexSession: noop,
    dbLatency: noop,
  };
  installObservabilityTap(tap);
  return { events, uninstall: () => resetObservabilityTap() };
}

test("sdl.context budget accepts only the v2 maxTokens field", () => {
  const request = {
    repoId: "repo-1",
    taskType: "explain",
    taskText: "Explain the response budget",
  };

  assert.equal(
    AgentContextRequestSchema.safeParse({
      ...request,
      budget: { maxTokens: 512 },
    }).success,
    true,
  );
  assert.equal(
    AgentContextRequestSchema.safeParse({
      ...request,
      budget: { maxTokens: 512, maxEstimatedTokens: 512 },
    }).success,
    false,
  );
  assert.equal(
    AgentContextRequestSchema.safeParse({
      ...request,
      budget: { maxTokens: 511 },
    }).success,
    false,
  );
  assert.equal(
    AgentContextRequestSchema.safeParse({
      ...request,
      budget: { maxEstimatedTokens: 511 },
    }).success,
    false,
  );
});

test("wireFormat=undefined returns json passthrough (no gate)", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(SMALL_RESPONSE, undefined);
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, undefined);
});

test("wireFormat=packed publishes tap with ctx3 encoder", () => {
  const { events, uninstall } = captureTap();
  tokenAccumulator.reset();

  const result = serializeContextForWireFormat(LARGE_RESPONSE, "packed", {
    packedThreshold: 0.05,
  });

  assert.ok(result.gateDecision !== undefined);
  publishContextWireDecision(result, result.gateDecision);
  assert.equal(events.length, 1);
  assert.equal(events[0].encoderId, "ctx3");
  assert.equal(events[0].decision, result.gateDecision);

  uninstall();
});

test("wireFormat=auto: large input → packed wins, payload is string", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(LARGE_RESPONSE, "auto", {
    packedThreshold: 0.05,
  });
  if (result.gateDecision === "packed") {
    assert.equal(result.format, "packed");
    assert.equal(typeof result.payload, "string");
    assert.equal(result.encoderId, "ctx3");
  }
});

test("wireFormat=auto: small input falls back to json", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(SMALL_RESPONSE, "auto", {
    packedThreshold: 0.5,
  });
  assert.equal(result.format, "json");
  assert.equal(result.gateDecision, "fallback");
});

test("sdl.context auto mode does not attach a duplicate packed payload", () => {
  const netWinningPacked = {
    jsonBytes: 10_000,
    packedBytes: 1_000,
    jsonTokens: 2_500,
    packedTokens: 250,
  };

  assert.equal(
    shouldAttachPackedPayloadForContext("auto", netWinningPacked),
    false,
  );
  assert.equal(
    shouldAttachPackedPayloadForContext("packed", netWinningPacked),
    true,
  );
});

test("sdl.context packed stats separate candidate decision from returned payload", () => {
  const wireResult = {
    format: "packed" as const,
    payload: "ctx3|...",
    encoderId: "ctx3",
    jsonBytes: 10_000,
    packedBytes: 1_000,
    jsonTokens: 2_500,
    packedTokens: 250,
    axisHit: "tokens" as const,
    gateDecision: "packed" as const,
  };

  const autoStats = buildContextPackedStats(wireResult, false);
  assert.equal(autoStats?.candidateDecision, "packed");
  assert.equal(autoStats?.gateDecision, "fallback");
  assert.equal(autoStats?.payloadAttached, false);
  assert.equal(autoStats?.returnFormat, "json");

  const packedStats = buildContextPackedStats(wireResult, true);
  assert.equal(packedStats?.candidateDecision, "packed");
  assert.equal(packedStats?.gateDecision, "packed");
  assert.equal(packedStats?.payloadAttached, true);
  assert.equal(packedStats?.returnFormat, "packed");
});

test("packed payload round-trips via decodePacked", () => {
  tokenAccumulator.reset();
  resetObservabilityTap();
  const result = serializeContextForWireFormat(LARGE_RESPONSE, "packed", {
    packedThreshold: 0.0,
  });
  if (result.format !== "packed") {
    return;
  }
  const decoded = decodePacked(result.payload as string);
  assert.equal(decoded.encoderId, "ctx3");
  assert.equal(decoded.data.status, "budgetLimited");
  assert.equal(decoded.data.taskType, "debug");
  assert.equal(decoded.data.retrievalLevel, "hybrid-partial");
  assert.equal((decoded.data.evidence as unknown[]).length, 20);
  assert.equal((decoded.data.edges as unknown[]).length, 10);
  assert.equal((decoded.data.omitted as unknown[]).length, 1);
  assert.equal((decoded.data.nextActions as unknown[]).length, 1);
});

test("fallback path also publishes tap", () => {
  const { events, uninstall } = captureTap();
  tokenAccumulator.reset();

  const result = serializeContextForWireFormat(SMALL_RESPONSE, "auto", {
    packedThreshold: 0.99,
    packedTokenThreshold: 0.99,
  });

  assert.equal(result.gateDecision, "fallback");
  publishContextWireDecision(result, "fallback");
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "fallback");
  assert.equal(events[0].encoderId, "ctx3");

  uninstall();
});
