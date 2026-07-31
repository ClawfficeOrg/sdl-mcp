# Tight-Budget Context and Action-Search Paging Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep rank-1 exact context evidence under tight budgets, expose concrete hot-path relationships for explain requests, and make token-truncated action-search pages directly pageable.

**Architecture:** Reuse the existing context selectors, task profiles, action-search handler, Zod output schema, and model projection. Change only ordering/profile constants and paging metadata; retain final budget enforcement, graph semantics, and the current catalog ranking algorithm.

**Tech Stack:** TypeScript ESM, Zod, Node.js built-in test runner, SDL-MCP determinism fixtures, Markdown documentation.

---

## File map

- Modify `src/context/select.ts`: admit exact base cards in deterministic candidate-rank order.
- Modify `src/context/profiles.ts`: make `explain` use the existing hot-path rung.
- Modify `tests/unit/context-v2.test.ts`: cover competing exact candidates and the explain-profile contract.
- Modify `src/code-mode/index.ts`: return paging metadata and advertise it in `ACTION_SEARCH_OUTPUT_SCHEMA`.
- Modify `src/mcp/context-response-projection.ts`: preserve paging metadata for model-facing action-search results.
- Modify `tests/unit/mcp-action-search.test.ts`: page through the full catalog using `nextOffset`.
- Modify `tests/unit/code-mode-regressions.test.ts`: verify registered output-schema parity.
- Modify `tests/unit/context-response-projection.test.ts`: verify paging projection and response-key order.
- Modify `tests/integration/determinism.fixtures.json`: add a stable truncated full-detail paging request.
- Modify `tests/integration/determinism.test.ts`: assert the paging fixture actually exercises `hasMore` and `nextOffset`.
- Modify `docs/mcp-tools-reference.md`: correct and document the paging contract.

No new files, dependencies, abstractions, or graph edges are needed.

## Chunk 1: Context rank and relationship evidence

### Task 1: Preserve exact-candidate rank under a tight budget

**Files:**
- Modify: `tests/unit/context-v2.test.ts` near the existing exact-identifier selection tests
- Modify: `src/context/select.ts:310-325`

- [ ] **Step 1: Write the failing rank-order regression**

Add this test beside `admits exact identifiers by base-card cost and skips non-fitting complete ladders`:

```ts
it("admits competing exact base cards in candidate-rank order", () => {
  const rankOne = candidate("rank-one", 1, 1, {
    card: 100,
    skeleton: 2_000,
  });
  const rankTwo = candidate("rank-two", 2, 1, {
    card: 10,
    skeleton: 20,
  });
  rankOne.lanes = ["exactIdentifier"];
  rankTwo.lanes = ["exactIdentifier"];

  const result = selectContextBundles({
    candidates: [rankOne, rankTwo],
    profile: getTaskProfile("explain"),
    availableTokens: expectedRungTokens(rankOne, "card"),
  });

  assert.deepEqual(
    result.selected.map(({ candidate: item, rungs }) => [item.symbolId, rungs]),
    [["rank-one", ["card"]]],
  );
});
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```powershell
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2.test.ts
```

Expected: FAIL because the cheaper `rank-two` card is selected before `rank-one`.

- [ ] **Step 3: Implement the minimum ordering fix**

In `selectTierOne`, change only the exact-base-card sort:

```ts
const exactIdentifiers = candidates
  .filter((candidate) => candidate.lanes.includes("exactIdentifier"))
  .map(
    (candidate): MarginalRung => ({
      candidate,
      rung: baseRung,
      rungIndex: 0,
    }),
  )
  .sort((left, right) => compareCandidate(left.candidate, right.candidate));
```

Do not change the later marginal-rung queue; it must continue using `compareValuePerToken`.

- [ ] **Step 4: Build and verify the regression passes**

Run:

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2.test.ts
```

Expected: build succeeds and the complete context-v2 file passes.

### Task 2: Make explain requests return concrete hot paths

**Files:**
- Modify: `tests/unit/context-v2.test.ts:304-342`
- Modify: `src/context/profiles.ts:35-41`

- [ ] **Step 1: Isolate structural-selector tests from the explain profile**

These existing tests exercise the `["card", "skeleton"]` ladder rather than explain semantics. Change their `getTaskProfile("explain")` calls to `getTaskProfile("implement")` before changing production code:

- `competes eligible marginals across rungs without skipping prerequisites`
- `leaves room for an exact Tier 1 card after two complete Tier 0 bundles`
- `admits exact identifiers by base-card cost and skips non-fitting complete ladders`
- `upgrades an exact identifier before admitting an unrelated complete bundle`
- `counts canonical metadata and long paths in each rung estimate`

Do not bulk-replace other explain-profile calls.

Update the existing profile expectation:

```ts
assert.deepEqual(getTaskProfile("explain").rungPreference, [
  "card",
  "hotPath",
]);
```

- [ ] **Step 2: Add a failing engine/hydration regression**

Use the existing `testContextEngine` helper so the test proves that an explain request carries the hot-path rung through selection and hydration:

```ts
it("hydrates explain requests with concrete hot-path evidence", async () => {
  const focus = candidate("MCPServer", 1, 0, { card: 10, hotPath: 20 });
  const engine = testContextEngine({
    retrieve: async (_request, _profile, runtime) => ({
      level: "lexical",
      lanes: [{ id: "exactIdentifier", available: true }],
      candidates: [focus],
      runtime,
    }),
    expand: async ({ candidates }) => candidates,
    hydrate: async ({ selected }) => ({
      evidence: selected.flatMap(({ candidate: item, rungs }) =>
        rungs.map(
          (rung): ContextEvidence => ({
            rung,
            symbolId: item.symbolId,
            path: item.path,
            rank: item.rank,
            tier: item.tier,
            lanes: item.lanes,
            content:
              rung === "hotPath"
                ? { excerpt: "`${SDL_MCP_SERVER_INSTRUCTIONS}\\n\\n${description}`" }
                : { kind: "class", name: "MCPServer" },
          }),
        ),
      ),
      edges: [],
      unavailable: [],
    }),
  });

  const result = await engine.buildContext({
    repoId: "repo",
    taskType: "explain",
    taskText: "Explain how MCPServer consumes SDL_MCP_SERVER_INSTRUCTIONS",
    chatMentions: ["MCPServer", "SDL_MCP_SERVER_INSTRUCTIONS"],
    budget: { maxTokens: 2_400 },
  });

  assert.ok("evidence" in result);
  assert.equal(
    result.evidence.some(
      (item) =>
        item.rung === "hotPath" &&
        JSON.stringify(item.content).includes("SDL_MCP_SERVER_INSTRUCTIONS"),
    ),
    true,
  );
  assert.equal(result.evidence.some((item) => item.rung === "skeleton"), false);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run the direct context-v2 test command.

Expected: only the updated explain-profile assertion and new hydration regression fail; the five structural-selector tests still pass with the implement profile.

- [ ] **Step 4: Change the profile constant**

In `TASK_PROFILES.explain`, make the single production change:

```ts
explain: Object.freeze({
  taskType: "explain",
  rungPreference: ["card", "hotPath"] as const,
  ...SHARED_BEAM_BEHAVIOR,
  includeTests: false,
  auxiliaryLanes: ["fileSummary"] as const,
}),
```

Leave the `implement` profile on `["card", "skeleton"]`.

- [ ] **Step 5: Build and run the focused context tests**

Run:

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2.test.ts
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/context-code-snapshot.test.ts
```

Expected: both test files pass, including concrete hot-path evidence and no explain-profile skeleton evidence.

- [ ] **Step 6: Commit Chunk 1**

```powershell
git add -- src/context/select.ts src/context/profiles.ts tests/unit/context-v2.test.ts
git commit -m "fix(context): preserve exact rank and explain relationships"
```


## Chunk 2: Public action-search paging contract

### Task 3: Add handler and output-schema paging metadata

**Files:**
- Modify: `tests/unit/mcp-action-search.test.ts:425-470`
- Modify: `tests/unit/code-mode-regressions.test.ts:84-131`
- Modify: `src/code-mode/index.ts:118-248,380-390`

- [ ] **Step 1: Extend the bounded paging test before production code**

Change its page type to include:

```ts
offset: number;
limit: number;
nextOffset?: number;
```

After the existing loop adds the page's actions to `seen`, replace the manual increment with contract assertions:

```ts
assert.equal(page.offset, offset);
assert.equal(page.limit, 50);
if (page.hasMore) {
  assert.notEqual(page.nextOffset, undefined);
  assert.equal(page.nextOffset, offset + page.actions.length);
  offset = page.nextOffset as number;
} else {
  assert.equal(Object.hasOwn(page, "nextOffset"), false);
  assert.equal(offset + page.actions.length, page.total);
  assert.equal(seen.size, page.total);
}
```

This proves terminal omission rather than accepting a present-but-undefined property.

- [ ] **Step 2: Extend the registered-schema regression**

In the fake `registerTool`, capture the seventh `outputSchema` parameter:

```ts
let outputSchema: {
  parse(value: unknown): Record<string, unknown>;
} | null = null;
```

After invoking the first page, parse it and prove both survival and approved placement:

```ts
assert.ok(outputSchema);
const parsed = outputSchema.parse(firstPage);
assert.equal(parsed.offset, 0);
assert.equal(parsed.limit, 2);
assert.equal(parsed.nextOffset, 2);
const tokenEstimateIndex = Object.keys(parsed).indexOf("tokenEstimate");
assert.deepEqual(Object.keys(parsed).slice(tokenEstimateIndex, tokenEstimateIndex + 4), [
  "tokenEstimate",
  "offset",
  "limit",
  "nextOffset",
]);
```

- [ ] **Step 3: Run both tests and verify they fail for missing fields**

Run:

```powershell
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/mcp-action-search.test.ts tests/unit/code-mode-regressions.test.ts
```

Expected: FAIL because the handler and output schema omit the paging fields.

- [ ] **Step 4: Add paging fields to the handler**

Compute `hasMore` once before the return object:

```ts
const hasMore = filteredRanked.length > offset + ranked.length;
```

Preserve existing key order and append the new paging keys after `tokenEstimate`:

```ts
hasMore,
tokenEstimate: estimateTokens(JSON.stringify(ranked)),
offset,
limit: args.limit,
...(hasMore ? { nextOffset: offset + ranked.length } : {}),
```

Do not use `offset + args.limit`: token budgeting may return fewer actions than the requested limit.

- [ ] **Step 5: Add optional fields to `ACTION_SEARCH_OUTPUT_SCHEMA`**

Add these after `tokenEstimate`:

```ts
offset: z.number().int().nonnegative().optional(),
limit: z.number().int().positive().optional(),
nextOffset: z.number().int().nonnegative().optional(),
```

They remain optional because summary-only results use a different shape.

- [ ] **Step 6: Build and verify handler/schema tests pass**

Run:

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/mcp-action-search.test.ts tests/unit/code-mode-regressions.test.ts
```

Expected: both files pass and the existing token ceiling remains enforced.

### Task 4: Preserve paging fields through model projection

**Files:**
- Modify: `tests/unit/context-response-projection.test.ts`
- Modify: `src/mcp/context-response-projection.ts:813-845`

- [ ] **Step 1: Add a failing projection/key-order regression**

Add:

```ts
it("preserves action-search paging metadata in stable key order", () => {
  const projected = projectToolResultForModelContent("sdl.action.search", {
    actions: [{ action: "repo.status", schemaSummary: { fields: [] } }],
    total: 46,
    hasMore: true,
    tokenEstimate: 100,
    offset: 0,
    limit: 50,
    nextOffset: 1,
  }) as Record<string, unknown>;

  assert.deepEqual(Object.keys(projected), [
    "actions",
    "total",
    "hasMore",
    "offset",
    "limit",
    "nextOffset",
  ]);
  assert.equal(projected.nextOffset, 1);
});
```

- [ ] **Step 2: Run the projection test and verify it fails**

```powershell
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/context-response-projection.test.ts
```

Expected: FAIL because the three paging fields are not copied.

- [ ] **Step 3: Add the existing copy helper calls**

After copying `hasMore`, add:

```ts
copyIfPresent(result, projected, "offset");
copyIfPresent(result, projected, "limit");
copyIfPresent(result, projected, "nextOffset");
```

Remove the unused action-search `nextCursor` copy if no other action-search producer returns it; do not return both cursor names.

- [ ] **Step 4: Build and run all Chunk 2 tests**

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/mcp-action-search.test.ts tests/unit/code-mode-regressions.test.ts tests/unit/context-response-projection.test.ts
```

Expected: all focused files pass.

- [ ] **Step 5: Commit Chunk 2**

```powershell
git add -- src/code-mode/index.ts src/mcp/context-response-projection.ts tests/unit/mcp-action-search.test.ts tests/unit/code-mode-regressions.test.ts tests/unit/context-response-projection.test.ts
git commit -m "fix(code-mode): expose action-search paging offsets"
```

## Chunk 3: Determinism, documentation, and live acceptance

### Task 5: Cover the changed public contract

**Files:**
- Modify: `tests/integration/determinism.fixtures.json:9-19`
- Modify: `tests/integration/determinism.test.ts` inside `runLeg`
- Modify: `docs/mcp-tools-reference.md:66-84`

- [ ] **Step 1: Add the deterministic truncated-page fixture**

Add a second `sdl.action.search` call:

```json
{
  "tool": "sdl.action.search",
  "args": {
    "query": "*",
    "limit": 50,
    "offset": 0,
    "includeSchemas": true,
    "includeExamples": true,
    "detail": "full",
    "maxTokens": 2000
  }
}
```

- [ ] **Step 2: Assert the fixture actually exercises paging**

In `runLeg`, split the tool call from canonicalization. For the broad full-detail fixture, assert the structured page before storing it:

```ts
const response = await callToolStrict(server.client, call.tool, args);
if (
  call.tool === "sdl.action.search" &&
  typeof args === "object" &&
  args !== null &&
  (args as Record<string, unknown>).query === "*"
) {
  const structuredContent = (
    response as { structuredContent?: unknown }
  ).structuredContent;
  assert.ok(
    structuredContent &&
      typeof structuredContent === "object" &&
      !Array.isArray(structuredContent),
  );
  const page = structuredContent as Record<string, unknown>;
  assert.equal(page.hasMore, true);
  assert.ok(Array.isArray(page.actions));
  assert.equal(
    page.nextOffset,
    (page.offset as number) + page.actions.length,
  );
}
runs.push(canonical(response));
```

This prevents a stable but non-truncated fixture from satisfying the determinism gate.

- [ ] **Step 3: Correct and expand the public reference**

Document the exact `ActionSearchRequestSchema` controls:

- `limit`: integer 1–50, default 20;
- `detail`: `compact | full`, default `compact`;
- `maxTokens`: integer 500–32,000, default 4,000.

Change the response shape to:

```md
**Response:** `{ actions, total, hasMore, tokenEstimate, offset, limit, nextOffset? }`
```

Explain that full-detail token budgeting can return fewer actions than `limit`, so callers must reuse `nextOffset` until `hasMore` is false.

- [ ] **Step 4: Run deterministic and documentation checks**

```powershell
npm.cmd run build
node.exe --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts
npm.cmd run docs:tools:check
```

Expected: the paging assertion runs, determinism repeats are byte-identical, and documentation checks pass.

- [ ] **Step 5: Commit contract coverage**

```powershell
git add -- tests/integration/determinism.fixtures.json tests/integration/determinism.test.ts docs/mcp-tools-reference.md
git commit -m "docs: document and verify action-search paging"
```

### Task 6: Run repository and live acceptance gates

**Files:**
- No production edits expected

- [ ] **Step 1: Run affected repository gates**

Use the `test-scope` skill to confirm the affected suite, then run at minimum:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run docs:tools:check
node.exe --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2.test.ts tests/unit/context-code-snapshot.test.ts tests/unit/mcp-action-search.test.ts tests/unit/code-mode-regressions.test.ts tests/unit/context-response-projection.test.ts tests/integration/determinism.test.ts
git diff --check
```

Expected: all commands pass; lint has no new errors.

- [ ] **Step 2: Verify graph health before relevance claims**

Call `repo.status` and require:

```text
derivedState.graphIntegrityState = "verified"
derivedState.stale = false
```

Do not refresh or rebuild a current verified graph.

- [ ] **Step 3: Run the competing-exact rank probes at 900 and 1,200 tokens**

For both budgets, call `sdl.context` with the relationship payload that fails before implementation:

```json
{
  "repoId": "sdl-mcp",
  "taskType": "explain",
  "taskText": "Explain the concrete relationship between SDL_MCP_SERVER_INSTRUCTIONS and MCPServer. Show where MCPServer consumes the instructions.",
  "chatMentions": ["SDL_MCP_SERVER_INSTRUCTIONS", "MCPServer"],
  "budget": { "maxTokens": 900 },
  "responseMode": "inline",
  "refsMode": "off",
  "wireFormat": "json"
}
```

Before the fix, the 900-token call returns rank-2 `MCPServer` and reports rank-1 `SDL_MCP_SERVER_INSTRUCTIONS` as budget-omitted. After the fix, assert rank 1 is retained as the first evidence item and no lower-ranked base card displaces it. Repeat at 1,200 tokens and assert both named base cards are present in rank order.

- [ ] **Step 4: Run the 2,400-token relationship probe**

```json
{
  "repoId": "sdl-mcp",
  "taskType": "explain",
  "taskText": "Explain the concrete relationship between SDL_MCP_SERVER_INSTRUCTIONS and MCPServer. Show where MCPServer consumes the instructions.",
  "chatMentions": ["SDL_MCP_SERVER_INSTRUCTIONS", "MCPServer"],
  "budget": { "maxTokens": 2400 },
  "responseMode": "inline",
  "refsMode": "off",
  "wireFormat": "json"
}
```

Assert both named symbols are selected and the `MCPServer` hot path from `src/server.ts` contains `SDL_MCP_SERVER_INSTRUCTIONS`. Any suggested next action must not target an unrelated HTTP symbol.

- [ ] **Step 5: Run the full-detail paging probe**

Call `sdl.action.search` with `query: "*"`, `detail: "full"`, schemas/examples enabled, and `limit: 50`. Repeatedly pass `nextOffset` until `hasMore` is false. Assert every nonterminal cursor equals `offset + actions.length`, the terminal response omits it, there are no gaps or duplicates, and the final seen count equals `total`.

- [ ] **Step 6: Verify final repository state**

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
@(git log --format='%h' origin/main..HEAD).Count
```

Expected: the worktree is clean and the ahead range contains exactly five local commits: approved design, approved implementation plan, Chunk 1, Chunk 2, and Chunk 3. Do not push or open a PR unless separately requested.
