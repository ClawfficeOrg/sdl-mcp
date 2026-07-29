# Semantic Test Case Model Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make actual test cases first-class, language-neutral symbol facets so the exact 2,400-token `sdl.context` request retrieves both `sdl.info` contract tests and their assertions while excluding unrelated benchmark symbols.

**Architecture:** Add an optional `testCase` facet to ordinary symbols and synthesize ordinary `function` symbols only for statically titled anonymous cases. Language adapters emit candidates; one shared normalizer attaches or synthesizes them immediately before row construction. Persist deterministic `testCaseJson`, add its terms to the existing symbol FTS text, and reuse current candidate fusion, cards, hot paths, call edges, overlays, and policy gates. Add no `test` symbol kind, test-only graph, retrieval lane, source chunks, embeddings, query-time scan, or new dependency.

**Tech Stack:** TypeScript 5.9, Node.js 24 built-in `node:test`, tree-sitter adapters, existing TypeScript compiler API, LadybugDB schema migrations, existing provider-first/legacy/live indexing pipelines, and SDL-MCP context-quality/determinism harnesses.

**Approved design:** `docs/superpowers/specs/2026-07-28-semantic-test-case-model-design.md`

---

## Execution guardrails

- Work only in `F:\Claude\projects\sdl-mcp\sdl-mcp\.worktrees\context-focused-test-retrieval` on `codex/context-focused-test-retrieval`.
- Preserve the pre-existing line-ending-only change in `native/src/scip/scip.rs`; never stage or modify it.
- Keep the earlier focused-directory and dotted-evidence fixes. This plan supersedes only the module-level static-title workaround in `src/indexer/test-title-search-text.ts`.
- Use SDL-MCP retrieval/edit tools for indexed source and `sdl.file` for documentation. Run repository commands through SDL `runtimeExecute`.
- Use TDD for each task. Run `npm run build` before tests that import `dist/`.
- Do not change `SymbolKind`, add a dependency, add a retrieval lane, add an embedding input, or add query-time source reads.
- Preserve deterministic key order, explicit database ordering, repository-relative diagnostics, and response key order.
- After every task, run `git diff --check`, inspect the exact diff, and stage only the listed files.

## Chunk 1: Domain, storage, integrity, and public cards

### Task 1: Add the canonical facet and schema migration

**Files:**

- Modify: `src/domain/types.ts`
- Create: `src/util/test-case.ts`
- Modify: `src/indexer/treesitter/extractCalls.ts`
- Modify: `src/indexer/parser/types.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/ladybug-symbols.ts`
- Modify: `src/db/ladybug-schema.ts`
- Create: `src/db/migrations/m024-add-symbol-test-case.ts`
- Modify: `src/db/migrations/index.ts`
- Create: `tests/unit/test-case-facet.test.ts`
- Modify: `tests/unit/ladybug-schema.test.ts`
- Modify: `tests/unit/migration-fresh-db.test.ts`
- Modify: `tests/unit/migration-graph-integrity.test.ts`
- Modify: `tests/unit/migration-symbol-embedding-remediation.test.ts`

- [ ] **Step 1: Write RED facet normalization and serialization tests**

In `tests/unit/test-case-facet.test.ts`, import from `../../dist/util/test-case.js` and assert:

```ts
const facet = normalizeTestCaseFacet({
  framework: "Node:Test",
  title: "  keeps   sdl.info callable  ",
  suitePath: Array.from({ length: 18 }, (_, index) => ` suite ${index} `),
  category: "test",
  modifiers: ["only", "skip", "only", "parameterized"],
});

assert.ok(facet);
assert.deepEqual(facet, {
  framework: "node:test",
  title: "keeps sdl.info callable",
  suitePath: Array.from({ length: 16 }, (_, index) => `suite ${index + 2}`),
  modifiers: ["skip", "only", "parameterized"],
});
assert.equal(
  serializeTestCaseFacet(facet),
  '{"framework":"node:test","title":"keeps sdl.info callable","suitePath":["suite 2","suite 3","suite 4","suite 5","suite 6","suite 7","suite 8","suite 9","suite 10","suite 11","suite 12","suite 13","suite 14","suite 15","suite 16","suite 17"],"modifiers":["skip","only","parameterized"]}',
);
assert.deepEqual(parseTestCaseFacetJson(serializeTestCaseFacet(facet)), facet);
assert.equal(normalizeTestCaseFacet({ framework: "jest", title: "   " }), undefined);
```

Add bounds for 256 Unicode code points, repeated whitespace, empty suite segments, default category omission, malformed JSON returning `undefined`, unknown category/modifier rejection, `serializeTestCaseFacet({ framework: "jest", title: " " }) === undefined`, and fixed modifier order `skip`, `todo`, `only`, `parameterized`.

- [ ] **Step 2: Run the facet test and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-facet.test.ts
```

Expected: build/test fails because `TestCaseFacet` and `src/util/test-case.ts` do not exist.

- [ ] **Step 3: Add the public type and one canonical helper**

In `src/domain/types.ts`, add without changing `SymbolKind`:

```ts
export interface TestCaseFacet {
  framework: string;
  title: string;
  suitePath?: string[];
  category?: "test" | "benchmark" | "example" | "fuzz";
  modifiers?: Array<"skip" | "todo" | "only" | "parameterized">;
}
```

Add `testCase?: TestCaseFacet` to `SymbolCard`. Add the same optional property to `ExtractedSymbol` and `SymbolDetail`.

In `src/util/test-case.ts`, export only:

```ts
export const TEST_CASE_MODIFIER_ORDER = [
  "skip",
  "todo",
  "only",
  "parameterized",
] as const;

export function normalizeTestCaseFacet(
  input: TestCaseFacet,
): TestCaseFacet | undefined;
export function serializeTestCaseFacet(
  facet: TestCaseFacet,
): string | undefined;
export function parseTestCaseFacetJson(
  value: string | null | undefined,
): TestCaseFacet | undefined;
```

Implementation rules:

1. Collapse whitespace with `/\s+/gu`, trim, lowercase `framework`, and reject an empty framework or title.
2. Bound title and suite segments by Unicode code points with `[...value].slice(0, 256).join("")`.
3. Drop empty suite segments and retain only the innermost 16.
4. Omit `category` when it is `test` or absent.
5. Deduplicate modifiers and emit them in `TEST_CASE_MODIFIER_ORDER`.
6. Construct the returned object in `framework`, `title`, `suitePath`, `category`, `modifiers` order; `serializeTestCaseFacet` returns `undefined` when normalization fails, otherwise `JSON.stringify(normalized)`. Persistence callers translate `undefined` to database `null`.
7. `parseTestCaseFacetJson` catches malformed JSON, checks only the documented primitive/array shapes, and passes the result through `normalizeTestCaseFacet`.

Keep this as one utility; do not create a registry, class, or Zod schema for internal persistence.

- [ ] **Step 4: Write RED schema and migration assertions**

Update the migration tests to expect schema version `24` instead of `23`. In `tests/unit/ladybug-schema.test.ts`, assert both fresh `Symbol` and `SymbolVersion` tables have nullable `testCaseJson STRING` immediately after `roleTagsJson` in their DDL contracts.

In `tests/unit/migration-graph-integrity.test.ts`, extend the existing v23 fixture through migration 24 and assert:

```ts
assert.equal(await getSchemaVersion(conn), 24);
assert.deepEqual(await readSymbolTestCaseRows(conn), [
  { symbolId: "legacy-symbol", testCaseJson: null },
]);
assert.deepEqual(await readIntegrityState(conn), {
  graphIntegrityState: "unknown",
  graphIntegrityVersionId: null,
  graphIntegrityDigest: null,
  graphIntegrityError: null,
  graphIntegrityRevision: null,
  graphIntegrityVerifiedRevision: null,
  graphIntegrityFilelessPruningSupported: null,
  graphIntegrityManifestEstablished: false,
});
```

Also seed one legacy `SymbolVersion` row and assert its new `testCaseJson` property is null after migration. Use the test file's existing connection/setup/query helpers. The point is to prove an old populated graph becomes unreadable until the documented stopped safe rebuild; do not delete old nodes in the migration.

- [ ] **Step 5: Run migration/schema tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-facet.test.ts tests/unit/ladybug-schema.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts
```

Expected: failures show version 23 and missing `testCaseJson`.

- [ ] **Step 6: Add `testCaseJson` and migration 24**

Add `test_case_json?: string | null` to `src/db/schema.ts`'s `SymbolRow` and `testCaseJson?: string | null` to `src/db/ladybug-symbols.ts`'s row contract. Add `testCaseJson STRING` to the fresh `Symbol` and `SymbolVersion` DDL.

Create `m024-add-symbol-test-case.ts` using the idempotent DDL loop from m023:

```ts
export const version = 24;
export const description =
  "Add semantic test-case metadata and require graph rebuild";

const DDL = [
  "ALTER TABLE Symbol ADD testCaseJson STRING DEFAULT NULL",
  "ALTER TABLE SymbolVersion ADD testCaseJson STRING DEFAULT NULL",
];

export async function up(conn: Connection): Promise<void> {
  for (const ddl of DDL) {
    try {
      await execDdl(conn, ddl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
    }
  }

  await exec(
    conn,
    `MATCH (d:DerivedState)
     SET d.graphIntegrityState = 'unknown',
         d.graphIntegrityVersionId = NULL,
         d.graphIntegrityDigest = NULL,
         d.graphIntegrityError = NULL,
         d.graphIntegrityRevision = NULL,
         d.graphIntegrityVerifiedRevision = NULL,
         d.graphIntegrityFilelessPruningSupported = NULL,
         d.graphIntegrityManifestEstablished = false`,
  );
}
```

Import and append `m024` in `src/db/migrations/index.ts`; let `LADYBUG_SCHEMA_VERSION` remain registry-derived.

- [ ] **Step 7: Run Task 1 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-facet.test.ts tests/unit/ladybug-schema.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts
git diff --check
git status --short
```

Expected: all selected tests pass; only Task 1 files plus the pre-existing native status marker are dirty.

Commit only Task 1 files:

```powershell
git add src/domain/types.ts src/util/test-case.ts src/indexer/treesitter/extractCalls.ts src/indexer/parser/types.ts src/db/schema.ts src/db/ladybug-symbols.ts src/db/ladybug-schema.ts src/db/migrations/m024-add-symbol-test-case.ts src/db/migrations/index.ts tests/unit/test-case-facet.test.ts tests/unit/ladybug-schema.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts
git commit -m "feat(index): add semantic test-case facet"
```

### Task 2: Propagate the persisted facet through every row path

**Files:**

- Modify: `src/db/ladybug-symbols.ts`
- Modify: `src/db/ladybug-provider-first.ts`
- Modify: `src/db/ladybug-safe-rebuild.ts`
- Modify: `src/db/ladybug-shadow-finalization.ts`
- Modify: `src/db/ladybug-versions.ts`
- Modify: `src/indexer/parser/build-rows.ts`
- Modify: `src/indexer/parser/rust-process-file.ts`
- Modify: `src/indexer/provider-first/legacy-shadow-rows.ts`
- Modify: `src/indexer/provider-first/materializer.ts`
- Modify: `src/indexer/provider-first/shadow-build.ts`
- Modify: `src/indexer/rustIndexer.ts`
- Modify: `src/live-index/draft-parser.ts`
- Modify: `src/sync/types.ts`
- Modify: `src/sync/sync.ts`
- Modify: `src/db/ladybug-graph-integrity.ts`
- Modify: `src/indexer/provider-first/persisted-graph-integrity.ts`
- Modify: `tests/unit/ladybug-symbol-batch-upsert.test.ts`
- Modify: `tests/unit/ladybug-version-queries.test.ts`
- Modify: `tests/unit/provider-first-indexing.test.ts`
- Modify: `tests/unit/persisted-graph-integrity.test.ts`
- Modify: `tests/unit/sync-artifact.test.ts`
- Modify: `tests/unit/draft-parser.test.ts`

- [ ] **Step 1: Write RED persistence, sync, overlay, and integrity tests**

Add one populated facet fixture and one null fixture. Assert all of these exact contracts:

- `upsertSymbolsBatch` writes and rereads `testCaseJson` unchanged.
- provider-first shadow rows, safe-rebuild rows, and final rows retain the same string.
- `snapshotSymbolVersion` stores `testCaseJson`, version queries reread it, and changing only the facet produces a distinct historical payload without changing the symbol ID.
- sync export emits `test_case_json` on both `symbols` and `symbol_versions`; import restores both; older artifacts without either field still import as null.
- draft rows retain `test_case_json` so overlay cards can hydrate it.
- changing only `testCaseJson` changes the canonical symbol JSON and graph-integrity digest.
- null and absent fields canonicalize identically.

Use this canonical fixture string everywhere:

```ts
const TEST_CASE_JSON =
  '{"framework":"node:test","title":"keeps sdl.info callable","suitePath":["Code Mode"],"modifiers":["only"]}';
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/ladybug-symbol-batch-upsert.test.ts tests/unit/ladybug-version-queries.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/sync-artifact.test.ts tests/unit/draft-parser.test.ts
```

Expected: field assertions fail at the first dropped row boundary.

- [ ] **Step 3: Thread one nullable column through existing mappings**

At every Symbol write/query/projection in the listed files:

- add `testCaseJson` beside `roleTagsJson` in camel-case in-memory rows;
- add `test_case_json` beside `role_tags_json` in artifact rows;
- bind `$testCaseJson` in Ladybug `MERGE`/`SET` statements;
- select `s.testCaseJson AS testCaseJson` in shadow, safe-rebuild, sync, and integrity reads;
- serialize `SymbolDetail.testCase` once as `serializeTestCaseFacet(detail.testCase) ?? null` when constructing rows;
- copy the persisted string unchanged after that boundary.

Do not add the facet to embedding text. In `src/db/ladybug-versions.ts`, add the nullable property to `SymbolVersionRow`, `snapshotSymbolVersion`, and version queries; the sync layer maps the same value through `symbol_versions`.

In `GraphIntegrityCanonicalSymbolTuple`, place `testCaseJson` immediately after `roleTagsJson`; normalize null/absent to `null` and include it in canonical JSON. Preserve all existing tuple fields and order.

- [ ] **Step 4: Run Task 2 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/ladybug-symbol-batch-upsert.test.ts tests/unit/ladybug-version-queries.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/sync-artifact.test.ts tests/unit/draft-parser.test.ts
git diff --check
git status --short
```

Expected: all selected tests pass and facet-only integrity changes produce a different digest.

Commit only Task 2 files:

```powershell
git add src/db/ladybug-symbols.ts src/db/ladybug-provider-first.ts src/db/ladybug-safe-rebuild.ts src/db/ladybug-shadow-finalization.ts src/db/ladybug-versions.ts src/indexer/parser/build-rows.ts src/indexer/parser/rust-process-file.ts src/indexer/provider-first/legacy-shadow-rows.ts src/indexer/provider-first/materializer.ts src/indexer/provider-first/shadow-build.ts src/indexer/rustIndexer.ts src/live-index/draft-parser.ts src/sync/types.ts src/sync/sync.ts src/db/ladybug-graph-integrity.ts src/indexer/provider-first/persisted-graph-integrity.ts tests/unit/ladybug-symbol-batch-upsert.test.ts tests/unit/ladybug-version-queries.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/sync-artifact.test.ts tests/unit/draft-parser.test.ts
git commit -m "feat(index): persist semantic test cases"
```

### Task 3: Expose the facet on cards without changing tool shape

**Files:**

- Modify: `src/services/card-builder.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/symbol-utils.ts`
- Modify: `src/ui/viewer/api.ts`
- Modify: `tests/unit/card-builder.test.ts`
- Modify: `tests/unit/symbol-utils.test.ts`
- Modify: `tests/integration/mcp-output-schema-wire.test.ts`

- [ ] **Step 1: Write RED card, ETag, and wire-order tests**

Add a card-builder fixture with `testCaseJson: TEST_CASE_JSON`. Assert minimal and full cards expose:

```ts
testCase: {
  framework: "node:test",
  title: "keeps sdl.info callable",
  suitePath: ["Code Mode"],
  modifiers: ["only"],
}
```

Assert null/malformed persisted values omit the field. Assert changing only the facet changes the card ETag. In `symbol-utils.test.ts`, assert `testCase` appears in the stable wire order immediately after `sideEffects` and before dependency fields.

- [ ] **Step 2: Run the card tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/card-builder.test.ts tests/unit/symbol-utils.test.ts tests/integration/mcp-output-schema-wire.test.ts
```

Expected: cards/schema/wire projections omit `testCase`.

- [ ] **Step 3: Add the optional public card field**

- Hydrate with `parseTestCaseFacetJson(row.testCaseJson)` in durable and overlay card builders.
- Include `testCase` in the same canonical card object used for ETag/content hashing.
- Add one shared `TestCaseFacetSchema` in `src/mcp/tools.ts` and make `SymbolCardSchema.testCase` optional.
- Add `testCase` to `WireCardInput`, `CARD_WIRE_FIELD_ORDER`, and `compactCardForWire` in the asserted position.
- Add the optional facet to the viewer's local card type.
- Leave `determinism.fixtures.json` unchanged in this task because its graph has no populated semantic facet yet; Task 8 adds a detector-backed fixture before updating it.

- [ ] **Step 4: Run Chunk 1 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-facet.test.ts tests/unit/ladybug-schema.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/ladybug-symbol-batch-upsert.test.ts tests/unit/ladybug-version-queries.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/sync-artifact.test.ts tests/unit/draft-parser.test.ts tests/unit/card-builder.test.ts tests/unit/symbol-utils.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/determinism.test.ts
git diff --check
git status --short
```

Expected: Chunk 1 passes, schema version is 24, and deterministic fixtures are stable.

Commit only Task 3 files:

```powershell
git add src/services/card-builder.ts src/mcp/tools.ts src/mcp/tools/symbol-utils.ts src/ui/viewer/api.ts tests/unit/card-builder.test.ts tests/unit/symbol-utils.test.ts tests/integration/mcp-output-schema-wire.test.ts
git commit -m "feat(mcp): expose semantic test cases on cards"
```

## Chunk 2: Detection, normalization, and index-pipeline parity

### Task 4: Add the shared attach/synthesize normalizer

**Files:**

- Modify: `src/indexer/adapter/LanguageAdapter.ts`
- Create: `src/indexer/test-case-normalizer.ts`
- Modify: `src/indexer/parser/symbol-mapping.ts`
- Create: `tests/unit/test-case-normalizer.test.ts`

- [ ] **Step 1: Write RED candidate and normalization tests**

Cover these cases in one table-driven test file:

1. Unique `attach` adds only `testCase`; name, kind, range, node ID, fingerprint, and generated symbol ID stay unchanged.
2. Missing and ambiguous attachments emit sorted repository-relative diagnostics and create no symbol.
3. `synthetic` adds one non-exported `function` with full construct range, supplied `sdl:test-case:<fingerprint>` node ID, and `astFingerprint === sourceFingerprint`.
4. Duplicate titles with distinct source slices receive distinct IDs; byte-identical slices use one-based occurrence ordinals and remain stable when run twice.
5. A call inside the synthetic range is re-owned by it; a call inside a smaller nested ordinary function remains owned by that function.
6. Equal-size ties prefer an ordinary symbol, then node ID, so ordering is byte-stable.

Use the real `generateSymbolId` path in `buildSymbolDetails` for the ID-preservation assertions.

- [ ] **Step 2: Run the test and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-normalizer.test.ts
```

Expected: candidate types and normalizer are missing.

- [ ] **Step 3: Add the minimal adapter contract**

In `LanguageAdapter.ts`, export the approved discriminated union:

```ts
export type TestCaseCandidate =
  | {
      mode: "attach";
      targetName: string;
      targetKinds: Array<"function" | "method">;
      constructRange: ExtractedSymbol["range"];
      testCase: TestCaseFacet;
    }
  | {
      mode: "synthetic";
      kind: "function";
      name: string;
      nodeId: string;
      constructRange: ExtractedSymbol["range"];
      sourceFingerprint: string;
      testCase: TestCaseFacet;
    };
```

Add one optional hook:

```ts
detectTestCases?(params: {
  tree: Tree | null;
  content: string;
  filePath: string;
  symbols: readonly ExtractedSymbol[];
}): TestCaseCandidate[];
```

Do not add a detector registry or base-class abstraction; existing adapters own their syntax.

- [ ] **Step 4: Implement one shared normalizer**

Export from `test-case-normalizer.ts`:

```ts
export function sourceFingerprintForTestCase(
  content: string,
  range: ExtractedSymbol["range"],
  occurrenceOrdinal: number,
): string;

export function applyTestCaseCandidates(params: {
  relPath: string;
  symbols: readonly SymbolWithNodeId[];
  calls: readonly ExtractedCall[];
  candidates: readonly TestCaseCandidate[];
}): {
  symbols: SymbolWithNodeId[];
  calls: ExtractedCall[];
  diagnostics: string[];
};
```

Use the existing SHA-256 content helper with the exact preimage:

```ts
`sdl-test-case-v1\0${sourceSlice}\0${occurrenceOrdinal}`
```

Candidate ordering is start line, start column, end line, end column, mode, kind/name, fingerprint. Attach only to one same-file symbol with matching name/kind and overlapping or contained range. For synthesis, append a `SymbolWithNodeId` with `exported: false` and the approved full range.

For every call, choose the smallest merged symbol range that contains the call range. Tie-break ordinary before synthetic, then `nodeId`; change `callerNodeId` only when a containing owner exists. Return copied arrays and sorted diagnostics; do not mutate adapter output.

Update `buildSymbolDetails` so a non-empty worker/synthetic `astFingerprint` wins before tree-node recomputation. Existing empty-string fallback behavior stays unchanged.

- [ ] **Step 5: Run Task 4 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-normalizer.test.ts
git diff --check
```

Expected: all normalization and ID/call-owner assertions pass.

```powershell
git add src/indexer/adapter/LanguageAdapter.ts src/indexer/test-case-normalizer.ts src/indexer/parser/symbol-mapping.ts tests/unit/test-case-normalizer.test.ts
git commit -m "feat(index): normalize semantic test cases"
```

### Task 5: Detect JavaScript/TypeScript and Python test cases

**Files:**

- Rename: `src/indexer/test-title-search-text.ts` to `src/indexer/typescript-test-cases.ts`
- Modify: `src/indexer/adapter/typescript.ts`
- Modify: `src/indexer/adapter/python.ts`
- Modify: `src/indexer/parser/build-rows.ts`
- Rename: `tests/unit/test-title-search-text.test.ts` to `tests/unit/typescript-test-cases.test.ts`
- Create: `tests/unit/python-test-cases.test.ts`
- Modify: `tests/unit/build-rows.test.ts`

- [ ] **Step 1: Replace title-only tests with RED semantic candidate tests**

For TypeScript, assert static `describe` nesting plus direct/global/imported `test` and `it` forms produce normalized candidates for `node:test`, Jest, and Vitest. Cover `.skip`, `.todo`, `.only`, and `.each`; `describe` contributes only `suitePath`. Include the exact target titles:

```ts
"rejects info and sdl.info as sdl.workflow actions"
"keeps sdl.info callable and discoverable in exclusive Code Mode"
```

Assert no candidate for dynamic template/interpolated titles, ordinary calls named `contest`, or helper callbacks.

For Python, assert `test_*` functions and methods attach as `pytest`; methods under a class derived from `unittest.TestCase` attach as `unittest`. Cover `pytest.mark.parametrize`, pytest/unittest skip decorators, an async test, and negative `helper_test`/ordinary methods.

In `build-rows.test.ts`, invert the old workaround assertion: module `searchText` no longer receives bundled test titles.

- [ ] **Step 2: Run detector tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/typescript-test-cases.test.ts tests/unit/python-test-cases.test.ts tests/unit/build-rows.test.ts
```

Expected: the renamed TypeScript module still returns text, Python has no hook, and module search text still contains titles.

- [ ] **Step 3: Convert the existing TypeScript collector into a detector**

Keep the installed TypeScript compiler API and existing static-string/bounds logic. Before creating a compiler source file, return `[]` unless the content contains a direct `describe`, `it`, or `test` call/member candidate; this is only a parse-cost guard, and the AST remains authoritative. Change the export to:

```ts
export function detectTypeScriptTestCases(params: {
  content: string;
  filePath: string;
}): TestCaseCandidate[];
```

Determine framework from imports/requires in fixed priority `node:test`, `vitest`, then `jest`; unimported globals default to `jest`. Normalize direct `test`/`it`, member `.skip`/`.todo`/`.only`, and `.each` forms. Only string literals and no-substitution templates are static. Assign synthetic fingerprints after range sorting; count ordinals separately for byte-identical exact source slices.

Wire `TypeScriptAdapter.detectTestCases` to this function. Remove `extractStaticTestTitleSearchText` and its call from `buildSymbolAndEdgeRows`; ordinary module search text reverts to the canonical enrichment builder.

- [ ] **Step 4: Add the declaration-oriented Python hook**

Implement `PythonAdapter.detectTestCases` in the existing adapter. If `tree` is null, first apply a cheap source hint for `def test_`/`async def test_`; only then call the existing adapter parser once. Walk `function_definition` nodes, read their existing extracted name/range, and emit `attach` candidates only for names beginning `test_`.

Framework rules:

- enclosing class derived from `unittest.TestCase` -> `unittest`;
- otherwise -> `pytest`;
- enclosing test class names form `suitePath`;
- `pytest.mark.skip`, `pytest.mark.skipif`, `unittest.skip`, `unittest.skipIf`, and `unittest.skipUnless` add `skip`;
- `pytest.mark.parametrize` adds `parameterized`.

Do not synthesize Python functions; extraction already gives them structural symbols.

- [ ] **Step 5: Run Task 5 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/typescript-test-cases.test.ts tests/unit/python-test-cases.test.ts tests/unit/build-rows.test.ts tests/unit/test-case-normalizer.test.ts
git diff --check
```

Expected: both detector families pass, and the module-title workaround is gone.

```powershell
git add src/indexer/test-title-search-text.ts src/indexer/typescript-test-cases.ts src/indexer/adapter/typescript.ts src/indexer/adapter/python.ts src/indexer/parser/build-rows.ts tests/unit/test-title-search-text.test.ts tests/unit/typescript-test-cases.test.ts tests/unit/python-test-cases.test.ts tests/unit/build-rows.test.ts
git commit -m "feat(index): detect TypeScript and Python tests"
```

### Task 6: Apply the same normalizer in legacy, worker/native, live, and provider-first paths

**Files:**

- Modify: `src/indexer/parser/parse-and-extract.ts`
- Modify: `src/indexer/parser/rust-process-file.ts`
- Modify: `src/live-index/draft-parser.ts`
- Modify: `src/indexer/provider-first/executor.ts`
- Modify: `src/indexer/provider-first/materializer.ts`
- Create: `tests/fixtures/semantic-test-cases/sample.test.ts`
- Create: `tests/fixtures/semantic-test-cases/test_sample.py`
- Modify: `tests/unit/draft-parser.test.ts`
- Modify: `tests/unit/native-parser-chaos.test.ts`
- Modify: `tests/unit/provider-first-indexing.test.ts`
- Modify: `tests/integration/provider-first-scip-execution.test.ts`
- Modify: `tests/integration/engine-parity.test.ts`
- Modify: `tests/harness/engine-parity-runner.ts`

- [ ] **Step 1: Write RED cross-pipeline parity fixtures**

Use one TypeScript fixture under `tests/fixtures/semantic-test-cases/sample.test.ts` containing a nested suite, two duplicate titles, a nested helper function, and a call in each scope. Assert legacy fallback, worker/native adaptation, live draft, and provider-first produce identical facet JSON, synthetic symbol ID, full range, and ordering.

Assert legacy/worker/live reassign top-level calls to the synthetic case while the nested helper keeps its call. In the provider test, inject the same TypeScript content at nonconventional path `src/embedded-cases.ts`; assert it is still detected, its row has `astFingerprint === sourceFingerprint`, and provider `EdgeFact` ownership remains unchanged. Add a Python parity fixture proving named-symbol attachment preserves its ID.

Add provider failure fixtures for an unreadable changed file, detector exception, and ambiguous attachment. Each must emit a deterministic repository-relative diagnostic and preserve the ordinary provider rows.

- [ ] **Step 2: Run parity tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/draft-parser.test.ts tests/unit/native-parser-chaos.test.ts tests/unit/provider-first-indexing.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/engine-parity.test.ts
```

Expected: only direct detector tests pass; pipeline rows lack semantic cases.

- [ ] **Step 3: Normalize retained-content pipelines before row construction**

In `parseAndExtract`, after ordinary symbols/imports/calls exist, call the adapter hook and `applyTestCaseCandidates`. Reuse the sync tree. When a worker returned `tree: null`, pass null; TypeScript detection uses its existing compiler parse, while Python performs its own hinted one-time fallback parse. Log each diagnostic with repository-relative `relPath` only.

Do the same after native symbols/calls are adapted in `rust-process-file.ts` and after ordinary extraction in `draft-parser.ts`. Both already retain content; never reread the file. Feed the merged symbols/calls into the existing maps and row builders.

- [ ] **Step 4: Add bounded provider-first augmentation**

After provider facts are collected and before `providerFactsToGraphRows`, inspect every changed JavaScript/TypeScript or Python source file whose recorded size is within the existing `maxFileBytes`. Read each eligible source at most once, resolve its existing adapter, run `detectTestCases`, and pass a `Map<relPath, TestCaseCandidate[]>` into a new optional materializer option. The detector's cheap syntax checks prevent parsing files without candidate syntax; do not use path naming as a semantic gate.

In `providerFactsToGraphRows`:

- attach only by unique path + name + `function`/`method` kind + range overlap;
- serialize the facet with the shared helper;
- materialize synthetic rows with the shared generated symbol ID, `astFingerprint: candidate.sourceFingerprint`, `scipSymbol: null`, tree-sitter/SDL provenance, full range, and deterministic ordering;
- add their node IDs to the existing file/symbol ownership mappings;
- do not rewrite provider `EdgeFact` owners because they lack source occurrence ranges.

A failed read/detector/attachment records one deterministic repository-relative diagnostic and preserves provider rows. Do not add retries, caches, or worker transport fields.

- [ ] **Step 5: Run Chunk 2 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-normalizer.test.ts tests/unit/typescript-test-cases.test.ts tests/unit/python-test-cases.test.ts tests/unit/build-rows.test.ts tests/unit/draft-parser.test.ts tests/unit/native-parser-chaos.test.ts tests/unit/provider-first-indexing.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/engine-parity.test.ts
git diff --check
git status --short
```

Expected: facet/range/ID parity passes; provider edge ownership remains intentionally unchanged.

```powershell
git add src/indexer/parser/parse-and-extract.ts src/indexer/parser/rust-process-file.ts src/live-index/draft-parser.ts src/indexer/provider-first/executor.ts src/indexer/provider-first/materializer.ts tests/fixtures/semantic-test-cases/sample.test.ts tests/fixtures/semantic-test-cases/test_sample.py tests/unit/draft-parser.test.ts tests/unit/native-parser-chaos.test.ts tests/unit/provider-first-indexing.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/engine-parity.test.ts tests/harness/engine-parity-runner.ts
git commit -m "feat(index): index test cases across pipelines"
```

## Chunk 3: Existing retrieval path, exact acceptance, and documentation

### Task 7: Feed facet terms into existing FTS and test filtering

**Files:**

- Modify: `src/indexer/symbol-enrichment.ts`
- Modify: `src/indexer/parser/build-rows.ts`
- Modify: `src/live-index/draft-parser.ts`
- Modify: `src/indexer/provider-first/materializer.ts`
- Modify: `src/retrieval/task-query-ranking.ts`
- Modify: `src/retrieval/context-candidate-search.ts`
- Modify: `src/context/types.ts`
- Modify: `src/context/engine.ts`
- Modify: `tests/unit/symbol-enrichment.test.ts`
- Modify: `tests/unit/context-candidate-overlay-snapshot.test.ts`
- Modify: `tests/unit/context-v2-db-boundary.test.ts`
- Modify: `tests/unit/context-v2.test.ts`

- [ ] **Step 1: Write RED search-text and `includeTests` tests**

Assert `buildSearchText` for a semantic case contains the exact normalized title `keeps sdl.info callable`, identifier-like title terms `keeps`, `sdl`, `info`, `callable`, suite value `code mode` plus its split terms, framework `node:test`, and modifier `only`. Assert their order follows the Step 3 append order and duplicates are removed by the existing `seen` set.

The exact full fixture output must also retain existing name, summary, kind, role-tag, path, and signature terms in their current positions. Assert no facet leaves output byte-identical to today.

Add durable and overlay candidate fixtures at non-test path `src/server.ts` for four persisted states: valid facet JSON, null, absent, and malformed JSON. Only successful facet parsing is authoritative test evidence. Assert `includeTests: false` filters the valid semantic case at the same boundaries as a test-like path, while null/absent/malformed rows retain path-only behavior; `includeTests: true` admits the valid case. Keep the path fallback for helpers/fixtures.

- [ ] **Step 2: Run focused retrieval tests and confirm RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/symbol-enrichment.test.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts tests/unit/context-v2.test.ts
```

Expected: title/suite/framework terms are absent and non-test paths ignore the facet.

- [ ] **Step 3: Extend canonical search text, not ranking**

Add `testCase?: TestCaseFacet | null` to `BuildSearchTextParams`. Append after `roleTags`:

```ts
params.testCase?.title ?? "",
...splitIdentifierLikeText(params.testCase?.title ?? ""),
...(params.testCase?.suitePath ?? []),
...(params.testCase?.suitePath ?? []).flatMap(splitIdentifierLikeText),
params.testCase?.framework ?? "",
params.testCase?.category ?? "",
...(params.testCase?.modifiers ?? []),
```

Pass the facet from legacy/live/provider row builders. If a native/provider search string exists, rebuild or deterministically append facet terms through `buildSearchText`; do not trust a native string that predates the facet. Do not change FTS limits, RRF weights, PPR, directory partitioning, or token allocation.

- [ ] **Step 4: Make the facet authoritative at existing test predicates**

Add one helper beside `isTestLikePath`:

```ts
export function isTestCandidate(
  filePath: string,
  hasTestCaseFacet: boolean,
): boolean {
  return hasTestCaseFacet || isTestLikePath(filePath);
}
```

Carry nullable `testCaseJson` on durable `ContextCandidateSearchRow` projections only until candidate normalization. Derive internal `hasTestCaseFacet` as `parseTestCaseFacetJson(row.testCaseJson) !== undefined`; derive overlay candidates from `card.testCase !== undefined`. Do not expose raw JSON in public context output. Replace the existing path-only checks in `context-candidate-search.ts` and `engine.ts` with `isTestCandidate`. Keep `isTestLikePath` as fallback and leave task-profile defaults unchanged.

- [ ] **Step 5: Run Task 7 GREEN and commit**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/symbol-enrichment.test.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts tests/unit/context-v2.test.ts
git diff --check
```

Expected: existing ranking is unchanged except that semantic cases are searchable and test-aware.

```powershell
git add src/indexer/symbol-enrichment.ts src/indexer/parser/build-rows.ts src/live-index/draft-parser.ts src/indexer/provider-first/materializer.ts src/retrieval/task-query-ranking.ts src/retrieval/context-candidate-search.ts src/context/types.ts src/context/engine.ts tests/unit/symbol-enrichment.test.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts tests/unit/context-v2.test.ts
git commit -m "fix(context): retrieve semantic test cases"
```

### Task 8: Add exact acceptance and populated determinism coverage

**Files:**

- Modify: `tests/benchmark/context-quality.test.ts`
- Modify: `tests/unit/code-mode-tool-validation.test.ts`
- Modify: `tests/integration/determinism.test.ts`
- Modify: `tests/integration/determinism.fixtures.json`

- [ ] **Step 1: Add the exact acceptance case and populated determinism fixture**

Use the existing initialized `handleAgentContext`/isolated graph section in `context-quality.test.ts`. Send exactly:

```ts
const request = {
  repoId: REPO_ID,
  taskType: "review" as const,
  taskText:
    "Find the tests that assert sdl.info is exposed as a top-level Code Mode tool and rejected as an sdl.workflow action.",
  focusPaths: ["tests"],
  includeTests: true,
  budget: { maxTokens: 2400 },
  responseMode: "inline" as const,
  refsMode: "off" as const,
  wireFormat: "json" as const,
};
```

Assert two evidence items from `tests/unit/code-mode-tool-validation.test.ts` have card names/titles:

```ts
const expectedTitles = [
  "rejects info and sdl.info as sdl.workflow actions",
  "keeps sdl.info callable and discoverable in exclusive Code Mode",
];
```

Assert their actual evidence excerpts include `Invalid sdl.workflow request` and `handlers.has("sdl.info")`; assert no evidence card is named `createArtifact` or `weight`; assert the target path is absent from `omitted.highestRanked`; assert `estimateTokens(JSON.stringify(result)) <= 2400`; and assert two repeated calls serialize identically.

Do not alter the contract test titles/body just to improve retrieval. If current assertions do not contain those exact literals, retain their semantics and add only the smallest explicit assertion needed by the approved acceptance contract.

Add `tests/unit/code-mode-tool-validation.test.ts` case `keeps sdl.info callable and discoverable in exclusive Code Mode` as the detector-backed determinism fixture target. Assert its persisted card contains that exact `testCase.title`, then make the existing repeated-call/fresh-process fixture comparison cover the populated field. Update only the affected fixture entries; tool names, descriptions, schemas, and ordering remain unchanged.

- [ ] **Step 2: Run the acceptance and determinism gates GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts tests/benchmark/context-quality.test.ts
```

Expected: both tests pass. This is a post-implementation acceptance task; its RED baseline is the verified failing response captured in the approved design. If it fails now, repair the owning implementation from Tasks 1-7 and rerun without changing the titles, exclusions, or 2,400-token budget.

- [ ] **Step 3: Run GREEN and commit**

Run the command from Step 2 twice. Expected: both runs pass and print byte-stable acceptance output.

```powershell
git diff --check
git add tests/benchmark/context-quality.test.ts tests/unit/code-mode-tool-validation.test.ts tests/integration/determinism.test.ts tests/integration/determinism.fixtures.json
git commit -m "test(context): require sdl.info contract cases"
```

### Task 9: Document the model, rebuild requirement, and release boundary

**Files:**

- Modify: `docs/mcp-tools-reference.md`
- Modify: `docs/architecture.md`
- Modify: `docs/feature-deep-dives/agent-context.md`
- Modify: `docs/feature-deep-dives/context-modes.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update public documentation**

Document these exact points:

- `SymbolCard.testCase` is optional and contains framework, title, optional suite path/category/modifiers.
- Structural kinds do not change; named tests retain IDs, anonymous static cases are synthetic `function` symbols covering the complete construct.
- initial detector coverage is JS/TS node:test/Jest/Vitest plus Python pytest/unittest; other language detectors are later independent additions.
- existing symbol FTS and hot-path evidence consume the facet; there is no test-only lane or query-time scan.
- schema version 24 requires stopping SDL-MCP and building a fresh graph with `sdl-mcp index --force --safe-rebuild <absolute-new-path>`; an in-place nullable column does not backfill synthetic symbols.
- the earlier directory-focus and dotted-evidence behavior remains; replace only statements that describe module-level static-title metadata.

Add one Unreleased changelog bullet under Added and one under Changed for the schema/rebuild requirement. Do not claim unsupported language detectors.

- [ ] **Step 2: Verify docs and commit**

Run:

```powershell
npm run docs:tools:check
git diff --check
git diff -- docs/mcp-tools-reference.md docs/architecture.md docs/feature-deep-dives/agent-context.md docs/feature-deep-dives/context-modes.md CHANGELOG.md
```

Expected: docs checks pass and no old module-title claim remains.

```powershell
git add docs/mcp-tools-reference.md docs/architecture.md docs/feature-deep-dives/agent-context.md docs/feature-deep-dives/context-modes.md CHANGELOG.md
git commit -m "docs(index): document semantic test cases"
```

### Task 10: Run full verification and disposable verified-graph acceptance

**Files:**

- No repository changes expected.

- [ ] **Step 1: Run static, focused, and full regression gates**

Run:

```powershell
npm run build:all
npm run typecheck
npm run lint
node --experimental-strip-types --test --test-concurrency=1 tests/unit/test-case-facet.test.ts tests/unit/test-case-normalizer.test.ts tests/unit/typescript-test-cases.test.ts tests/unit/python-test-cases.test.ts tests/unit/ladybug-schema.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/ladybug-symbol-batch-upsert.test.ts tests/unit/ladybug-version-queries.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/sync-artifact.test.ts tests/unit/draft-parser.test.ts tests/unit/card-builder.test.ts tests/unit/symbol-utils.test.ts tests/unit/symbol-enrichment.test.ts tests/unit/context-candidate-overlay-snapshot.test.ts tests/unit/context-v2-db-boundary.test.ts tests/unit/context-v2.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/engine-parity.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/determinism.test.ts tests/benchmark/context-quality.test.ts
npm test
npm run docs:tools:check
```

Expected: every command exits 0. Investigate any failure; do not waive it as unrelated without reproducing it on the pre-task commit.

- [ ] **Step 2: Build a disposable full graph**

Set `SDL_CONTEXT_ACCEPTANCE_CONFIG` to a Code Mode config registering this worktree and pointing to a disposable LadybugDB path not owned by another process. Set `SDL_CONTEXT_ACCEPTANCE_REPO_ID` if the config uses an ID other than `sdl-mcp`.

```powershell
$acceptanceRepoId = if ($env:SDL_CONTEXT_ACCEPTANCE_REPO_ID) { $env:SDL_CONTEXT_ACCEPTANCE_REPO_ID } else { "sdl-mcp" }
node dist/cli/index.js --config $env:SDL_CONTEXT_ACCEPTANCE_CONFIG index --repo-id $acceptanceRepoId --force
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Expected: index exits 0. A fresh server must report `graphIntegrityState: "verified"`, `graphIntegrityVersionId === latestVersionId`, equal current/verified revisions, and all dirty flags false before retrieval is judged.

- [ ] **Step 3: Run the exact request twice in a fresh process**

Use SDL `runtimeExecute` with `runtime: "node"`, this worktree as `relativeCwd`, `timeoutMs: 120000`, and the complete body below:

```js
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { estimateTokens } from "./dist/util/tokenize.js";

const acceptanceConfig = process.env.SDL_CONTEXT_ACCEPTANCE_CONFIG;
assert.ok(
  acceptanceConfig,
  "set SDL_CONTEXT_ACCEPTANCE_CONFIG to an isolated Code Mode config",
);
const repoId = process.env.SDL_CONTEXT_ACCEPTANCE_REPO_ID ?? "sdl-mcp";
const client = new Client(
  { name: "semantic-test-case-verifier", version: "1.0.0" },
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
    { method: "tools/call", params: { name, arguments: args } },
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
  repoId,
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
    repoId,
    steps: [{ fn: "repo.status", args: { detail: "standard" } }],
  });
  const status = statusEnvelope.results?.[0]?.result;
  assert.ok(status, "repo.status result missing");
  assert.equal(status.derivedState?.graphIntegrityState, "verified");
  assert.equal(
    status.derivedState?.graphIntegrityVersionId,
    status.latestVersionId,
  );
  assert.equal(
    status.derivedState?.graphIntegrityRevision,
    status.derivedState?.graphIntegrityVerifiedRevision,
  );
  assert.equal(
    status.derivedState?.targetVersionId,
    status.derivedState?.computedVersionId,
    "derived state must not be stale",
  );
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

  const expectedTitles = new Set([
    "rejects info and sdl.info as sdl.workflow actions",
    "keeps sdl.info callable and discoverable in exclusive Code Mode",
  ]);
  const target = firstPayload.evidence.filter(
    (item) => item.path === "tests/unit/code-mode-tool-validation.test.ts",
  );
  const foundTitles = new Set(
    target.flatMap((item) =>
      typeof item.content?.testCase?.title === "string"
        ? [item.content.testCase.title]
        : [],
    ),
  );
  assert.deepEqual(foundTitles, expectedTitles);

  const targetText = target
    .map((item) => item.content?.excerpt ?? JSON.stringify(item.content))
    .join("\n");
  assert.match(targetText, /Invalid sdl\.workflow request/);
  assert.match(targetText, /handlers\.has\("sdl\.info"\)/);
  assert.equal(
    firstPayload.evidence.some((item) =>
      ["createArtifact", "weight"].includes(item.content?.name),
    ),
    false,
  );
  assert.equal(
    (firstPayload.omitted?.highestRanked ?? []).some(
      (item) => item.path === "tests/unit/code-mode-tool-validation.test.ts",
    ),
    false,
  );
  assert.ok(estimateTokens(JSON.stringify(firstPayload)) <= 2400);
  process.stdout.write(JSON.stringify(firstPayload));
} finally {
  await client.close();
}
```

Expected: runtime exits 0; stdout is the first structured payload, both semantic test cases and assertion literals are present, benchmark symbols are absent, the payload is within 2,400 tokens, and repeated calls are byte-identical.

- [ ] **Step 4: Prove unchanged-reindex stability**

Save the first structured payload outside the repository, stop the server, rerun the forced full index command from Step 2 against the unchanged worktree, start a fresh server, and run the same request once. Compare `JSON.stringify` output byte-for-byte with the saved payload.

Expected: the graph is verified again and the response is identical. Any difference must be traced to ordering, fingerprint, canonical JSON, or response projection; do not loosen the assertion.

- [ ] **Step 5: Review final branch state**

Run:

```powershell
git status --short --branch
git log --oneline -12
git diff --check main...HEAD
```

Expected: only the pre-existing `native/src/scip/scip.rs` marker remains unstaged. Request final code review and use `verification-before-completion`. Merge locally only after review is clean; do not push unless separately requested.
