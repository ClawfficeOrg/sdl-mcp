# Context Evidence Budget Ranking Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sdl.context` admit complete non-exact Tier 1 evidence bundles by retrieval rank so focused rank-1 contract tests cannot be displaced by compact lower-ranked symbols.

**Architecture:** Keep retrieval, hydration, and exact final budget enforcement unchanged. Change only the shared Tier 1 whole-bundle admission order in `src/context/select.ts`; retain value-per-token ordering for progressive rung upgrades and continue past higher-ranked bundles that do not fit.

**Tech Stack:** TypeScript, Node.js 24 built-in test runner, SDL-MCP fresh stdio server, Markdown documentation.

---

## Chunk 1: Rank-First Tier 1 Admission

### Task 1: Add the regression and make the minimal selector change

**Files:**
- Modify: `tests/unit/context-v2.test.ts:504-617`
- Modify: `src/context/select.ts:197-220, 420-446`

- [ ] **Step 1: Add the failing rank-versus-density regression**

Add this test after `does not admit a non-exact Tier 1 base card without its complete profile ladder`:

```typescript
it("prioritizes candidate rank over Tier 1 bundle density", () => {
  const higherRanked = candidate(
    "a".repeat(64),
    1,
    1,
    CONTEXT_RUNG_TOKEN_LIMITS,
  );
  higherRanked.path = "tests/unit/tool-registration.test.ts";
  higherRanked.lanes = [
    "symbolFts",
    "symbolVec",
    "fileSummaryFts",
    "fileSummaryVec",
  ];

  const lowerRanked = candidate(
    "b".repeat(64),
    35,
    1,
    CONTEXT_RUNG_TOKEN_LIMITS,
  );
  lowerRanked.path = "native/index.d.ts";
  lowerRanked.lanes = ["symbolFts"];

  const profile = getTaskProfile("debug");
  const availableTokens = profile.rungPreference.reduce(
    (total, rung) => total + expectedRungTokens(higherRanked, rung),
    0,
  );
  const result = selectContextBundles({
    candidates: [higherRanked, lowerRanked],
    profile,
    availableTokens,
  });

  assert.deepEqual(
    result.selected.map(({ candidate: item, rungs }) => [
      item.rank,
      rungs,
    ]),
    [[1, ["card", "hotPath"]]],
  );
  assert.deepEqual(
    result.omitted
      .filter((item) => item.symbolId === lowerRanked.symbolId)
      .map((item) => item.rung),
    ["card", "hotPath"],
  );
});
```

- [ ] **Step 2: Strengthen the existing skip-nonfitting contract**

In `admits exact identifiers by base-card cost and skips non-fitting complete ladders`, replace the loose `some` assertion for `expensive` with:

```typescript
assert.deepEqual(
  result.omitted
    .filter((item) => item.symbolId === "expensive")
    .map((item) => item.rung),
  ["card", "skeleton"],
);
```

Rename `uses deterministic value-per-token ordering and symbol IDs as ties` to `uses symbol IDs as deterministic ties for equal-rank bundles`. Keep its assertions unchanged.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
node --experimental-strip-types --test tests/unit/context-v2.test.ts
```

Expected: FAIL only in `prioritizes candidate rank over Tier 1 bundle density`; current output selects rank 35 and omits rank 1.

- [ ] **Step 4: Replace density ordering with rank ordering**

Delete the now-unused `compareBundleValuePerToken` function from `src/context/select.ts`.

Change the non-exact complete-bundle ordering in `selectTierOne`:

```typescript
const completeCandidates = candidates
  .filter(
    (candidate) =>
      !candidate.lanes.includes("exactIdentifier"),
  )
  .sort(compareCandidate);
```

Do not change `compareValuePerToken`; progressive Tier 0 and exact-identifier rung upgrades still use it.

- [ ] **Step 5: Build and verify GREEN**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/context-v2.test.ts
```

Expected: build succeeds and every `context-v2.test.ts` test passes.

- [ ] **Step 6: Commit the selector fix**

```powershell
git add -- src/context/select.ts tests/unit/context-v2.test.ts
git commit -m "fix(context): prioritize rank in evidence admission"
```

### Task 2: Update the public selection contract

**Files:**
- Modify: `docs/feature-deep-dives/agent-context.md:49-57, 136-143`
- Modify: `docs/feature-deep-dives/context-modes.md:47-57`
- Add to documentation commit: `docs/superpowers/plans/2026-07-28-context-evidence-budget-ranking.md`

- [ ] **Step 1: Update the pipeline description**

Replace step 6 in `agent-context.md` with:

```markdown
6. The selector admits complete non-exact Tier-1 bundles by rank, then compares value per estimated token for progressive rung upgrades.
```

Update the key-file description to:

```markdown
- `src/context/select.ts`: deterministic rank-first bundle admission and value-per-token rung selection
```

- [ ] **Step 2: Update the evidence-selection description**

Replace the selection paragraph in `context-modes.md` with:

```markdown
The selector orders Tier 0 before Tier 1 and admits complete non-exact Tier-1 bundles by rank. It compares deterministic value per estimated token only for progressive rung upgrades. Hydration runs only for selected bundles. After hydration, one exact serialized-size pass may evict optional Tier-1 rungs when estimates were low.
```

- [ ] **Step 3: Verify documentation and whitespace**

Run:

```powershell
npm run docs:tools:check
git diff --check
```

Expected: both commands exit 0. CRLF conversion warnings are acceptable; whitespace errors are not.

- [ ] **Step 4: Commit the documentation**

```powershell
git add -- docs/feature-deep-dives/agent-context.md docs/feature-deep-dives/context-modes.md docs/superpowers/plans/2026-07-28-context-evidence-budget-ranking.md
git commit -m "docs(context): clarify evidence admission order"
```

### Task 3: Run focused and fresh-runtime acceptance gates

**Files:**
- No repository changes expected.

- [ ] **Step 1: Run static and relevant unit gates**

Run:

```powershell
npm run typecheck
npm run lint
npm run test:unit
```

Expected: all commands exit 0.

- [ ] **Step 2: Probe a fresh MCP server**

Run this through SDL `runtimeExecute` with `runtime: "node"` so the child imports the newly built `dist` and starts a fresh stdio server:

```javascript
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const client = new Client(
  { name: "context-ranking-verifier", version: "1.0.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/main.js"],
  env: { ...process.env, NODE_ENV: "test" },
});

await client.connect(transport);
try {
  for (const maxTokens of [1_600, 3_200, 12_000]) {
    const response = await client.request(
      {
        method: "tools/call",
        params: {
          name: "sdl.context",
          arguments: {
            repoId: "sdl-mcp",
            taskType: "debug",
            taskText:
              "Find the exact tests that verify sdl.info tool registration and its public contract.",
            budget: { maxTokens },
            chatMentions: ["sdl.info"],
            includeTests: true,
            responseMode: "inline",
            refsMode: "off",
            wireFormat: "json",
          },
        },
      },
      CallToolResultSchema,
    );
    const payload = response.structuredContent;
    assert.ok(payload && typeof payload === "object");
    const result = payload;
    const rankOne = result.evidence?.find(
      (item) =>
        item.path === "tests/unit/tool-registration.test.ts" &&
        item.rank === 1,
    );
    assert.ok(rankOne, `missing rank-1 registration evidence at ${maxTokens}`);
    assert.equal(
      result.omitted?.highestRanked?.some(
        (item) =>
          item.path === "tests/unit/tool-registration.test.ts" &&
          item.rank === 1,
      ),
      false,
      `rank-1 registration evidence was budget-omitted at ${maxTokens}`,
    );
    assert.equal(
      result.evidence?.some(
        (item, index) => item.rank > 1 && index < result.evidence.indexOf(rankOne),
      ),
      false,
      `lower-ranked evidence preceded rank 1 at ${maxTokens}`,
    );
  }
} finally {
  await client.close();
}
```

Expected: the script exits 0 for all three budgets. If rank 1 remains budget-omitted, stop and inspect `enforceContextBudget` eviction evidence; do not weaken the assertions or add a test-path boost.

- [ ] **Step 3: Confirm the final repository state**

Run:

```powershell
git status --short --branch
git log -3 --oneline
```

Expected: the branch is clean and contains the design, selector, and documentation commits.
