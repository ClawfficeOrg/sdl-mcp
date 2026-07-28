import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TASK_PROFILES,
  getTaskProfile,
} from "../../dist/context/profiles.js";
import {
  allocateFocusPathSymbols,
  buildRetrievalState,
  ContextEngineV2,
  type ContextEngineV2Dependencies,
  derivedTierOneMentionsForRequest,
  focusPathTierZeroCapacity,
  identifiersForContextRequest,
  tierZeroMentionsForRequest,
} from "../../dist/context/engine.js";
import { hydrateContextBundles } from "../../dist/context/hydrate.js";
import {
  CONTEXT_MCP_WRAPPER_RESERVE_TOKENS,
  CONTEXT_RUNG_TOKEN_LIMITS,
  enforceContextBudget,
  estimateContextResponseTokens,
  estimateContextRungTokens,
  estimateContextSelectionEnvelopeTokens,
  logicalActionForRung,
  selectContextBundles,
} from "../../dist/context/select.js";
import {
  serializeContextPayload,
  stableContextValue,
} from "../../dist/context/serialize.js";
import { normalizeValue } from "../../dist/util/hashing.js";
import { estimateTokens } from "../../dist/util/tokenize.js";
import {
  GraphRetrievalUnavailableError,
  IndexError,
} from "../../dist/domain/errors.js";
import type {
  ContextCandidate,
  ContextEvidence,
  ContextPayload,
  ContextRung,
  ContextV2Request,
} from "../../dist/context/types.js";

function testContextEngine(
  overrides: Partial<ContextEngineV2Dependencies>,
): ContextEngineV2 {
  return new ContextEngineV2({
    runReadSnapshot: async (_repoId, fn) => fn({}),
    prepareHydration: async ({ selected }) => ({
      selected: Object.freeze([...selected]),
      cards: Object.freeze([]),
      durableEdges: new Map(),
      skeletons: new Map(),
      hotPaths: new Map(),
      overlaySnapshot: {
        repoId: "repo",
        touchedFileIds: new Set(),
        symbolsById: new Map(),
        filesById: new Map(),
        outgoingEdgesBySymbolId: new Map(),
      },
    }),
    ...overrides,
  });
}

function candidate(
  symbolId: string,
  rank: number,
  tier: 0 | 1,
  estimates: Partial<Record<"card" | "skeleton" | "hotPath", number>> = {
    card: 10,
    skeleton: 20,
    hotPath: 30,
  },
): ContextCandidate {
  return {
    symbolId,
    path: `src/${symbolId}.ts`,
    rank,
    tier,
    lanes: tier === 0 ? ["exactIdentifier"] : ["symbolFts"],
    estimates,
  };
}

function payload(evidenceContent = "ok"): ContextPayload {
  return {
    status: "complete",
    taskType: "explain",
    retrieval: {
      level: "lexical",
      lanes: [
        { id: "symbolFts", available: true },
        { id: "exactIdentifier", available: true },
      ],
    },
    evidence: [
      {
        rung: "skeleton",
        symbolId: "b",
        path: "src/b.ts",
        rank: 2,
        tier: 1,
        lanes: ["symbolFts"],
        content: evidenceContent,
      },
      {
        rung: "card",
        symbolId: "a",
        path: "src/a.ts",
        rank: 1,
        tier: 0,
        lanes: ["exactIdentifier"],
        content: "a",
      },
    ],
    edges: [
      {
        from: "b",
        to: "a",
        kind: "call",
        confidencePermille: 800,
      },
      {
        from: "a",
        to: "b",
        kind: "call",
        confidencePermille: 900,
      },
    ],
    omitted: {
      total: 0,
      byReason: { budget: 0 },
      highestRanked: [],
    },
    nextActions: [],
  };
}

const TEST_DEFAULT_ESTIMATES = CONTEXT_RUNG_TOKEN_LIMITS;

function expectedRungTokens(
  item: ContextCandidate,
  rung: ContextRung,
): number {
  const shell: ContextEvidence = {
    rung,
    symbolId: item.symbolId,
    path: item.path,
    rank: item.rank,
    tier: item.tier,
    lanes: [...item.lanes],
    content: "",
  };
  return (
    (item.estimates[rung] ?? TEST_DEFAULT_ESTIMATES[rung]) +
    estimateTokens(JSON.stringify(normalizeValue(shell)))
  );
}

function expectedResponseTokens(value: ContextPayload): number {
  return (
    estimateTokens(serializeContextPayload(value)) +
    CONTEXT_MCP_WRAPPER_RESERVE_TOKENS
  );
}

describe("ContextEngineV2 pure contracts", () => {
  it("orders qualified terms before caller and auto-extracted identifiers", () => {
    const request: ContextV2Request = {
      repoId: "repo",
      taskType: "explain",
      taskText: "Find sdl.info, then sdl.workflow and ExistingThing",
      chatMentions: ["caller.symbol", "  ExplicitThing  ", "sdl.info"],
      budget: { maxTokens: 1_400 },
    };

    assert.deepEqual(identifiersForContextRequest(request), [
      "sdl.info",
      "sdl.workflow",
      "caller.symbol",
      "ExplicitThing",
      "xistingThing",
      "ExistingThing",
      "sdl",
      "info",
      "then",
      "workflow",
      "sdlInfo",
      "SdlInfo",
    ]);
  });

  it("keeps generic task words out of Tier 0 without dropping explicit identifiers", () => {
    assert.deepEqual(
      tierZeroMentionsForRequest({
        taskText:
          "Explain TargetHandler through the Code Mode tool surface helper.",
        focusSymbols: ["focused-entry"],
        chatMentions: ["chat-anchor"],
      }),
      ["focused-entry", "chat-anchor", "TargetHandler"],
    );
  });

  it("derives bounded acronym-aware Tier 1 compounds without promoting them to Tier 0", () => {
    const request = {
      taskText: "Trace API_HANDLER_CONSTANT through the service.",
    };

    assert.deepEqual(tierZeroMentionsForRequest(request), [
      "API_HANDLER_CONSTANT",
    ]);
    assert.deepEqual(derivedTierOneMentionsForRequest(request), [
      "APIHandler",
      "HandlerConstant",
    ]);
    assert.ok(
      derivedTierOneMentionsForRequest({
        taskText:
          "Trace A_B_C_D_E_F_G_H_I_J_K_L through the service.",
      }).length <= 8,
    );
  });

  it("keeps one resolved focus-path candidate in Tier 0 under a constrained budget", () => {
    const capacity = focusPathTierZeroCapacity({
      maxTokens: 1,
      explicitTierZeroCount: 8,
      profile: getTaskProfile("explain"),
    });
    const allocation = allocateFocusPathSymbols(
      [
        { path: "src/a.ts", symbolId: "a" },
        { path: "src/b.ts", symbolId: "b" },
      ],
      capacity,
    );

    assert.equal(capacity, 1);
    assert.deepEqual(allocation.tierZeroIds, ["a"]);
    assert.deepEqual(allocation.seedIds, ["a", "b"]);
  });

  it("prices focus-path Tier 0 capacity from the selected profile ladder", () => {
    const profile = getTaskProfile("explain");
    const fullProfileCapacity = focusPathTierZeroCapacity({
      maxTokens: 5_000,
      explicitTierZeroCount: 0,
      profile,
    });
    const cardOnlyCapacity = focusPathTierZeroCapacity({
      maxTokens: 5_000,
      explicitTierZeroCount: 0,
      profile: { ...profile, rungPreference: ["card"] },
    });

    assert.ok(cardOnlyCapacity > fullProfileCapacity);
  });

  it("reserves one complete profile ladder beyond focus-path Tier 0", () => {
    assert.equal(
      focusPathTierZeroCapacity({
        maxTokens: 1_800,
        explicitTierZeroCount: 1,
        profile: getTaskProfile("explain"),
      }),
      1,
    );
  });

  it("allocates exact-file hits round-robin with symbol-ID ordering", () => {
    const hits = Array.from({ length: 10 }, (_, index) => [
      {
        path: "./src/b.ts",
        symbolId: `b-${String(index).padStart(2, "0")}`,
      },
      {
        path: "src\\a.ts",
        symbolId: `a-${String(index).padStart(2, "0")}`,
      },
    ]).flat();
    const allocation = allocateFocusPathSymbols(hits, 4);

    assert.equal(allocation.seedIds.length, 16);
    assert.deepEqual(allocation.seedIds.slice(0, 4), [
      "a-00",
      "b-00",
      "a-01",
      "b-01",
    ]);
    assert.deepEqual(allocation.tierZeroIds, [
      "a-00",
      "b-00",
      "a-01",
      "b-01",
    ]);
  });

  it("declares deterministic profiles matching the existing beam behavior", () => {
    assert.deepEqual(Object.keys(TASK_PROFILES), [
      "debug",
      "review",
      "implement",
      "explain",
    ]);

    for (const taskType of Object.keys(TASK_PROFILES)) {
      const profile = getTaskProfile(
        taskType as keyof typeof TASK_PROFILES,
      );
      assert.equal(profile.direction, "out");
      assert.equal(profile.maxDepth, null);
      assert.equal(profile.rungPreference[0], "card");
      assert.ok(profile.auxiliaryLanes.includes("fileSummary"));
    }

    assert.deepEqual(getTaskProfile("debug").rungPreference, [
      "card",
      "hotPath",
    ]);
    assert.deepEqual(getTaskProfile("review").rungPreference, [
      "card",
      "hotPath",
    ]);
    assert.deepEqual(getTaskProfile("implement").rungPreference, [
      "card",
      "skeleton",
    ]);
    assert.deepEqual(getTaskProfile("explain").rungPreference, [
      "card",
      "skeleton",
    ]);
    assert.equal(getTaskProfile("debug").includeTests, true);
    assert.equal(getTaskProfile("review").includeTests, true);
    assert.equal(getTaskProfile("implement").includeTests, false);
    assert.equal(getTaskProfile("explain").includeTests, false);
  });

  it("honors profile-owned auxiliary lanes in retrieval state", () => {
    const profile = {
      ...getTaskProfile("explain"),
      auxiliaryLanes: [],
    } as const;
    const capabilities = {
      fts: true,
      fileSummaryFts: true,
      vectorNomic: false,
      vectorJinaCode: false,
      vectorByEntityModel: {
        fileSummary: { nomic: true },
      },
      coveragePermille: {
        symbolVector: 0,
        fileSummaryVector: 1000,
      },
    } as never;

    const retrieval = buildRetrievalState(
      capabilities,
      [],
      new Map(),
      profile,
    );
    assert.equal(retrieval.level, "lexical");
    assert.equal(
      retrieval.lanes.some((lane) => lane.id.startsWith("fileSummary")),
      false,
    );
  });

  it("competes eligible marginals across rungs without skipping prerequisites", () => {
    const candidates = [
      candidate("a", 1, 1, { card: 160, skeleton: 420 }),
      candidate("b", 2, 1, { card: 240, skeleton: 340 }),
      candidate("c", 3, 1, { card: 400, skeleton: 180 }),
    ];
    const availableTokens = ["card", "skeleton"].reduce(
      (total, rung) =>
        total +
        expectedRungTokens(
          candidates[0],
          rung as "card" | "skeleton",
        ),
      0,
    );
    const result = selectContextBundles({
      candidates,
      profile: getTaskProfile("explain"),
      availableTokens,
    });

    assert.deepEqual(
      result.selected.map(({ candidate: item, rungs }) => [
        item.symbolId,
        rungs,
      ]),
      [["a", ["card", "skeleton"]]],
    );
    assert.ok(
      result.omitted.some(
        (item) => item.symbolId === "b" && item.rung === "card",
      ),
    );
    assert.ok(
      result.omitted.some(
        (item) => item.symbolId === "c" && item.rung === "card",
      ),
    );
    assert.ok(
      result.selected.every(
        ({ rungs }) =>
          !rungs.includes("skeleton") || rungs.includes("card"),
      ),
    );
  });

  it("leaves room for an exact Tier 1 card after two complete Tier 0 bundles", () => {
    const empty = payload();
    empty.status = "empty";
    empty.retrieval = {
      level: "hybrid",
      lanes: [
        { id: "exactIdentifier", available: true },
        { id: "symbolFts", available: true },
        { id: "symbolVec", available: true, coveragePermille: 1_000 },
        { id: "fileSummaryFts", available: true },
        {
          id: "fileSummaryVec",
          available: true,
          coveragePermille: 1_000,
        },
      ],
    };
    empty.evidence = [];
    empty.edges = [];
    empty.omitted = {
      total: 0,
      byReason: { budget: 0 },
      highestRanked: [],
    };
    empty.nextActions = [];
    const fullLanes = [
      "exactIdentifier",
      "symbolFts",
      "symbolVec",
      "fileSummaryFts",
      "fileSummaryVec",
    ] as const;
    const explicit = {
      ...candidate("a".repeat(64), 1, 0, CONTEXT_RUNG_TOKEN_LIMITS),
      path: "src/mcp/server-instructions.ts",
      lanes: [...fullLanes],
    };
    const focused = {
      ...candidate("b".repeat(64), 2, 0, CONTEXT_RUNG_TOKEN_LIMITS),
      path: "src/code-mode/index.ts",
      lanes: [...fullLanes],
    };
    const exactTierOne = {
      ...candidate("c".repeat(64), 16, 1, CONTEXT_RUNG_TOKEN_LIMITS),
      path: "src/server.ts",
      lanes: [...fullLanes],
    };

    const result = selectContextBundles({
      candidates: [explicit, focused, exactTierOne],
      profile: getTaskProfile("explain"),
      availableTokens:
        1_800 - estimateContextSelectionEnvelopeTokens(empty),
    });

    assert.deepEqual(
      result.selected.map(({ candidate: item, rungs }) => [item.path, rungs]),
      [
        ["src/mcp/server-instructions.ts", ["card", "skeleton"]],
        ["src/code-mode/index.ts", ["card", "skeleton"]],
        ["src/server.ts", ["card"]],
      ],
    );
  });

  it("suppresses Tier 1 when the resolved Tier 0 bundle does not fit", () => {
    const tierZero = candidate("tier-zero", 1, 0);
    const tierOne = candidate("tier-one", 2, 1, {
      card: 1,
      skeleton: 1,
      hotPath: 1,
    });
    tierOne.lanes = ["exactIdentifier"];
    const completeTierZeroCost = ["card", "hotPath"].reduce(
      (total, rung) =>
        total +
        expectedRungTokens(
          tierZero,
          rung as "card" | "hotPath",
        ),
      0,
    );
    const result = selectContextBundles({
      candidates: [tierZero, tierOne],
      profile: getTaskProfile("debug"),
      availableTokens: completeTierZeroCost - 1,
    });

    assert.equal(result.tier0Limited, true);
    assert.ok(
      result.omitted.some(
        (item) =>
          item.symbolId === "tier-zero" &&
          item.rung === "hotPath",
      ),
    );
    assert.ok(
      result.omitted.some(
        (item) => item.symbolId === "tier-one",
      ),
    );
    assert.equal(
      result.selected.some(
        (item) => item.candidate.symbolId === "tier-one",
      ),
      false,
    );
  });

  it("admits exact identifiers by base-card cost and skips non-fitting complete ladders", () => {
    const expensive = candidate("expensive", 1, 1, {
      card: 40,
      skeleton: 2_000,
    });
    const affordable = candidate("affordable", 2, 1, {
      card: 40,
      skeleton: 60,
    });
    const exact = candidate("MCPServer", 100, 1, {
      card: 40,
      skeleton: 2_000,
    });
    exact.lanes = ["exactIdentifier"];
    const affordableCost = ["card", "skeleton"].reduce(
      (total, rung) =>
        total +
        expectedRungTokens(
          affordable,
          rung as "card" | "skeleton",
        ),
      0,
    );
    const exactCardCost = expectedRungTokens(exact, "card");

    const result = selectContextBundles({
      candidates: [expensive, affordable, exact],
      profile: getTaskProfile("explain"),
      availableTokens: affordableCost + exactCardCost,
    });

    assert.deepEqual(
      result.selected.map(({ candidate: item, rungs }) => [
        item.symbolId,
        rungs,
      ]),
      [
        ["affordable", ["card", "skeleton"]],
        ["MCPServer", ["card"]],
      ],
    );
    assert.deepEqual(
      result.omitted
        .filter((item) => item.symbolId === "expensive")
        .map((item) => item.rung),
      ["card", "skeleton"],
    );
  });

  it("upgrades an exact identifier before admitting an unrelated complete bundle", () => {
    const exact = candidate("MCPServer", 2, 1, {
      card: 40,
      skeleton: 120,
    });
    exact.lanes = ["exactIdentifier"];
    const unrelated = candidate("codeModeConfig", 1, 1, {
      card: 10,
      skeleton: 10,
    });
    const availableTokens =
      expectedRungTokens(exact, "card") +
      expectedRungTokens(exact, "skeleton");

    const result = selectContextBundles({
      candidates: [unrelated, exact],
      profile: getTaskProfile("explain"),
      availableTokens,
    });

    assert.deepEqual(
      result.selected.map(({ candidate: item, rungs }) => [
        item.symbolId,
        rungs,
      ]),
      [["MCPServer", ["card", "skeleton"]]],
    );
  });

  it("does not admit a non-exact Tier 1 base card without its complete profile ladder", () => {
    const normal = candidate("normal", 1, 1, {
      card: 1,
      skeleton: 2_000,
    });
    const result = selectContextBundles({
      candidates: [normal],
      profile: getTaskProfile("explain"),
      availableTokens: expectedRungTokens(normal, "card"),
    });

    assert.deepEqual(result.selected, []);
    assert.ok(result.omitted.every((item) => item.symbolId === "normal"));
  });

  it("prioritizes candidate rank over Tier 1 bundle density", () => {
    const rankOne = candidate(
      "a".repeat(64),
      1,
      1,
      CONTEXT_RUNG_TOKEN_LIMITS,
    );
    rankOne.path = "tests/unit/tool-registration.test.ts";
    rankOne.lanes = [
      "symbolFts",
      "symbolVec",
      "fileSummaryFts",
      "fileSummaryVec",
    ];
    const rankThirtyFive = candidate(
      "b".repeat(64),
      35,
      1,
      CONTEXT_RUNG_TOKEN_LIMITS,
    );
    rankThirtyFive.path = "native/index.d.ts";
    rankThirtyFive.lanes = ["symbolFts"];
    const availableTokens = ["card", "hotPath"].reduce(
      (total, rung) =>
        total +
        expectedRungTokens(rankOne, rung as "card" | "hotPath"),
      0,
    );

    const result = selectContextBundles({
      candidates: [rankOne, rankThirtyFive],
      profile: getTaskProfile("debug"),
      availableTokens,
    });

    assert.deepEqual(
      result.selected.map(({ candidate: item, rungs }) => [
        item.symbolId,
        rungs,
      ]),
      [[rankOne.symbolId, ["card", "hotPath"]]],
    );
    assert.deepEqual(
      result.omitted
        .filter((item) => item.symbolId === rankThirtyFive.symbolId)
        .map((item) => item.rung),
      ["card", "hotPath"],
    );
  });

  it("uses symbol IDs as deterministic ties for equal-rank bundles", () => {
    const candidates = [
      candidate("z", 1, 1, { card: 160, skeleton: 420 }),
      candidate("a", 1, 1, { card: 160, skeleton: 420 }),
    ];
    const result = selectContextBundles({
      candidates,
      profile: getTaskProfile("explain"),
      availableTokens: ["card", "skeleton"].reduce(
        (total, rung) =>
          total +
          expectedRungTokens(
            candidates[0],
            rung as "card" | "skeleton",
          ),
        0,
      ),
    });

    assert.deepEqual(
      result.selected.map((item) => item.candidate.symbolId),
      ["a"],
    );
  });

  it("emits executable hot-path recovery arguments", () => {
    assert.deepEqual(
      logicalActionForRung("hotPath", "symbol-id", [
        "targetIdentifier",
      ]),
      {
        id: "code.getHotPath",
        args: {
          symbolId: "symbol-id",
          identifiersToFind: ["targetIdentifier"],
        },
      },
    );
  });

  it("reserves the dynamic canonical envelope before admitting Tier 1", async () => {
    let selectedSymbolIds: string[] = [];
    const estimates = { card: 160, skeleton: 420, hotPath: 300 };
    const explicitA = candidate("explicit-a", 1, 0, estimates);
    const explicitB = candidate("explicit-b", 2, 0, estimates);
    const tierOne = candidate("tier-one", 3, 1, estimates);
    const emptyPayload = payload();
    emptyPayload.status = "empty";
    emptyPayload.taskType = "explain";
    emptyPayload.retrieval.lanes = [
      { id: "symbolFts", available: true },
    ];
    emptyPayload.evidence = [];
    emptyPayload.edges = [];
    const explicitCost = [explicitA, explicitB].reduce(
      (total, item) =>
        total +
        ["card", "skeleton"].reduce(
          (bundle, rung) =>
            bundle +
            expectedRungTokens(
              item,
              rung as "card" | "skeleton",
            ),
          0,
        ),
      0,
    );
    const engine = testContextEngine({
      retrieve: async () => ({
        level: "lexical",
        lanes: [{ id: "symbolFts", available: true }],
        candidates: [explicitA, explicitB, tierOne],
        runtime: {},
      }),
      expand: async ({ candidates }) => candidates,
      hydrate: async ({ selected }) => {
        selectedSymbolIds = selected.map(
          ({ candidate: item }) => item.symbolId,
        );
        return { evidence: [], edges: [], unavailable: [] };
      },
    });

    await engine.buildContext({
      repoId: "repo",
      taskType: "explain",
      taskText: "Explain ExplicitA through ExplicitB.",
      budget: {
        maxTokens:
          estimateContextSelectionEnvelopeTokens(emptyPayload) +
          explicitCost,
      },
    });

    assert.equal(
      estimateContextSelectionEnvelopeTokens(emptyPayload),
      expectedResponseTokens(emptyPayload) + 192,
    );
    assert.deepEqual(selectedSymbolIds, ["explicit-a", "explicit-b"]);
  });

  it("canonicalizes evidence, edges, lanes, and recovery actions", () => {
    const first = payload();
    const second = payload();
    second.evidence.reverse();
    second.edges.reverse();
    second.retrieval.lanes.reverse();

    const firstValue = stableContextValue(first);
    const secondValue = stableContextValue(second);

    assert.deepEqual(firstValue, secondValue);
    assert.equal(
      serializeContextPayload(first),
      serializeContextPayload(second),
    );
  });

  it("evicts in reverse selection order until the exact serialized budget fits", () => {
    const oversized = payload("x".repeat(4_000));
    const result = enforceContextBudget(
      oversized,
      expectedResponseTokens(oversized) - 1,
    );

    assert.equal(result.budgetError, undefined);
    assert.ok(
      result.estimatedTokens <=
        expectedResponseTokens(oversized) - 1,
    );
    assert.equal(result.payload.status, "budgetLimited");
    assert.deepEqual(
      result.payload.evidence.map((item) => item.symbolId),
      ["a"],
    );
    assert.equal(result.payload.omitted.total, 1);
    assert.equal(
      result.payload.omitted.highestRanked[0].action.id,
      "code.getSkeleton",
    );
  });

  it("evicts an optional rung before a lower-ranked base card at the same tier", () => {
    const oversized = payload("x".repeat(4_000));
    const optional = oversized.evidence[0];
    const baseCard = oversized.evidence[1];
    assert.ok(optional);
    assert.ok(baseCard);
    optional.rank = 1;
    optional.tier = 0;
    baseCard.rank = 2;
    baseCard.tier = 0;

    const result = enforceContextBudget(
      oversized,
      expectedResponseTokens(oversized) - 1,
    );

    assert.deepEqual(
      result.payload.evidence.map(({ rung, symbolId }) => [rung, symbolId]),
      [["card", "a"]],
    );
  });

  it("counts canonical metadata and long paths in each rung estimate", () => {
    const content = "x".repeat(350);
    const contentTokens = estimateTokens(JSON.stringify(content));
    const short = candidate("short", 2, 1, {
      card: contentTokens,
      skeleton: 1,
    });
    const long = candidate("long", 1, 1, {
      card: contentTokens,
      skeleton: 1,
    });
    long.path = `src/${"nested/".repeat(80)}long.ts`;
    const actualEvidence = {
      rung: "card" as const,
      symbolId: long.symbolId,
      path: long.path,
      rank: long.rank,
      tier: long.tier,
      lanes: long.lanes,
      content,
    };

    assert.ok(
      expectedRungTokens(long, "card") >
        expectedRungTokens(short, "card"),
    );
    assert.equal(
      estimateContextRungTokens(long, "card"),
      expectedRungTokens(long, "card"),
    );
    assert.ok(
      expectedRungTokens(long, "card") >=
        estimateTokens(JSON.stringify(normalizeValue(actualEvidence))),
    );
    const result = selectContextBundles({
      candidates: [long, short],
      profile: getTaskProfile("explain"),
      availableTokens:
        expectedRungTokens(short, "card") +
        expectedRungTokens(short, "skeleton"),
    });
    assert.deepEqual(
      result.selected.map((item) => item.candidate.symbolId),
      ["short"],
    );
  });

  it("pins wrapper headroom and returns a typed error below the empty envelope", () => {
    const empty = payload();
    empty.status = "empty";
    empty.evidence = [];
    empty.edges = [];
    empty.omitted = {
      total: 0,
      byReason: { budget: 0 },
      highestRanked: [],
    };
    empty.nextActions = [];
    const serialized = serializeContextPayload(empty);
    const wrapped = JSON.stringify({
      content: [{ type: "text", text: serialized }],
    });
    const wrapperTokens =
      estimateTokens(wrapped) - estimateTokens(serialized);
    const minimumTokens = expectedResponseTokens(empty);

    assert.ok(wrapperTokens <= CONTEXT_MCP_WRAPPER_RESERVE_TOKENS);
    assert.equal(estimateContextResponseTokens(empty), minimumTokens);
    const exact = enforceContextBudget(empty, minimumTokens);
    assert.equal(exact.budgetError, undefined);
    assert.equal(exact.estimatedTokens, minimumTokens);
    const below = enforceContextBudget(empty, minimumTokens - 1);
    assert.equal(
      below.budgetError?.error.code,
      "CONTEXT_BUDGET_TOO_SMALL",
    );
    assert.equal(below.budgetError?.error.minimumTokens, minimumTokens);
  });

  it("preserves canonical survivors and prunes dangling edges after eviction", () => {
    const oversized = payload("x".repeat(4_000));
    oversized.evidence.reverse();
    const result = enforceContextBudget(
      oversized,
      expectedResponseTokens(oversized) - 1,
    );
    const symbolIds = new Set(
      result.payload.evidence.map((item) => item.symbolId),
    );

    assert.deepEqual(
      result.payload.evidence,
      [...result.payload.evidence].sort(
        (left, right) =>
          left.tier - right.tier ||
          left.rank - right.rank ||
          left.symbolId.localeCompare(right.symbolId),
      ),
    );
    assert.ok(
      result.payload.edges.every(
        (edge) => symbolIds.has(edge.from) && symbolIds.has(edge.to),
      ),
    );
  });

  it("distinguishes successful-empty retrieval from failed lanes", () => {
    const capabilities = {
      fts: true,
      fileSummaryFts: false,
      vectorNomic: false,
      vectorJinaCode: false,
      vectorByEntityModel: {},
      coveragePermille: {
        symbolVector: 0,
        fileSummaryVector: 0,
      },
    } as never;
    const successfulEmpty = buildRetrievalState(
      capabilities,
      [],
      new Map([
        [
          "symbol:fts",
          { attempted: true, succeeded: true, failed: false },
        ],
      ]),
    );
    const failed = buildRetrievalState(
      capabilities,
      [],
      new Map([
        [
          "symbol:fts",
          { attempted: true, succeeded: false, failed: true },
        ],
      ]),
    );

    assert.equal(successfulEmpty.level, "lexical");
    assert.equal(failed.level, "insufficient");
  });

  it("reports all configured-off lanes as insufficient despite healthy indexes", () => {
    const result = buildRetrievalState(
      {
        fts: true,
        fileSummaryFts: true,
        vectorNomic: true,
        vectorJinaCode: true,
        vectorByEntityModel: {
          symbol: { nomic: true, jinacode: true },
          fileSummary: { nomic: true },
        },
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
      } as never,
      [],
      new Map([
        [
          "symbol:fts",
          {
            available: false,
            attempted: false,
            succeeded: false,
            failed: false,
          },
        ],
        [
          "symbol:vector:jinacode",
          {
            available: false,
            attempted: false,
            succeeded: false,
            failed: false,
          },
        ],
        [
          "fileSummary:fts",
          {
            available: false,
            attempted: false,
            succeeded: false,
            failed: false,
          },
        ],
        [
          "fileSummary:vector:nomic",
          {
            available: false,
            attempted: false,
            succeeded: false,
            failed: false,
          },
        ],
      ]),
    );

    assert.equal(result.level, "insufficient");
    assert.equal(
      result.lanes
        .filter((lane) => lane.id !== "exactIdentifier")
        .some((lane) => lane.available),
      false,
    );
  });

  it("reports exact-only candidates as graph-only when retrieval lanes are off", () => {
    const result = buildRetrievalState(
      {
        fts: true,
        fileSummaryFts: true,
        vectorNomic: true,
        vectorJinaCode: true,
        vectorByEntityModel: {
          symbol: { nomic: true, jinacode: true },
          fileSummary: { nomic: true },
        },
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 1000,
        },
      } as never,
      [candidate("exact", 1, 0)],
      new Map([
        [
          "symbol:fts",
          {
            available: false,
            attempted: false,
            succeeded: false,
            failed: false,
          },
        ],
        [
          "symbol:vector:jinacode",
          {
            available: false,
            attempted: false,
            succeeded: false,
            failed: false,
          },
        ],
      ]),
    );

    assert.equal(result.level, "graph-only");
    assert.equal(
      result.lanes.find((lane) => lane.id === "graph")?.available,
      true,
    );
    assert.equal(
      result.lanes.find((lane) => lane.id === "symbolFts")?.available,
      false,
    );
    assert.equal(
      result.lanes.find((lane) => lane.id === "symbolVec")?.available,
      false,
    );
  });

  it("degrades when one attempted retrieval lane fails", () => {
    const result = buildRetrievalState(
      {
        fts: true,
        fileSummaryFts: false,
        vectorNomic: true,
        vectorJinaCode: false,
        vectorByEntityModel: {},
        coveragePermille: {
          symbolVector: 1000,
          fileSummaryVector: 0,
        },
      } as never,
      [],
      new Map([
        [
          "symbol:fts",
          { attempted: true, succeeded: true, failed: false },
        ],
        [
          "symbol:vector:nomic",
          { attempted: true, succeeded: false, failed: true },
        ],
      ]),
    );

    assert.equal(result.level, "hybrid-partial");
  });

  it("does not report overlay lexical results as durable symbol FTS", () => {
    const overlayCandidate = candidate("draft", 1, 1);
    overlayCandidate.lanes = ["overlay"];
    const result = buildRetrievalState(undefined, [overlayCandidate]);

    assert.equal(result.level, "lexical");
    assert.equal(
      result.lanes.find((lane) => lane.id === "symbolFts")?.available,
      false,
    );
    assert.equal(
      result.lanes.find((lane) => lane.id === "overlay")?.available,
      true,
    );
  });

  it("hydrates the base card rung at signature detail", async () => {
    let requestedDetail: unknown;
    const result = await hydrateContextBundles(
      {
        conn: {} as never,
        repoId: "repo",
        versionId: "v1",
        selected: [
          {
            candidate: candidate("focus", 1, 0),
            rungs: ["card"],
          },
        ],
        identifiers: [],
        overlaySnapshot: {
          repoId: "repo",
          touchedFileIds: new Set(),
          symbolsById: new Map(),
          filesById: new Map(),
          outgoingEdgesBySymbolId: new Map(),
        },
      },
      {
        loadCards: async (
          _conn,
          _symbolIds,
          _versionId,
          _repoId,
          detail,
        ) => {
          requestedDetail = detail;
          return {
            cards: [
              {
                symbolId: "focus",
                repoId: "repo",
                file: "src/focus.ts",
                range: {
                  startLine: 1,
                  startCol: 0,
                  endLine: 3,
                  endCol: 1,
                },
                kind: "function",
                name: "focus",
                exported: true,
                signature: { name: "focus" },
                summary: "Focus summary",
                deps: { imports: [], calls: [] },
                detailLevel: "signature",
                version: {
                  ledgerVersion: "v1",
                  astFingerprint: "fingerprint",
                },
              },
            ],
            sliceDepsBySymbol: new Map(),
          };
        },
        loadEdges: async () => new Map(),
      },
    );

    assert.equal(requestedDetail, "signature");
    assert.deepEqual(result.evidence[0]?.content, {
      kind: "function",
      name: "focus",
      signature: { name: "focus" },
      summary: "Focus summary",
    });
  });

  it("forwards estimate-aligned caps while preserving code-bearing rungs", async () => {
    let skeletonOptions:
      | { maxLines?: number; maxTokens?: number }
      | undefined;
    let hotPathOptions:
      | { maxLines?: number; maxTokens?: number }
      | undefined;
    const result = await hydrateContextBundles(
      {
        conn: {} as never,
        repoId: "repo",
        versionId: "v1",
        selected: [
          {
            candidate: candidate("focus", 1, 0),
            rungs: ["skeleton", "hotPath"],
          },
        ],
        identifiers: ["focus"],
        overlaySnapshot: {
          repoId: "repo",
          touchedFileIds: new Set(),
          symbolsById: new Map(),
          filesById: new Map(),
          outgoingEdgesBySymbolId: new Map(),
        },
      },
      {
        loadCards: async () => ({
          cards: [],
          sliceDepsBySymbol: new Map(),
        }),
        loadEdges: async () => new Map(),
        loadSkeleton: async (_repoId, _symbolId, options) => {
          skeletonOptions = options;
          return {
            skeleton: "function focus() {}",
            actualRange: {
              startLine: 1,
              startCol: 0,
              endLine: 1,
              endCol: 19,
            },
            estimatedTokens: 4,
            originalLines: 1,
            truncated: false,
            skeletonLinesConsumed: 1,
          };
        },
        loadHotPath: async (
          _repoId,
          _symbolId,
          _identifiers,
          options,
        ) => {
          hotPathOptions = options;
          return {
            excerpt: "focus();",
            actualRange: {
              startLine: 1,
              startCol: 0,
              endLine: 1,
              endCol: 8,
            },
            estimatedTokens: 2,
            matchedIdentifiers: ["focus"],
            matchedLineNumbers: [1],
            truncated: false,
          };
        },
      },
    );

    assert.deepEqual(skeletonOptions, {
      maxLines: 100,
      maxTokens: 128,
    });
    assert.deepEqual(hotPathOptions, {
      maxLines: 80,
      maxTokens: 300,
    });
    assert.deepEqual(
      result.evidence.map(({ rung, content }) => [rung, content]),
      [
        [
          "skeleton",
          {
            skeleton: "function focus() {}",
            actualRange: {
              startLine: 1,
              startCol: 0,
              endLine: 1,
              endCol: 19,
            },
            estimatedTokens: 4,
            originalLines: 1,
            truncated: false,
            skeletonLinesConsumed: 1,
          },
        ],
        [
          "hotPath",
          {
            excerpt: "focus();",
            actualRange: {
              startLine: 1,
              startCol: 0,
              endLine: 1,
              endCol: 8,
            },
            estimatedTokens: 2,
            matchedIdentifiers: ["focus"],
            matchedLineNumbers: [1],
            truncated: false,
          },
        ],
      ],
    );
  });
});

describe("ContextEngineV2 orchestration", () => {
  it("captures durable hydration inputs before committing the read snapshot", async () => {
    const events: string[] = [];
    let snapshotOpen = false;
    const overlaySnapshot = {
      repoId: "repo",
      touchedFileIds: new Set<string>(),
      symbolsById: new Map(),
      filesById: new Map(),
      outgoingEdgesBySymbolId: new Map(),
    };
    const engine = testContextEngine({
      runReadSnapshot: async (_repoId, fn) => {
        events.push("begin");
        snapshotOpen = true;
        const result = await fn({ overlaySnapshot });
        events.push("commit");
        snapshotOpen = false;
        return result;
      },
      retrieve: async (_request, _profile, runtime) => {
        assert.equal(snapshotOpen, true);
        assert.equal(runtime.overlaySnapshot, overlaySnapshot);
        events.push("retrieve");
        return {
          level: "lexical",
          lanes: [{ id: "symbolFts", available: true }],
          candidates: [candidate("focus", 1, 0)],
          runtime,
        };
      },
      expand: async ({ candidates }) => {
        assert.equal(snapshotOpen, true);
        events.push("expand");
        return candidates;
      },
      prepareHydration: async ({ selected, runtime }) => {
        assert.equal(snapshotOpen, true);
        assert.equal(runtime.overlaySnapshot, overlaySnapshot);
        events.push("prepare");
        return {
          selected: Object.freeze([...selected]),
          cards: Object.freeze([]),
          durableEdges: new Map(),
          skeletons: new Map(),
          hotPaths: new Map(),
          overlaySnapshot,
        };
      },
      hydrate: async () => {
        assert.equal(snapshotOpen, false);
        events.push("render");
        return { evidence: [], edges: [], unavailable: [] };
      },
    });

    await engine.buildContext({
      repoId: "repo",
      taskType: "review",
      taskText: "review focus",
      focusSymbols: ["focus"],
      budget: { maxTokens: 1_400 },
    });

    assert.deepEqual(events, [
      "begin",
      "retrieve",
      "expand",
      "prepare",
      "commit",
      "render",
    ]);
  });

  it("runs one candidate stage, expands once, and hydrates selected bundles only", async () => {
    let retrieveCalls = 0;
    let expandCalls = 0;
    let hydrateCalls = 0;
    const engine = testContextEngine({
      retrieve: async () => {
        retrieveCalls++;
        return {
          level: "hybrid",
          lanes: [
            { id: "symbolFts", available: true },
            {
              id: "symbolVec",
              available: true,
              coveragePermille: 1000,
            },
          ],
          candidates: [
            candidate("focus", 1, 0, {
              card: 10,
              skeleton: 10,
              hotPath: 10,
            }),
            candidate("retrieved", 2, 1, {
              card: 10_000,
              skeleton: 10_000,
              hotPath: 10_000,
            }),
          ],
          runtime: {},
        };
      },
      expand: async ({ candidates }) => {
        expandCalls++;
        return [
          ...candidates,
          candidate("expanded", 3, 1, {
            card: 10_000,
            skeleton: 10_000,
            hotPath: 10_000,
          }),
        ];
      },
      hydrate: async ({ selected }) => {
        hydrateCalls++;
        assert.deepEqual(
          selected.map((item) => item.candidate.symbolId),
          ["focus"],
        );
        return {
          evidence: selected.flatMap((bundle) =>
            bundle.rungs.map((rung) => ({
              rung,
              symbolId: bundle.candidate.symbolId,
              path: bundle.candidate.path,
              rank: bundle.candidate.rank,
              tier: bundle.candidate.tier,
              lanes: bundle.candidate.lanes,
              content: `${rung}:${bundle.candidate.symbolId}`,
            })),
          ),
          edges: [],
          unavailable: [],
        };
      },
    });

    const result = await engine.buildContext({
      repoId: "repo",
      taskType: "debug",
      taskText: "debug focus",
      budget: { maxTokens: 2_000 },
      focusSymbols: ["focus"],
    });

    assert.ok(!("isError" in result));
    assert.equal(retrieveCalls, 1);
    assert.equal(expandCalls, 1);
    assert.equal(hydrateCalls, 1);
    assert.equal(result.status, "budgetLimited");
    assert.deepEqual(
      [...new Set(result.evidence.map((item) => item.symbolId))],
      ["focus"],
    );
    assert.ok(
      result.omitted.highestRanked.some(
        (item) => item.symbolId === "retrieved",
      ),
    );
    assert.equal(result.omitted.highestRanked.length, 1);
    assert.equal(result.nextActions.length, 1);
  });

  it("returns empty only after a healthy lane completes with no candidates", async () => {
    const engine = testContextEngine({
      retrieve: async () => ({
        level: "lexical",
        lanes: [{ id: "symbolFts", available: true }],
        candidates: [],
        runtime: {},
      }),
    });

    const result = await engine.buildContext({
      repoId: "repo",
      taskType: "explain",
      taskText: "nothing matches",
      budget: { maxTokens: 700 },
    });

    assert.ok(!("isError" in result));
    assert.equal(result.status, "empty");
    assert.deepEqual(result.evidence, []);
  });

  it("returns a typed budget error before expanding below the empty envelope", async () => {
    let expanded = false;
    const lanes = [{ id: "symbolFts" as const, available: true }];
    const empty = payload();
    empty.status = "empty";
    empty.taskType = "explain";
    empty.retrieval.lanes = lanes;
    empty.evidence = [];
    empty.edges = [];
    const minimumTokens = expectedResponseTokens(empty);
    const engine = testContextEngine({
      retrieve: async () => ({
        level: "lexical",
        lanes,
        candidates: [candidate("candidate", 1, 1)],
        runtime: {},
      }),
      expand: async ({ candidates }) => {
        expanded = true;
        return candidates;
      },
    });

    const result = await engine.buildContext({
      repoId: "repo",
      taskType: "explain",
      taskText: "explain candidate",
      budget: { maxTokens: minimumTokens - 1 },
    });

    assert.equal(expanded, false);
    assert.ok("isError" in result);
    assert.equal(result.error.code, "CONTEXT_BUDGET_TOO_SMALL");
    assert.equal(result.error.minimumTokens, minimumTokens);
  });

  it("returns a retryable backend error when every retrieval lane fails", async () => {
    const request = {
      repoId: "repo",
      taskType: "review" as const,
      taskText: "review",
      budget: { maxTokens: 700 },
      focusPaths: ["src/context/engine.ts"],
      chatMentions: ["ContextEngineV2"],
    };
    const engine = testContextEngine({
      retrieve: async () => ({
        level: "insufficient",
        lanes: [
          { id: "symbolFts", available: false },
          { id: "symbolVec", available: false, coveragePermille: 0 },
        ],
        candidates: [],
        runtime: {},
      }),
    });

    const result = await engine.buildContext(request);

    assert.ok("isError" in result);
    assert.equal(result.isError, true);
    assert.equal(
      result.error.code,
      "CONTEXT_RETRIEVAL_BACKEND_FAILED",
    );
    assert.doesNotMatch(result.error.message, /safe-rebuild|index refresh/i);
    assert.deepEqual(
      result.error.recovery.map((action) => action.id),
      ["repo.status", "context"],
    );
    assert.deepEqual(result.error.recovery[1]?.args, request);
  });

  it("maps the exact graph availability failure to recovery", async () => {
    const engine = testContextEngine({
      retrieve: async () => {
        throw new GraphRetrievalUnavailableError(
          "Graph retrieval is unavailable for repository repo because integrity is not established for the latest version. For a new unindexed repository, run one incremental refresh. For a populated graph, stop SDL-MCP and run `sdl-mcp index --force --safe-rebuild <absolute-new-path>`.",
        );
      },
    });

    const result = await engine.buildContext({
      repoId: "repo",
      taskType: "review",
      taskText: "review",
      budget: { maxTokens: 700 },
    });

    assert.ok("isError" in result);
    assert.equal(result.error.code, "CONTEXT_RETRIEVAL_INSUFFICIENT");
  });

  it("propagates unrelated typed indexing failures", async () => {
    const failure = new IndexError("failed to persist symbol batch");
    const engine = testContextEngine({
      retrieve: async () => {
        throw failure;
      },
    });

    await assert.rejects(
      engine.buildContext({
        repoId: "repo",
        taskType: "review",
        taskText: "review",
        budget: { maxTokens: 700 },
      }),
      (error: unknown) => error === failure,
    );
  });

  it("propagates unexpected retrieval failures", async () => {
    const failure = new Error("unexpected database failure");
    const engine = testContextEngine({
      retrieve: async () => {
        throw failure;
      },
    });

    await assert.rejects(
      engine.buildContext({
        repoId: "repo",
        taskType: "review",
        taskText: "review",
        budget: { maxTokens: 700 },
      }),
      (error) => error === failure,
    );
  });
});
