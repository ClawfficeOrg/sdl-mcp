# Tight-Budget Context and Action-Search Paging Design

Date: 2026-07-30
Status: Approved for implementation

## Goal

Fix two verified agent-facing defects without changing retrieval scoring, adding task-text heuristics, or synthesizing graph relationships:

1. Preserve higher-ranked exact identifiers when a tight `sdl.context` budget cannot admit every exact candidate.
2. Make a truncated `sdl.action.search` page directly pageable.

The relationship-query symptom is part of the first fix: `taskType: "explain"` must return evidence that shows concrete identifier use rather than a class skeleton that omits method bodies.

## Current behavior and root causes

### Exact context candidates

`selectTierOne` admits exact-identifier base cards separately from complete non-exact bundles. It currently sorts those exact candidates with `compareValuePerToken`. Under a tight budget, a cheaper lower-ranked exact card can consume the only available slot before rank 1.

The existing regression proves that one exact candidate may enter by base-card cost, but it does not cover multiple exact candidates competing for a single slot.

### Relationship explanations

The static `explain` task profile uses `card` plus `skeleton`. A class skeleton omits method bodies, so the selected `MCPServer` skeleton cannot show its concrete use of `SDL_MCP_SERVER_INSTRUCTIONS`. The existing `hotPath` rung already returns the relevant use in `src/server.ts`.

The graph should not invent a class-to-variable edge: the durable reference belongs to a nested method, and lifting it to the containing class would change graph semantics.

### Action-search pages

`handleActionSearch` first applies the requested catalog `limit`, then stops adding full-detail actions when its response token budget is reached. It reports `hasMore`, but does not return the effective page position or the offset required for the next request. This also diverges from the documented response fields.

## Approved design

### 1. Preserve candidate rank for exact base-card admission

Sort `exactIdentifiers` with the existing deterministic `compareCandidate` comparator. Continue using value-per-token only for progressive rung upgrades after base cards have been admitted.

This preserves the established policy:

- exact matches may enter as base cards;
- complete non-exact bundles remain atomic;
- non-fitting candidates are skipped;
- optional upgrades compete by marginal value.

### 2. Use hot-path evidence for explanations

Change the `explain` task profile from `["card", "skeleton"]` to `["card", "hotPath"]`.

This reuses the existing profile and hydration paths. It makes relationship and usage explanations concrete without adding task-text classification or graph transformations. The `implement` profile remains `["card", "skeleton"]` for structural implementation context.

### 3. Return explicit action-search paging metadata

Return these fields from non-summary action-search results:

- `offset`: the requested starting offset;
- `limit`: the requested catalog limit;
- `nextOffset`: `offset + actions.length` when `hasMore` is true, otherwise omitted.

Preserve the current relative order of existing response keys. In the handler, place the three new fields after `tokenEstimate` and before optional `autoEnabled`/`nextAction` fields. In the model projection, place them after `hasMore` and before hints. Add the fields to the MCP output schema in the same order.

Update `docs/mcp-tools-reference.md` to document `nextOffset`, correct the `limit` default from 10 to the implemented 20, add the existing `detail` and `maxTokens` controls, and explain that token-bounded full-detail pages may contain fewer actions than `limit`. Update `tests/integration/determinism.fixtures.json` with a stable `hasMore: true` action-search paging call so the intentional output-contract change remains covered.

## Data flow

For context retrieval:

1. Retrieval produces deterministically ranked candidates.
2. Exact base-card admission walks candidate rank order.
3. Optional rung upgrades use value-per-token.
4. `explain` hydration renders cards and hot paths.
5. Final serialized-budget enforcement remains the safety boundary.

For action search:

1. Rank and filter the catalog.
2. Slice from `offset` up to `limit` candidates.
3. Admit candidates until the response token budget is reached.
4. Compute `hasMore` and `nextOffset` from the number actually returned.
5. Preserve paging metadata through MCP projection.

## Tests

Use the existing test files and test-first workflow:

1. In `tests/unit/context-v2.test.ts`, add a regression with two exact candidates where only one base card fits. Rank 1 must be selected even when rank 2 has better value-per-token.
2. Update the task-profile contract and add focused hydration/engine coverage proving an `explain` request uses hot-path evidence rather than skeleton evidence.
3. In `tests/unit/mcp-action-search.test.ts`, extend the bounded full-search paging test to consume the returned `nextOffset` until `hasMore` is false. On every page assert the echoed `offset` and `limit`; when `hasMore` is true assert `nextOffset === offset + actions.length`; on the terminal page assert `nextOffset` is omitted. Assert no duplicate action names and `seen.size === total`.
4. Add projection and `ACTION_SEARCH_OUTPUT_SCHEMA` assertions proving `offset`, `limit`, and `nextOffset` survive both public boundaries with the specified key placement. Add the `hasMore: true` request to `tests/integration/determinism.fixtures.json`.
5. Update `docs/mcp-tools-reference.md` and run its generated-document/tool-inventory checks.

After focused tests pass, run the repository's affected-test selection, typecheck, documentation checks, and `git diff --check`.

Run these live checks against `repoId: "sdl-mcp"` only after `repo.status` reports `derivedState.graphIntegrityState: "verified"` and `stale: false`:

- Tight-budget rank probe at 900 and 1,200 tokens: `taskType: "explain"`, `taskText: "Find MCPServer and explain where it is implemented."`, `chatMentions: ["MCPServer"]`, `responseMode: "inline"`, `refsMode: "off"`, and `wireFormat: "json"`. Assert the first evidence item is rank-1 `MCPServer` in `src/server.ts`; at 900 tokens its base card must not be displaced by lower-ranked evidence.
- Relationship probe at 2,400 tokens: `taskType: "explain"`, `taskText: "Explain the concrete relationship between SDL_MCP_SERVER_INSTRUCTIONS and MCPServer. Show where MCPServer consumes the instructions."`, `chatMentions: ["SDL_MCP_SERVER_INSTRUCTIONS", "MCPServer"]`, and the same response/ref/wire settings. Assert both named symbols are selected and `MCPServer` has `hotPath` evidence from `src/server.ts` containing `SDL_MCP_SERVER_INSTRUCTIONS`; assert the suggested next action does not target an unrelated HTTP symbol.
- Paging probe: call `sdl.action.search` with `query: "*"`, `detail: "full"`, `includeSchemas: true`, `includeExamples: true`, and `limit: 50`; repeatedly pass the returned `nextOffset` until the terminal page. Assert `nextOffset === offset + actions.length` on nonterminal pages, terminal omission, no gaps or duplicate action names, and `seen.size === total`.

## Non-goals

- No retrieval score changes.
- No prompt-specific identifier boosts.
- No relationship-word keyword detector.
- No synthetic or lifted graph edges.
- No new paging abstraction or dependency.
