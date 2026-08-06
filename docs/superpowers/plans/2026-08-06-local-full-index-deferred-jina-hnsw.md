# Local Full-Index Deferred Jina HNSW Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every locally owned, one-shot effective-full index defer the configured Jina Symbol HNSW build until a strict close and cold reopen, then fail closed unless the global index is healthy and query-valid.

**Architecture:** Keep repository indexing and vector persistence in `indexRepo`, extract the existing safe-rebuild Jina build/validation code into one shared indexer component, and let the direct CLI and safe rebuild retain their distinct LadybugDB lifecycle ownership. Reuse `resolveEffectiveIndexMode`, the normal `initGraphDb`/`closeLadybugDb({ strict: true })` lifecycle, and existing HNSW catalog procedures; add only the minimum shared configuration, probe, and callback contracts needed to target one configured index consistently.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, LadybugDB/Kuzu stored procedures, Zod-backed SDL-MCP configuration, PowerShell verification commands.

---

## Scope and success criteria

- Local, non-delegated, non-watch commands defer Jina HNSW creation when at least one selected repository resolves to effective `full` mode.
- Initial repositories and registered repositories with zero indexed files are identified as `full` before indexing starts.
- Once eligible, every repository in that command receives the same deferral contract so a companion incremental repository cannot recreate the global Symbol index.
- The configured Jina model, index name, vector property, dimension, and `semantic.retrieval.vector.efc` value are resolved once and reused by drop, build, and validation.
- Safe rebuild and direct indexing share build/validation logic only; safe-family lease and normal-family lifecycle code remain separate.
- A successful direct command closes, cold-reopens, creates or validates the index, cold-reopens again after catalog mutation, query-validates, and strictly closes before printing completion.
- A repository failure remains primary. A repair is attempted only when eligible deferral has already reported that the configured index may be absent; repair and teardown errors are printed as secondary diagnostics.
- Nomic remains unchanged. No flags, subprocess, alternate HNSW implementation, or `efc` tuning are added.
- End-to-end command wall time starts at `indexCommand` entry and stops after the final strict close.

## Baseline and test discipline

The isolated worktree baseline is clean. `npm test` passed 690/692 files; the two failures were existing parallel-worker flakes:

- `tests/integration/background-reconcile.test.ts`: stale temporary LadybugDB family; standalone rerun passed 1/1.
- `tests/integration/semantic-embedding.test.ts`: vector extension unavailable in a parallel worker; standalone rerun passed 14/14.

Use test-first steps below. After a full-suite run, inspect fixture diffs before restoring anything; only restore files proven to be test-generated EOL-only rewrites with `git diff --ignore-space-at-eol --exit-code`.

## Chunk 1: One configured deferral contract

### Task 1: Resolve one configured Jina HNSW specification

**Files:**

- Create: `src/indexer/jina-hnsw-finalization.ts`
- Test: `tests/unit/jina-hnsw-finalization.test.ts`
- Reference: `src/config/types.ts`
- Reference: `src/config/semantic-embedding-model-plan.ts`
- Reference: `src/retrieval/model-mapping.ts`

- [ ] **Step 1: Write failing resolver tests**

Add table-driven tests for an exported `resolveConfiguredJinaHnswSpec(config)` function. Cover:

- semantic disabled -> `undefined`
- vector retrieval disabled -> `undefined`
- Jina absent from the Symbol model plan -> `undefined`
- default config -> `{ model, indexName, vectorProperty, dimension, efc }`
- custom `indexes[jina].indexName` and custom `efc` -> exact configured values

Use the existing `EMBEDDING_MODELS` entry for property and dimension; do not duplicate 768 or the default name.

- [ ] **Step 2: Run the test to prove it fails**

Run:

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/jina-hnsw-finalization.test.ts
```

Expected: FAIL because the module/export does not exist.

- [ ] **Step 3: Implement the minimal shared specification**

In `src/indexer/jina-hnsw-finalization.ts`:

- Define `JINA_CODE_MODEL` once.
- Define `ConfiguredJinaHnswSpec` with exactly `model`, `indexName`, `vectorProperty`, `dimension`, and `efc`.
- Resolve enablement through `resolveSemanticEmbeddingModelPlan` and existing semantic/vector flags.
- Read `indexName` and `efc` from parsed config, with `EMBEDDING_MODELS[JINA_CODE_MODEL]` as the model metadata source.
- Return `undefined` when the command has no Jina Symbol vector index to finalize.

Do not add a generic vector-index abstraction; this change is intentionally Jina-only.

- [ ] **Step 4: Rebuild and run the focused test**

Run the two commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the resolver**

```powershell
git add src/indexer/jina-hnsw-finalization.ts tests/unit/jina-hnsw-finalization.test.ts
git commit -m "feat(indexer): resolve configured jina hnsw spec"
```

### Task 2: Thread the exact spec and immediate may-be-absent signal through indexing

**Files:**

- Modify: `src/indexer/indexer.ts`
- Modify: `src/indexer/metrics-updater.ts`
- Modify: `src/indexer/provider-first/semantic-readiness.ts`
- Modify: `src/indexer/embeddings.ts`
- Modify: `src/cli/commands/index-safe-rebuild.ts`
- Modify: `tests/unit/provider-first-indexing.test.ts`
- Modify: `tests/unit/metrics-updater-runtime.test.ts`
- Modify: `tests/integration/semantic-embedding.test.ts`
- Modify: `tests/integration/safe-rebuild-validation.test.ts`
- Modify: `tests/unit/semantic-pipeline-regressions.test.ts`

- [ ] **Step 1: Add failing contract tests**

Extend focused tests to prove:

- `IndexRepoOptions` passes a `ConfiguredJinaHnswSpec` and `onJinaHnswMayBeAbsent` callback through both provider-first semantic readiness and the legacy `finalizeIndexing` path in `metrics-updater.ts`.
- `refreshSymbolEmbeddings` drops `spec.indexName`, not the model-mapping default.
- `refreshSymbolEmbeddings` calls the callback immediately after `dropVectorIndex` returns `dropped` or `absent`, before persistence can fail.
- A failed drop does not call the callback and keeps the existing indexed-write fallback.
- Deferred progress says `deferred until cold reopen`.
- Non-deferred creation uses the passed `spec.efc` when a caller supplies the spec.
- Safe rebuild resolves the spec once and passes the same object to every repository, observed through the existing `_indexRepoForTesting` seam.

Use a callback that pushes events into an array, then inject an embedding-provider failure through the existing `embeddingProvider` seam to assert ordering: `may-be-absent` must precede the thrown/failed inference result. Do not add persistence dependency injection; persistence failures are already retried/swallowed by the existing contract.

- [ ] **Step 2: Run the focused tests to prove they fail**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/provider-first-indexing.test.ts tests/unit/metrics-updater-runtime.test.ts tests/unit/semantic-pipeline-regressions.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/semantic-embedding.test.ts tests/integration/safe-rebuild-validation.test.ts
```

Expected: FAIL on missing spec/callback propagation and the old safe-rebuild-specific progress text.

- [ ] **Step 3: Replace the safe-specific boolean with one small option object**

In `src/indexer/indexer.ts`, replace `deferJinaVectorIndexCreate?: boolean` with a single internal option such as:

```ts
jinaHnswFinalization?: {
  spec: ConfiguredJinaHnswSpec;
  deferCreate: true;
  onMayBeAbsent?: () => void;
};
```

Pass that contract to all existing semantic-readiness call sites. Update `finalizeIndexing` in `metrics-updater.ts`, which directly calls `refreshSymbolEmbeddings`, as well as provider-first semantic readiness. Do not create parallel provider-first and legacy types.

In `semantic-readiness.ts`, pass `spec`, `deferVectorIndexCreate`, and the callback only to the matching Jina model. Continue leaving Nomic and unsupported models untouched.

- [ ] **Step 4: Use the shared spec at the actual drop/create boundary**

In `refreshSymbolEmbeddings`:

- Select the passed spec only when `spec.model === modelName`; otherwise retain existing model mapping behavior.
- Use its configured `indexName`, `vectorProperty`, `dimension`, and `efc` consistently.
- Invoke `onVectorIndexMayBeAbsent` synchronously after a `dropped` or `absent` result is known and before any embedding inference/persistence can throw.
- Never invoke it for `failed`.
- Keep the callback one-way; the CLI owns monotonic aggregation.
- Change only the deferred progress/log wording to `deferred until cold reopen`.

Leave `runHnswRebuildCycle`, persistence batching, and incremental debounce behavior unchanged.

- [ ] **Step 5: Update safe rebuild to use the new contract**

Resolve the configured spec once near `runSafeRebuild` setup. When present, pass it with `deferCreate: true` to every full repository. Safe rebuild does not need the command repair callback because its candidate-family failure cleanup already owns recovery.

- [ ] **Step 6: Rebuild and run the focused tests**

Run all commands from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit the propagation contract**

```powershell
git add src/indexer/indexer.ts src/indexer/metrics-updater.ts src/indexer/provider-first/semantic-readiness.ts src/indexer/embeddings.ts src/cli/commands/index-safe-rebuild.ts tests/unit/provider-first-indexing.test.ts tests/unit/metrics-updater-runtime.test.ts tests/integration/semantic-embedding.test.ts tests/integration/safe-rebuild-validation.test.ts tests/unit/semantic-pipeline-regressions.test.ts
git commit -m "feat(indexer): propagate deferred jina hnsw contract"
```

## Chunk 2: Shared reopened builder and logical-vector validation

### Task 3: Add deterministic Symbol vector probes and return query rows

**Files:**

- Modify: `src/db/ladybug-symbol-embeddings.ts`
- Modify: `src/db/ladybug-safe-rebuild.ts`
- Modify: `src/retrieval/index-lifecycle.ts`
- Modify: `tests/unit/retrieval-index-lifecycle.test.ts`
- Modify: `tests/integration/semantic-embedding.test.ts`

- [ ] **Step 1: Write failing probe tests**

Add tests for these exact contracts:

- A deterministic numeric-vector probe orders by `repoId`, then logical `symbolId`, and returns `{ repoId, symbolId, vector }`.
- A per-repository probe can distinguish a non-empty selected repository with no valid Jina vector from an empty repository.
- `queryVectorIndexProbe` returns validated `{ symbolId, distance }[]` rows rather than only a count.
- The stored-procedure query remains fixed at `k=10`, `efs=200`, and returns logical `node.symbolId`.
- More than ten symbols with the same vector still validate when any returned logical Symbol resolves to a matching persisted numeric vector.

The DB helper may page deterministically until it finds a dimension-correct, finite vector; keep the page size small and fixed. Do not load every vector into memory.

- [ ] **Step 2: Run focused tests to prove they fail**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/retrieval-index-lifecycle.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/semantic-embedding.test.ts
```

Expected: FAIL because the existing helper is safe-rebuild-specific and `queryVectorIndexProbe` returns a number.

- [ ] **Step 3: Move the probe to the existing Symbol embedding DB module**

Add model-aware numeric-vector reads to `ladybug-symbol-embeddings.ts` using property names from `model-mapping.ts` and validated internal identifiers. Include:

- deterministic global probe selection
- selected-repository Symbol count plus valid-probe selection
- point lookup of the returned logical Symbol's numeric vector

The existing `export * from "./ladybug-symbol-embeddings.js"` barrel entry already exports the new helpers; do not touch `ladybug-queries.ts`. Remove `readSafeRebuildJinaVectorProbe` from `ladybug-safe-rebuild.ts` after all callers migrate; do not leave a compatibility wrapper used only by tests.

- [ ] **Step 4: Return validated query rows**

Change `queryVectorIndexProbe` to return typed logical rows. Retain identifier validation, finite-distance validation, non-empty IDs, and the near-zero requirement. Callers, not this low-level query helper, will verify the returned ID's persisted vector against the deterministic probe.

- [ ] **Step 5: Implement cosine-match validation in the integration test**

For each returned near-zero candidate:

- point-read the persisted numeric vector by logical Symbol ID
- require equal dimension and finite values
- compute cosine distance in test/shared validation code
- accept when absolute distance from the probe is at most `1e-6`

Use at least eleven tied rows so the test does not assume the chosen probe ID is among the first ten results.

- [ ] **Step 6: Rebuild and run the focused tests**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit the probe contract**

```powershell
git add src/db/ladybug-symbol-embeddings.ts src/db/ladybug-safe-rebuild.ts src/retrieval/index-lifecycle.ts tests/unit/retrieval-index-lifecycle.test.ts tests/integration/semantic-embedding.test.ts
git commit -m "fix(retrieval): validate logical jina hnsw probes"
```

### Task 4: Extract safe rebuild's build and validation logic into the shared component

**Files:**

- Modify: `src/indexer/jina-hnsw-finalization.ts`
- Modify: `src/cli/commands/index.ts`
- Modify: `src/cli/commands/index-safe-rebuild.ts`
- Modify: `tests/unit/jina-hnsw-finalization.test.ts`
- Modify: `tests/integration/safe-rebuild-validation.test.ts`
- Modify: `tests/unit/provider-first-cli-output.test.ts`

- [ ] **Step 1: Write failing shared-finalizer tests**

Cover the shared component without owning close/reopen itself:

- all selected full repositories and global Symbol table empty -> `skipped-empty`, no create
- safe `requireAbsent` mode with an existing configured index and an empty candidate -> deferral failure, not `skipped-empty`
- non-empty selected full repo without a valid Jina vector -> fail closed, even when another repository has one
- configured name present with wrong table/property/type, unhealthy status, or unloaded extension -> fail closed without drop/replacement
- healthy existing configured index in direct mode -> `validated-existing`, no create
- any existing configured index in safe `requireAbsent` mode -> deferral failure
- absent index with a valid probe -> create once with exact property/dimension/efc and return `created`
- create false/failure -> fail closed
- validation accepts any near-zero returned ID whose persisted vector cosine-matches the deterministic probe
- validation rejects no rows, no near-zero row, missing returned Symbol vector, and vector mismatch

Use dependency injection only at the stored-procedure/catalog boundary already represented by the module's dependencies. Do not invent a class or interface hierarchy.

- [ ] **Step 2: Run tests to prove they fail**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/jina-hnsw-finalization.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/safe-rebuild-validation.test.ts
```

Expected: FAIL because build/validation still live in `index-safe-rebuild.ts`.

- [ ] **Step 3: Implement two shared operations, not a lifecycle framework**

In `jina-hnsw-finalization.ts`, add minimal functions equivalent to:

```ts
prepareReopenedJinaHnsw({ spec, selectedFullRepoIds, requireAbsent })
validateReopenedJinaHnsw({ spec, probe })
```

Catalog validation happens before empty-table handling: `requireAbsent` rejects an existing configured index even when every Symbol table/repository check is empty. The prepare result carries:

- `outcome: "created" | "validated-existing" | "skipped-empty"`
- whether catalog mutation occurred
- the deterministic probe used for validation
- `createMs`, `checkpointMs`, and initialized `queryMs`

Use `runHnswRebuildCycle` and existing `createVectorIndex`/`showIndexesStrict`; preserve the current write gate and checkpoint timing. The component must not call `initGraphDb`, `closeLadybugDb`, or safe-family APIs.

For `validated-existing`, call the shared validator on the already cold-reopened connection. For `created`, return the probe so the lifecycle owner can close/reopen before validation.

- [ ] **Step 4: Migrate safe rebuild without changing its lease lifecycle**

In `index-safe-rebuild.ts`:

- Delete `resolveSafeRebuildJinaVectorIndexName`, `runReopenedHnswCanary`, and `validateColdReopenedJinaHnsw` after replacing their call sites.
- Resolve one `ConfiguredJinaHnswSpec` and pass `requireAbsent: true` to the shared prepare function.
- Preserve `closeSafeRebuildBeforeReopen`, `reopenSafeRebuildGraphDb`, the second cold reopen after mutation, and `closeAndPublishSafeRebuildLadybugDb` exactly as lifecycle owners.
- Keep safe candidate validation after HNSW cold validation.
- Update test seams to inject the shared prepare/validate operations, not duplicate implementations.
- Rename output from `Post-reopen Jina HNSW build` to `Post-reopen Jina HNSW finalization` and include the outcome.

- [ ] **Step 5: Rebuild and run safe/finalizer/output tests**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/jina-hnsw-finalization.test.ts tests/unit/provider-first-cli-output.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/safe-rebuild-validation.test.ts tests/integration/semantic-embedding.test.ts
```

Expected: PASS. Existing safe lifecycle event ordering remains unchanged around the shared operations.

- [ ] **Step 6: Commit the shared finalizer**

```powershell
git add src/indexer/jina-hnsw-finalization.ts src/cli/commands/index.ts src/cli/commands/index-safe-rebuild.ts tests/unit/jina-hnsw-finalization.test.ts tests/integration/safe-rebuild-validation.test.ts tests/unit/provider-first-cli-output.test.ts
git commit -m "refactor(index): share reopened jina hnsw finalization"
```

## Chunk 3: Direct command lifecycle, repair, reporting, and docs

### Task 5: Resolve command modes and eligibility before the repository loop

**Files:**

- Modify: `src/cli/commands/index.ts`
- Modify: `src/indexer/index-mode.ts`
- Modify: `tests/unit/cli-index-command.test.ts`
- Modify: `tests/integration/mixed-read-write-setup.test.ts`

- [ ] **Step 1: Write failing eligibility tests**

Cover:

- local one-shot initial repo -> effective full, eligible
- local one-shot `--force` existing repo -> full, eligible
- registered repo with zero indexed files -> upgraded full before eligibility
- local one-shot populated incremental-only selection -> ineligible
- `--watch` -> ineligible
- HTTP-delegated -> ineligible and never opens/closes locally
- semantic/vector disabled or Jina not selected -> ineligible
- mixed full + incremental selection -> one eligible command and global deferral for both repos
- effective-mode pre-resolution failure after DB initialization -> queue state is restored, the opened normal family is closed, and no repository indexing starts

Reuse `resolveEffectiveIndexMode`; if necessary, add only an optional already-open connection/dependency seam so the CLI can resolve all modes without duplicating the zero-file rule. Do not add a second mode resolver.

- [ ] **Step 2: Run tests to prove they fail**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/cli-index-command.test.ts tests/integration/mixed-read-write-setup.test.ts
```

Expected: FAIL because `indexCommand` still derives `directMode` from registration only inside the loop.

- [ ] **Step 3: Pre-resolve modes and create one command-scoped state**

Immediately after local DB/plugin initialization:

- resolve each selected repo's requested mode through `resolveEffectiveIndexMode`
- store a `Map<repoId, effectiveMode>` used for banners, preflight, and `indexRepo`
- resolve the configured Jina spec once
- set eligibility when local + one-shot + spec present + any effective full
- create one monotonic `jinaHnswMayBeAbsent` boolean; its callback only sets `true`
- pass the same `{ spec, deferCreate: true, onMayBeAbsent }` object to every repo when eligible

Put pre-resolution under the command's one-shot cleanup ownership. If any mode probe rejects after initialization, shut down/restore the queue state as applicable, close the opened normal family, report the probe failure, and do not enter the repository loop.

Do not change delegated mode reporting or server behavior. Do not defer incremental-only, watch, or delegated commands.

- [ ] **Step 4: Rebuild and run focused mode/eligibility tests**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit mode planning**

```powershell
git add src/cli/commands/index.ts src/indexer/index-mode.ts tests/unit/cli-index-command.test.ts tests/integration/mixed-read-write-setup.test.ts
git commit -m "feat(cli): plan command-wide jina hnsw deferral"
```

### Task 6: Add the normal-family cold-reopen lifecycle and failure repair

**Files:**

- Modify: `src/cli/commands/index.ts`
- Modify: `tests/unit/cli-index-command.test.ts`
- Modify: `tests/integration/semantic-embedding.test.ts`

- [ ] **Step 1: Add failing lifecycle-order and failure-policy tests**

Expose one internal function from `index.ts` for the direct lifecycle, with injected close/init/prepare/validate dependencies. Test these sequences:

- created: queue shutdown -> strict close -> normal init -> prepare/create/checkpoint -> strict close -> normal init -> validate -> final strict close
- validated-existing: queue shutdown -> strict close -> normal init -> validate -> final strict close, with no second reopen
- skipped-empty: queue shutdown -> strict close -> normal init -> final strict close, with no create/query
- strict close failure -> no subsequent init/reopen and no completion
- partial `initGraphDb` failure with `getLadybugDbPath()` still non-null -> one strict cleanup close, no further reopen, and retained/poisoned ownership diagnostics when cleanup cannot release it
- reopen, checkpoint, create, query validation, or final close failure -> no completion
- multiple repositories -> prepare/create called once
- primary repository error + `may-be-absent=false` -> existing cleanup, no repair reopen
- primary repository error + `may-be-absent=true` -> one repair attempt after strict close; original repository error remains first and any repair/teardown error is secondary

For failure repair, skip selected-full coverage assertions that presume successful indexing, but still require a valid durable global probe before recreating a non-empty global index. Never report repair as command success.

- [ ] **Step 2: Run the CLI lifecycle tests to prove they fail**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/cli-index-command.test.ts
```

Expected: FAIL because direct one-shot cleanup currently closes only once and has no finalizer/repair lifecycle.

- [ ] **Step 3: Implement the direct lifecycle with existing Ladybug primitives**

In the internal lifecycle function:

- call `shutdownDerivedRefreshQueue()` before the first close
- call `closeLadybugDb({ strict: true })`; only set local `dbInitialized=false` after it resolves
- reopen exclusively through `initGraphDb(config, configPath)`
- call shared prepare with selected effective-full repo IDs
- after `created`, strictly close and cold-reopen before shared validation
- for `validated-existing`, validate on the first cold reopen
- for `skipped-empty`, do not query an absent index
- always attempt a final strict close when a reopen succeeded
- if a strict close rejects and `getLadybugDbPath()` remains non-null, report retained ownership at that path; if null, report that native ownership closed but cleanup failed
- never call `initGraphDb` after a failed strict close
- if `initGraphDb` rejects after partially opening the family, inspect `getLadybugDbPath()`; when non-null, attempt one strict cleanup close, attach any cleanup failure, and never attempt another reopen

Keep queue re-enable in a `finally` block. Do not reuse safe-family lease functions on the normal family.

- [ ] **Step 4: Integrate success and repair paths without losing the primary error**

After the repository loop:

- no errors + eligible -> run the full direct finalizer and require success
- errors + eligible + may-be-absent -> run one complete repair lifecycle (strict close -> reopen -> prepare/create -> second strict close/reopen when created -> validate -> final strict close), then still fail the command
- errors without may-be-absent -> retain existing cleanup behavior

Extend the existing error record minimally with secondary diagnostic strings. Print the original indexing error first and indented repair/teardown diagnostics afterward. Avoid an error-management class.

Ensure cleanup is not called twice after a successful strict final close.

- [ ] **Step 5: Add/extend one real disk-backed direct-path test**

Use a temporary normal LadybugDB family and injected no-op repository work to prove the normal close/reopen APIs can create, cold-reopen, and query-validate the configured Jina index. Keep it serial and reuse the real vector-extension setup from `semantic-embedding.test.ts`.

- [ ] **Step 6: Rebuild and run focused lifecycle tests**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/cli-index-command.test.ts tests/unit/jina-hnsw-finalization.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/semantic-embedding.test.ts tests/integration/safe-rebuild-validation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the direct lifecycle**

```powershell
git add src/cli/commands/index.ts tests/unit/cli-index-command.test.ts tests/integration/semantic-embedding.test.ts
git commit -m "feat(cli): finalize jina hnsw after cold reopen"
```

### Task 7: Report command-level timing and synchronize public documentation

**Files:**

- Modify: `src/cli/commands/index.ts`
- Modify: `tests/unit/provider-first-cli-output.test.ts`
- Modify: `docs/cli-reference.md`
- Modify: `docs/troubleshooting.md`
- Review: `docs/configuration-reference.md`

- [ ] **Step 1: Write failing output tests**

Assert exact output for:

```text
Post-reopen Jina HNSW finalization: created | validated-existing | skipped-empty
  jina-embeddings-v2-base-code (<index-name>, efc=<value>)
  create=<ms> query=<ms> checkpoint=<ms>
```

Also prove:

- the command wall timer is captured at the first executable line of `indexCommand`
- the final wall line is printed only after the final strict close
- its outside-phase value subtracts the sum of completed repository `durationMs` values
- eligible direct per-repository output keeps `Duration` but does not print a misleading per-repository wall time
- no completion line is printed on finalization or close failure

- [ ] **Step 2: Run output tests to prove they fail**

```powershell
npm run build
node --experimental-strip-types --test --test-concurrency=1 tests/unit/provider-first-cli-output.test.ts tests/unit/cli-index-command.test.ts
```

Expected: FAIL on old `Post-reopen ... build` wording and per-repository wall timing.

- [ ] **Step 3: Implement command-level timing and output**

- Start `commandWallStartedAt` at `indexCommand` entry before `printBanner`, config load, DB initialization, or plugin setup.
- Sum successful repository `stats.durationMs` values.
- Print the shared finalizer outcome after its final strict close.
- Print one command-level `formatIndexWallTimeLine` after all cleanup/finalization succeeds.
- Preserve delegated HTTP event timing because that lifecycle is server-owned and out of scope.

- [ ] **Step 4: Update public docs**

In `docs/cli-reference.md` and `docs/troubleshooting.md`, document:

- automatic deferral for local one-shot effective-full indexing and safe rebuild
- initial and `--force` coverage
- one global Symbol Jina build after all selected repositories
- strict cold validation and possible `created`, `validated-existing`, `skipped-empty` outcomes
- exclusions: incremental-only, HTTP-delegated, and `--watch`
- configured `semantic.retrieval.vector.efc` is honored by the deferred builder
- Nomic remains inline and is not covered by this optimization

Review `docs/configuration-reference.md`; change it only if its existing `efc` wording is now inaccurate. Do not add benchmark target numbers as product guarantees.

- [ ] **Step 5: Rebuild and run focused output tests**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit reporting and docs**

```powershell
git add src/cli/commands/index.ts tests/unit/provider-first-cli-output.test.ts docs/cli-reference.md docs/troubleshooting.md
git add docs/configuration-reference.md
git commit -m "docs(index): describe cold-reopened jina finalization"
```

If `docs/configuration-reference.md` required no change, omit it from staging.

### Task 8: Run complete verification and prepare the performance experiment

**Files:**

- Verify only; no speculative cleanup.

- [ ] **Step 1: Run focused regression suites**

```powershell
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/jina-hnsw-finalization.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/semantic-pipeline-regressions.test.ts tests/unit/retrieval-index-lifecycle.test.ts tests/unit/cli-index-command.test.ts tests/unit/provider-first-cli-output.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/semantic-embedding.test.ts tests/integration/safe-rebuild-validation.test.ts tests/integration/mixed-read-write-setup.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run static verification**

```powershell
npm run typecheck
npm run lint
npm run docs:tools:check
git diff --check
```

Expected: PASS with no warnings promoted to errors.

- [ ] **Step 3: Run the full suite serially**

```powershell
$env:SDL_TEST_JOBS="1"
npm test
Remove-Item Env:SDL_TEST_JOBS
```

Expected: PASS. If either known baseline test fails, rerun it alone with a fresh temporary DB root and report the distinction; do not edit feature code merely to hide a harness flake.

- [ ] **Step 4: Inspect diff hygiene**

```powershell
git status --short
git diff --stat
git diff --check
git diff --ignore-space-at-eol --exit-code -- tests/fixtures
```

Expected: only intentional source, test, and documentation changes. Restore test-generated fixture rewrites only after proving they are EOL-only.

- [ ] **Step 5: Request code review and address all findings**

Use the `requesting-code-review` skill against the complete branch diff. For LadybugDB-specific lifecycle, query, checkpoint, and HNSW changes, also invoke `ladybug-db-expert`. Apply `receiving-code-review` before acting on findings, then rerun the focused verification affected by each fix.

- [ ] **Step 6: Commit any review fixes**

```powershell
git add <reviewed-files-only>
git commit -m "fix(index): address deferred hnsw review"
```

Skip this commit when review produces no changes.

- [ ] **Step 7: Hand off the two-run performance acceptance experiment**

Ask the operator to run two fresh local one-shot full indexes with the same SDL-MCP repo, config, hardware, and approximately 39k Jina vectors used for the 872–924 second baseline. Each run must target a distinct new LadybugDB family so the second measurement cannot reuse the first run's index or cached database state. Require diagnostics showing:

- no long inline `semanticReadiness.symbolEmbeddings:jina-embeddings-v2-base-code.hnsw.create`
- one command-level `Post-reopen Jina HNSW finalization: created`
- post-reopen create/query/checkpoint timings
- command wall time printed after final close

Compare the median end-to-end wall time to the baseline. A roughly 7–8 minute total and roughly 30 second reopened build are experiment targets only. If reopened creation remains in the hundreds of seconds, mark the lifecycle hypothesis falsified and stop rollout rather than tuning around it.

- [ ] **Step 8: Final implementation commit if needed**

```powershell
git status --short
git log --oneline -8
```

Expected: clean worktree and a small sequence of scoped commits. Do not squash or publish unless the user asks.
