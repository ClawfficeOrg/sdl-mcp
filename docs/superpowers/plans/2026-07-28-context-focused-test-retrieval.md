# Context Focused Test Retrieval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task in a dedicated worktree. Use `test-driven-development` for each behavior change and `verification-before-completion` before integration.

**Goal:** Make the exact 2,400-token `sdl.context` request find the `sdl.info` Code Mode contract test, without allowing a broad `tests` directory focus to promote unrelated benchmark symbols into Tier 0.

**Architecture:** Preserve exact-file focus as the existing bounded Tier 0 pin, but classify directory focus as a soft prefix that only stable-partitions the already-fused candidate pool. Add bounded static JS/TS test titles to module `searchText` in the shared row builder, preserve dotted query terms through context hydration, and let hot-path rendering match those terms as exact source substrings inside an already-selected symbol. Reuse the current TypeScript compiler API, candidate fusion, and hot-path machinery; add no dependency, schema field, retrieval lane, query-time repository scan, or Rust implementation.

**Tech Stack:** TypeScript 5.9, Node.js 24 built-in `node:test`, LadybugDB-backed retrieval, existing TypeScript compiler API, existing SDL-MCP runtime and context acceptance harness.

**Approved design:** `docs/superpowers/specs/2026-07-28-context-focused-test-retrieval-design.md`

---

## Execution guardrails

- Start from the current `main` commit in a dedicated worktree and preserve unrelated user changes.
- Use SDL-MCP code retrieval/edit tools for indexed source. Use `sdl.file` for non-indexed documentation.
- Keep the public `sdl.context` request and response schemas unchanged.
- Do not widen candidate lane limits, rerun retrieval for focused directories, add synthetic test symbols, change graph edges, or alter Rust extraction.
- Keep response object key order, deterministic ordering, scores, source ranks, and provenance unchanged except for the intentional final row order.
- A full reindex is required for unchanged JS/TS test files to acquire the new title metadata; incremental indexing is content-hash driven and does not re-enrich unchanged files.
- After each task, inspect `git diff --check` and commit only that task's files.

## Chunk 1: Focus classification and bounded directory preference

### Task 1: Classify exact files separately from directory prefixes

**Files:**

- Modify: `src/context/engine.ts`
- Modify: `tests/unit/context-v2-overlay-expansion.test.ts`
- Modify: `tests/unit/context-v2.test.ts`

- [ ] **Step 1: Write failing classification tests**

In `tests/unit/context-v2-overlay-expansion.test.ts`, import the exported `resolveFocusPaths` classifier from `dist/context/engine.js` and add focused cases:

```ts
const result = await resolveFocusPaths(
  conn,
  repoId,
  ["tests/unit/code-mode-tool-validation.test.ts"],
  overlaySnapshot,
  queries,
);

assert.deepEqual(result, {
  exactFileSymbolHits: [
    {
      path: "tests/unit/code-mode-tool-validation.test.ts",
      symbolId: targetSymbolId,
    },
  ],
  directoryPrefixes: [],
});
```

Add a directory case for `focusPaths: ["tests"]` that asserts:

```ts
assert.deepEqual(result, {
  exactFileSymbolHits: [],
  directoryPrefixes: ["tests"],
});
assert.equal(getSymbolsByFileCalls, 0);
```

Add a missing-path case that returns both arrays empty. Cover all overlay boundaries explicitly:

- an overlay-only exact file remains an authoritative exact file;
- an overlay-only directory becomes a visible `directoryPrefixes` entry without loading its symbols; and
- a durable exact file hidden by an overlay tombstone is treated as missing.

Apply touched-file tombstones before durable exact-file or prefix classification so deleted paths cannot leak back in from the database snapshot.

In `tests/unit/context-v2.test.ts`, retain the round-robin allocation regression but rename its description and fixture wording to state that it allocates **exact-file** hits only. Do not change its expected cap, path ordering, or symbol-ID ordering.

Task 1 only introduces and tests the exported classifier. Leave `defaultRetrieve` on the existing resolver until Task 2 adds the candidate-search option and switches the engine atomically, so this commit builds independently.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts
```

Expected: the build or tests FAIL because the exported `resolveFocusPaths` classifier and `directoryPrefixes` result do not exist. Running `npm run build` first is mandatory because these tests import `dist/`.

- [ ] **Step 3: Implement the smallest path classifier**

In `src/context/engine.ts`, add one result type and one exported classifier alongside the current resolver. Import the existing Ladybug `Connection` type used by the query boundary:

```ts
interface FocusPathResolution {
  exactFileSymbolHits: FocusPathSymbolHit[];
  directoryPrefixes: string[];
}

export async function resolveFocusPaths(
  conn: Connection,
  repoId: string,
  focusPaths: readonly string[],
  overlaySnapshot: OverlaySnapshot,
  queries: FocusPathReadQueries = DEFAULT_FOCUS_PATH_READ_QUERIES,
): Promise<FocusPathResolution> {
  // Exact indexed or overlay file first; otherwise retain a visible prefix.
}
```

Pass `conn` to every `FocusPathReadQueries` method; the test-only query object remains injectable through the final parameter.

For each normalized focus path:

1. Check exact overlay and durable file identity first.
2. If an exact file exists, collect symbols for that file only into `exactFileSymbolHits`.
3. Otherwise, use the existing prefix visibility query only to decide whether the normalized prefix exists; do not load every symbol below it.
4. Add visible prefixes to `directoryPrefixes`.
5. Ignore missing paths.

Return unique deterministic arrays. Preserve the existing exact-file hit normalization, exact-file symbol ordering, and `allocateFocusPathSymbols` cap logic. Keep `resolveFocusPathSymbolHits` and `defaultRetrieve` unchanged in this task; Task 2 will replace that production call only after `focusPathPrefixes` exists.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run the command from Step 2.

Expected: all selected tests pass; directory focus causes zero `getSymbolsByFile` expansion calls, while exact overlay/durable files remain bounded Tier 0 inputs.

- [ ] **Step 5: Inspect and commit**

Run:

```powershell
git diff --check
git status --short
git diff -- src/context/engine.ts tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts
```

Commit:

```powershell
git add src/context/engine.ts tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts
git commit -m "fix(context): separate file and directory focus"
```

### Task 2: Stable-partition the existing fused candidate pool

**Files:**

- Modify: `src/context/engine.ts`
- Modify: `src/retrieval/context-candidate-search.ts`
- Modify: `tests/unit/context-candidate-overlay-snapshot.test.ts`
- Modify: `tests/unit/context-v2-db-boundary.test.ts`

- [ ] **Step 1: Write failing stable-partition tests**

In `src/retrieval/context-candidate-search.ts`, export the pure helper for focused regression coverage. After `npm run build`, import it in `tests/unit/context-candidate-overlay-snapshot.test.ts` from `../../dist/retrieval/context-candidate-search.js` and construct six rows in deliberately mixed order:

```ts
const rows = [outsideOne, pinnedOne, insideOne, pinnedTwo, insideTwo, outsideTwo];
const reordered = prioritizeContextCandidateRowsByFocus(rows, ["tests"]);

assert.deepEqual(
  reordered.map((row) => row.symbolId),
  [
    pinnedOne.symbolId,
    pinnedTwo.symbolId,
    insideOne.symbolId,
    insideTwo.symbolId,
    outsideOne.symbolId,
    outsideTwo.symbolId,
  ],
);
```

Make `pinnedOne.tier === 0` and `pinnedTwo.tier === 0`; all other rows remain unpinned. Their expected order proves pin-order stability independently of their original separation. Assert that:

- the output length equals the input length;
- each row's `score`, `sourceRanks`, and `provenance` are unchanged;
- multiple prefixes act as a union;
- prefix `tests` matches `tests` and `tests/...`, but not `tests-other/...`;
- empty or missing prefixes preserve the original order byte-for-byte.

Also exercise `searchContextCandidates` with source-rank fixtures whose expected `evidence.topRanksPerSource` positions change after partitioning. Assert those evidence ranks describe the partitioned row order, not the original fused order.

In `tests/unit/context-v2-db-boundary.test.ts`, assert that the engine passes `focusPathPrefixes` to the shared candidate search owner and still assigns one-based candidate ranks from the returned row order. Retain the existing assertion that the engine does not locally duplicate fusion or re-sort scores.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts
```

Expected: FAIL because the helper and `focusPathPrefixes` option do not exist.

- [ ] **Step 3: Implement the stable partition after path resolution**

In `src/context/engine.ts`, atomically switch `defaultRetrieve` from `resolveFocusPathSymbolHits` to:

```ts
const focusPathResolution = await resolveFocusPaths(
  conn,
  request.repoId,
  request.focusPaths ?? [],
  overlaySnapshot,
);
const pathAllocation = allocateFocusPathSymbols(
  focusPathResolution.exactFileSymbolHits,
  CANDIDATE_LIMIT,
);
```

Pass `focusPathResolution.directoryPrefixes` as `focusPathPrefixes` to `searchContextCandidates`. Only exact-file hits enter `tierZeroIds` and `exactIdentifierSymbolIds`. Remove `resolveFocusPathSymbolHits` once no callers remain; keep the existing read-query helpers reused by `resolveFocusPaths`.

In `src/retrieval/context-candidate-search.ts`, extend `ContextCandidateSearchOptions`:

```ts
focusPathPrefixes?: readonly string[];
```

Add the smallest pure stable-partition helper:

```ts
export function prioritizeContextCandidateRowsByFocus(
  rows: readonly ContextCandidateSearchRow[],
  focusPathPrefixes: readonly string[],
): ContextCandidateSearchRow[] {
  // existing Tier 0 pins, then in-prefix unpinned rows, then remaining rows
}
```

Normalize prefixes once with the project's path helper. A row is in scope when its normalized repository-relative path equals a prefix or starts with `${prefix}/`.

Call the helper only after the current flow has completed lane collection, RRF, PPR, overlay filtering, and repository-relative path resolution. Feed it the rows already bounded by the existing `collection.limit`. Store the result once as `orderedRows`, return `rows: orderedRows`, and pass that same array into `buildContextCandidateEvidence`; row order, evidence order, and engine-assigned ranks must agree. Do not change:

- `collectEntitySourceRankings({ limit: options.limit })`;
- the limit passed to `rrfFuseContextCandidates`;
- PPR inputs or scores;
- row contents; or
- source/provenance evidence.

Return the same row objects in the partitioned order. `ContextEngine` continues assigning final one-based ranks from this returned order.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run the command from Step 2, then run the combined Chunk 1 set:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts tests/unit/context-v2-db-boundary.test.ts tests/unit/context-candidate-overlay-snapshot.test.ts
```

Expected: all selected tests pass. The pool size and score metadata remain unchanged, exact pins lead, and directory-scoped unpinned rows retain their previous fused order.

- [ ] **Step 5: Inspect and commit**

Run:

```powershell
git diff --check
git status --short
git diff -- src/context/engine.ts src/retrieval/context-candidate-search.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts
```

Commit:

```powershell
git add src/context/engine.ts src/retrieval/context-candidate-search.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts
git commit -m "fix(context): bound directory focus preference"
```


## Chunk 2: Test-title metadata, dotted evidence, and live acceptance

### Task 3: Add bounded static test titles to shared module search metadata

**Files:**

- Create: `src/indexer/test-title-search-text.ts`
- Create: `tests/unit/test-title-search-text.test.ts`
- Modify: `src/indexer/parser/build-rows.ts`
- Modify: `tests/unit/build-rows.test.ts`
- Modify: `tests/unit/code-mode-tool-validation.test.ts`

- [ ] **Step 1: Write the pure collector regression**

Create `tests/unit/test-title-search-text.test.ts`, importing the built collector from `../../dist/indexer/test-title-search-text.js`. Cover this exact contract:

```ts
describe("registration   contract", () => {});
it.only(`keeps sdl.info callable`, () => {});
test.skip("rejects sdl.info as sdl.workflow action", () => {});
test.todo("future static title");
```

Assert that output preserves source order and joins normalized titles with `\n`. Add cases that:

- accept only `describe`, `it`, and `test`, plus direct `.only`, `.skip`, and `.todo`;
- accept string literals and no-substitution templates;
- ignore interpolated templates, dynamic expressions, aliases, nested property chains, empty titles, and non-test calls;
- collapse JavaScript whitespace to one ASCII space and trim;
- deduplicate exact case-sensitive titles after per-title truncation;
- truncate each title to 256 Unicode code points;
- retain at most 64 titles and at most 2,048 title code points, truncating the final title to the remaining allowance and then stopping; and
- return byte-identical output on repeated calls.

Use generated strings, including astral Unicode characters, and assert bounds with `Array.from(value).length`, not UTF-16 `.length`.

- [ ] **Step 2: Build and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-title-search-text.test.ts
```

Expected: the build or test fails because `extractStaticTestTitleSearchText` does not exist.

- [ ] **Step 3: Implement the standalone collector**

Create `src/indexer/test-title-search-text.ts` using the already-installed TypeScript compiler API:

```ts
import ts from "typescript";

export function extractStaticTestTitleSearchText(
  content: string,
  filePath: string,
): string {
  // Parse once, visit calls in source order, and enforce fixed bounds.
}
```

Use `ts.createSourceFile` and cover every extension routed through the repository's TypeScript adapter: `.ts` -> `TS`, `.tsx` -> `TSX`, `.jsx` -> `JSX`, and `.js`, `.mjs`, `.cjs` -> `JS`. Add an extension-matrix test proving identical title extraction for all six extensions. A callee is accepted only when it is:

- the identifier `describe`, `it`, or `test`; or
- a direct property access where the base is one of those identifiers and the property is `only`, `skip`, or `todo`.

Accept the first argument only when `ts.isStringLiteral` or `ts.isNoSubstitutionTemplateLiteral`. Normalize with JavaScript whitespace semantics, truncate with `Array.from`, deduplicate after per-title truncation, and enforce the fixed 64-title/2,048-code-point totals without configuration.

Do not add a dependency, parser abstraction, synthetic symbol, or Rust equivalent.

- [ ] **Step 4: Build and verify the pure collector GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-title-search-text.test.ts
```

Expected: all collector cases pass.

- [ ] **Step 5: Add failing shared-row and exact contract regressions**

In `tests/unit/build-rows.test.ts`, build the smallest complete `BuildRowsParams` fixture for `tests/unit/sample.test.ts` with `languageId: "typescript"`, one module detail, one function detail, empty imports/calls, and `skipCallResolution: true`.

Call `buildSymbolAndEdgeRows` twice:

1. the ordinary TypeScript fallback fixture; and
2. a native-shaped fixture whose module `nativeSearchText` equals the fallback module's base enrichment text before the title suffix.

Assert that:

- both module rows end with the exact same bounded title block;
- the complete module `searchText` is byte-identical for the controlled native/fallback fixture;
- non-module `searchText`, symbol IDs, and produced edges are unchanged; and
- files without a module symbol do not receive title metadata.

In `tests/unit/code-mode-tool-validation.test.ts`, strengthen the existing unknown-workflow-function test rather than adding a parallel harness. Rename its test title to explicitly mention the contract, for example:

```ts
it("rejects info and sdl.info as sdl.workflow actions", async () => {
  for (const fn of ["notARealFunction", "info", "sdl.info"]) {
    // invoke the existing workflow handler fixture
    // assert VALIDATION_ERROR, Invalid sdl.workflow request,
    // and details containing `unknown function '${fn}'`
  }
});
```

Keep the existing `keeps sdl.info callable and discoverable in exclusive Code Mode` registration test unchanged. The same file must now explicitly prove top-level registration and workflow rejection.

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/build-rows.test.ts tests/unit/code-mode-tool-validation.test.ts
```

Expected: the explicit workflow rejection assertions already pass, while the new module-title assertions fail because shared row construction does not append the collector output.

- [ ] **Step 6: Wire the collector once in `buildSymbolAndEdgeRows`**

In `src/indexer/parser/build-rows.ts`:

1. Compute `const testFile = isTestFile(relPath, languages)` once and reuse it for existing symbol-reference behavior.
2. Before the symbol loop, call `extractStaticTestTitleSearchText(content, relPath)` only when `testFile && languageId === "typescript"`.
3. Catch collector failures locally, log a warning with repository-relative `relPath`, and fall back to an empty suffix; indexing must continue.
4. After `resolveSymbolEnrichment`, append `\n${testTitleSearchText}` only when `extractedSymbol.kind === "module"` and the suffix is non-empty.
5. Assign the appended value to the existing `SymbolRow.searchText`; do not mutate the native/fallback inputs or call the collector per symbol.

Leave `processFile`, `processFileFromRustResult`, Rust code, symbol IDs, and edge construction unchanged. Both parser paths already converge in this builder.

- [ ] **Step 7: Build and verify GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-title-search-text.test.ts tests/unit/build-rows.test.ts tests/unit/code-mode-tool-validation.test.ts
```

Expected: all selected tests pass and the controlled native/fallback module metadata is byte-identical.

- [ ] **Step 8: Inspect and commit**

Run:

```powershell
git diff --check
git status --short
git diff -- src/indexer/test-title-search-text.ts src/indexer/parser/build-rows.ts tests/unit/test-title-search-text.test.ts tests/unit/build-rows.test.ts tests/unit/code-mode-tool-validation.test.ts
```

Commit:

```powershell
git add src/indexer/test-title-search-text.ts src/indexer/parser/build-rows.ts tests/unit/test-title-search-text.test.ts tests/unit/build-rows.test.ts tests/unit/code-mode-tool-validation.test.ts
git commit -m "fix(index): expose static test contracts to retrieval"
```

### Task 4: Preserve dotted query terms and center selected hot paths on literals

**Files:**

- Modify: `src/retrieval/identifier-extraction.ts`
- Modify: `src/context/engine.ts`
- Modify: `src/code/hotpath.ts`
- Modify: `tests/unit/retrieval/identifier-extraction.test.ts`
- Modify: `tests/unit/context-v2.test.ts`
- Modify: `tests/unit/context-code-snapshot.test.ts`

- [ ] **Step 1: Write failing qualified-term and hot-path tests**

In `tests/unit/retrieval/identifier-extraction.test.ts`, import the new helper exactly from `../../../dist/retrieval/identifier-extraction.js` and assert:

```ts
extractQualifiedTermsFromContext(
  "Find sdl.info, then sdl.workflow and sdl.info again",
  ["sdl.context before Sdl.Info", "sdl.workflow"],
);
// ["sdl.info", "sdl.workflow", "sdl.context", "Sdl.Info"]
```

Cover the ASCII grammar `[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+`, task-text-first then caller-ordered chat mentions, left-to-right order, case-sensitive deduplication, 128-code-point truncation, and the 16-term cap. Plain identifiers and unmatched trailing dots must not become dotted terms.

Add a boundary fixture where truncation lands exactly on a `.` at code point 128. Remove only a cutoff-created terminal dot, then retain the bounded prefix only if it still matches the complete qualified grammar; otherwise discard it. Assert the retained value is an exact source substring usable by `line.includes`, and assert ordinary invalid trailing-dot input is not broadened by this cleanup.

In `tests/unit/context-v2.test.ts`, exercise one exported internal `identifiersForContextRequest` helper. Assert dotted terms appear first in the deterministic order above, followed by the existing chat-mention and `autoExtractMentions` output with the existing unique-string behavior. This helper must be used by both context build and hydration paths.

In `tests/unit/context-code-snapshot.test.ts`, reuse the prepared overlay snapshot fixture with a module-range symbol whose source contains `sdl.info` and `sdl.workflow` literals well below line 1. Render with:

```ts
{
  identifiersToFind: ["sdl.info", "sdl.workflow"],
  contextLines: 0,
  maxLines: 4,
  maxTokens: 200,
}
```

Assert the excerpt contains both literal lines, reports both matched identifiers and exact line numbers, and does not fall back to the module start. Add a second fixture with those dotted literals only outside a narrow selected-symbol range; assert their lines and identifiers are excluded and the existing fallback remains inside the selected symbol. Keep the existing ordinary AST-identifier snapshot test unchanged.

- [ ] **Step 2: Build and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/retrieval/identifier-extraction.test.ts tests/unit/context-v2.test.ts tests/unit/context-code-snapshot.test.ts
```

Expected: the build or tests fail because qualified-term extraction/context normalization do not exist and current hot paths do not match dotted string literals.

- [ ] **Step 3: Add the bounded qualified-term extractor**

In `src/retrieval/identifier-extraction.ts`, add one pure exported helper:

```ts
export function extractQualifiedTermsFromContext(
  taskText: string,
  chatMentions: readonly string[],
): string[] {
  // taskText first, then each chat mention; max 16 bounded terms
}
```

Use one global grammar regex per scanned string. For each complete match, truncate to 128 Unicode code points. If truncation alone creates a terminal `.`, remove that dot and retain the prefix only when it still matches the full qualified grammar; otherwise discard it. Then case-sensitively deduplicate the retained value. Stop after 16 terms. Do not change `extractIdentifiersFromText` or `autoExtractMentions`; their existing retrieval callers retain current behavior.

In `src/context/engine.ts`, add one exported internal helper:

```ts
export function identifiersForContextRequest(
  request: ContextV2Request,
): string[] {
  return uniqueStrings([
    ...extractQualifiedTermsFromContext(
      request.taskText,
      request.chatMentions ?? [],
    ),
    ...(request.chatMentions ?? []),
    ...autoExtractMentions(request.taskText),
  ]);
}
```

Replace both duplicated identifier-array constructions in `buildContext` and `defaultHydrate` with this helper. Do not alter seed resolution or candidate lane queries.

- [ ] **Step 4: Build and verify qualified-term normalization GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/retrieval/identifier-extraction.test.ts tests/unit/context-v2.test.ts
```

Expected: extraction and both context identifier paths pass their deterministic bounds/order tests.

- [ ] **Step 5: Extend hot-path matching after symbol selection**

In `src/code/hotpath.ts`, add the smallest focused helper for dotted terms:

```ts
export function findQualifiedTermLines(
  lines: readonly string[],
  identifiersToFind: readonly string[],
): {
  lineNumbers: number[];
  matchedIdentifiers: string[];
} {
  // Exact case-sensitive line.includes(term), qualified terms only.
}
```

Consider only terms that match the qualified grammar and respect the already-bounded caller input. In `renderPreparedHotPath`, merge these line numbers and matched identifiers with the existing AST identifier result before the existing selected-symbol range filter and excerpt construction. Deduplicate deterministically.

This literal matching is not a retrieval lane: it runs only against the prepared source for an already-selected symbol. Preserve ordinary AST identifier matching, selected-range enforcement, token/line limits, gap markers, and the existing symbol-start fallback when neither matcher finds anything.

- [ ] **Step 6: Build and verify the complete dotted-evidence path GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/retrieval/identifier-extraction.test.ts tests/unit/context-v2.test.ts tests/unit/context-code-snapshot.test.ts tests/unit/hotpath-gap-markers.test.ts
```

Expected: dotted literal lines center the selected module excerpt, and ordinary AST/fallback behavior remains green.

- [ ] **Step 7: Inspect and commit**

Run:

```powershell
git diff --check
git status --short
git diff -- src/retrieval/identifier-extraction.ts src/context/engine.ts src/code/hotpath.ts tests/unit/retrieval/identifier-extraction.test.ts tests/unit/context-v2.test.ts tests/unit/context-code-snapshot.test.ts
```

Commit:

```powershell
git add src/retrieval/identifier-extraction.ts src/context/engine.ts src/code/hotpath.ts tests/unit/retrieval/identifier-extraction.test.ts tests/unit/context-v2.test.ts tests/unit/context-code-snapshot.test.ts
git commit -m "fix(context): preserve dotted contract evidence"
```

### Task 5: Document exact-file focus, bounded directory scope, and reindexing

**Files:**

- Modify: `docs/feature-deep-dives/agent-context.md`
- Modify: `docs/feature-deep-dives/context-modes.md`

- [ ] **Step 1: Update the public focus contract**

In both documents, replace language that treats every `focusPaths` entry as authoritative Tier 0 with the exact behavior:

- an exact indexed/overlay file may enter the existing bounded Tier 0 allocation;
- a directory is soft scope that stable-partitions only the existing fused candidate pool;
- directory scope does not widen lanes, oversample, rerun retrieval, or change scores; and
- missing/tombstoned paths have no effect.

- [ ] **Step 2: Document static test-title retrieval and rollout**

State that bounded static `describe`, `it`, and `test` titles from JS/TS test files participate in module lexical search metadata, while dotted literals only center hot paths after a module is selected.

Add the operational note that unchanged already-indexed test files require a full reindex to receive this new metadata. Do not describe this as a schema migration or add configuration; neither exists.

- [ ] **Step 3: Verify and commit documentation**

Run:

```powershell
npm run docs:tools:check
git diff --check
git diff -- docs/feature-deep-dives/agent-context.md docs/feature-deep-dives/context-modes.md
```

Commit:

```powershell
git add docs/feature-deep-dives/agent-context.md docs/feature-deep-dives/context-modes.md
git commit -m "docs(context): clarify focused test retrieval"
```

### Task 6: Run focused, determinism, and disposable full-index acceptance gates

**Files:**

- No repository changes expected.

- [ ] **Step 1: Run static and focused regression gates**

Run:

```powershell
npm run build:all
npm run typecheck
npm run lint
node --experimental-strip-types --test --test-concurrency=1 tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts tests/unit/context-v2-db-boundary.test.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/test-title-search-text.test.ts tests/unit/build-rows.test.ts tests/unit/code-mode-tool-validation.test.ts tests/unit/retrieval/identifier-extraction.test.ts tests/unit/context-code-snapshot.test.ts tests/unit/hotpath-gap-markers.test.ts
npm run test:unit
npm run docs:tools:check
```

Expected: every command exits 0.

- [ ] **Step 2: Run prompt-cache determinism coverage**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts
```

Expected: the deterministic tool catalog and repeated unchanged-index response checks pass. Update `tests/integration/determinism.fixtures.json` only if the test proves an intentional fixture mismatch; this change does not alter a public schema or tool list.

- [ ] **Step 3: Build a disposable full index**

Set `SDL_CONTEXT_ACCEPTANCE_CONFIG` to a code-mode-enabled config that registers the current checkout under `SDL_CONTEXT_ACCEPTANCE_REPO_ID` (default `sdl-mcp`) and points at a disposable graph database not owned by any other process. Do not reuse the developer's active graph.

Run a forced full index so unchanged tests receive the new metadata:

```powershell
$acceptanceRepoId = if ($env:SDL_CONTEXT_ACCEPTANCE_REPO_ID) { $env:SDL_CONTEXT_ACCEPTANCE_REPO_ID } else { "sdl-mcp" }
node dist/cli/index.js --config $env:SDL_CONTEXT_ACCEPTANCE_CONFIG index --repo-id $acceptanceRepoId --force
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Expected: indexing exits 0. The fresh-server probe in Step 4 must independently assert `graphIntegrityState === "verified"`, `derivedState.stale === false`, and each dirty flag is false before judging retrieval.

- [ ] **Step 4: Run the exact request twice against a fresh server**

Use SDL `runtimeExecute` with `runtime: "node"`, the repository root as `relativeCwd`, and `timeoutMs: 120000`. Pass this complete code as the runtime body (adapted from `docs/superpowers/plans/2026-07-28-context-evidence-budget-ranking.md`):

```js
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { estimateTokens } from "./dist/util/tokenize.js";

const acceptanceConfig = process.env.SDL_CONTEXT_ACCEPTANCE_CONFIG;
assert.ok(
  acceptanceConfig,
  "set SDL_CONTEXT_ACCEPTANCE_CONFIG to an isolated code-mode config",
);
const acceptanceRepoId =
  process.env.SDL_CONTEXT_ACCEPTANCE_REPO_ID ?? "sdl-mcp";

const client = new Client(
  { name: "focused-test-retrieval-verifier", version: "1.0.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/main.js"],
  env: {
    ...process.env,
    NODE_ENV: "test",
    SDL_CONFIG: acceptanceConfig,
  },
});

async function callTool(name, args) {
  const response = await client.request(
    {
      method: "tools/call",
      params: { name, arguments: args },
    },
    CallToolResultSchema,
  );
  assert.ok(
    response.structuredContent &&
      typeof response.structuredContent === "object",
    `${name} must return structuredContent`,
  );
  return response.structuredContent;
}

const exactRequest = {
  repoId: acceptanceRepoId,
  taskType: "review",
  taskText:
    "Find the tests that assert sdl.info is exposed as a top-level Code Mode tool and rejected as an sdl.workflow action.",
  focusPaths: ["tests"],
  includeTests: true,
  budget: { maxTokens: 2400 },
  responseMode: "inline",
  refsMode: "off",
  wireFormat: "json",
};

await client.connect(transport);
try {
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map(({ name }) => name));
  assert.ok(toolNames.has("sdl.context"));
  assert.ok(toolNames.has("sdl.workflow"));

  const statusEnvelope = await callTool("sdl.workflow", {
    repoId: acceptanceRepoId,
    steps: [{ fn: "repoStatus", args: { detail: "standard" } }],
  });
  const status = statusEnvelope.results?.[0]?.result;
  assert.ok(status, "repoStatus result missing");
  assert.equal(status.derivedState?.graphIntegrityState, "verified");
  assert.equal(status.derivedState?.stale, false);
  for (const key of [
    "clustersDirty",
    "processesDirty",
    "algorithmsDirty",
    "summariesDirty",
    "embeddingsDirty",
  ]) {
    assert.equal(status.derivedState?.[key], false, `${key} must be false`);
  }

  const firstPayload = await callTool("sdl.context", exactRequest);
  const secondPayload = await callTool("sdl.context", exactRequest);

  assert.equal(
    JSON.stringify(firstPayload),
    JSON.stringify(secondPayload),
    "unchanged verified graph must return byte-identical JSON",
  );
  assert.ok(
    firstPayload.evidence.some(
      (item) =>
        item.path === "tests/unit/code-mode-tool-validation.test.ts",
    ),
    "target contract test missing",
  );

  const targetEvidence = firstPayload.evidence.filter(
    (item) =>
      item.path === "tests/unit/code-mode-tool-validation.test.ts",
  );
  const targetText = targetEvidence
    .map((item) =>
      typeof item.content?.excerpt === "string"
        ? item.content.excerpt
        : JSON.stringify(item.content),
    )
    .join("\n");

  // Test titles alone are insufficient: require the actual assertions.
  assert.match(targetText, /handlers\.has\("sdl\.info"\)/);
  assert.match(targetText, /VALIDATION_ERROR/);
  assert.match(targetText, /Invalid sdl\.workflow request/);
  assert.match(targetText, /unknown function/);
  assert.match(targetText, /["']info["']/);
  assert.match(targetText, /["']sdl\.info["']/);

  assert.equal(
    firstPayload.evidence.some(
      (item) =>
        item.path?.startsWith("tests/benchmark/") &&
        /"name":"(?:createArtifact|weight)"/.test(
          JSON.stringify(item.content),
        ),
    ),
    false,
    "unrelated benchmark symbols must be absent",
  );
  assert.equal(
    firstPayload.omitted.highestRanked.some(
      (item) =>
        item.path === "tests/unit/code-mode-tool-validation.test.ts",
    ),
    false,
    "target contract test must not be budget-omitted",
  );
  assert.ok(
    estimateTokens(JSON.stringify(firstPayload)) <= 2400,
    "serialized structured payload exceeds 2,400 tokens",
  );
} finally {
  await client.close();
}
```

Expected: the runtime exits 0. If the target module never enters the fused pool, stop and inspect its persisted module `searchText`; do not widen lane limits or add a test-path boost. If it enters but is omitted, inspect final budget evidence; do not weaken the 2,400-token assertion.

- [ ] **Step 5: Confirm the final branch state**

Run:

```powershell
git status --short --branch
git log --oneline -6
```

Expected: the implementation branch is clean and contains the focused commits from Tasks 1-5. Use `verification-before-completion`, request a final code review, then locally fast-forward `main` only after that review is clean.
