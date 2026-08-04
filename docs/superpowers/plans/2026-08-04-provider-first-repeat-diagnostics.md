# Provider-First Repeat Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain every provider-first full-graph reuse hit or miss, verify unchanged repeat behavior at release scale, and select the first indexing optimization from controlled wall-time evidence.

**Architecture:** Add one deterministic structured log at the existing reuse decision in `indexRepo`. Reuse the existing 2,112-symbol integration fixture for the regression and run disposable same-repository and shared-database benchmark lanes. Do not change reuse, persistence, graph-integrity, or FTS behavior until the benchmark identifies the failing boundary.

**Tech Stack:** TypeScript ESM, `node:test`, LadybugDB, SDL-MCP runtime.

---

## Chunk 1: Reuse-decision diagnostic

### Task 1: Add a failing three-run regression

**Files:**

- Modify: `tests/integration/provider-first-index-repo-fallback.test.ts`
- Test: `tests/integration/provider-first-index-repo-fallback.test.ts`

- [ ] Import the existing structured `logger` from `../../dist/util/logger.js`.
- [ ] Add one test immediately after `skips release-scale shadow staging in the production indexRepo lifecycle`.
- [ ] Initialize the existing release-scale fixture with `RELEASE_SCALE_SYMBOL_COUNT`, complete SCIP input, and semantic work disabled.
- [ ] Temporarily wrap `logger.info` in `try/finally`, forwarding every call with `originalInfo.call(logger, message, metadata)` while capturing only `provider-first full-graph reuse decision`; restore the original method in `finally`.

- [ ] Run `indexRepo(repoId, "full")` three times against the same disposable repository and database.
- [ ] Assert the decision sequence is `false, true, true`.
- [ ] Assert all three events identify the test repository and expose the approved predicate fields.
- [ ] Assert repeat two and repeat three report matching complete input, unchanged files, reused provider rows, no edge rewrite, and full-graph reuse.
- [ ] Assert the final derived state remains `verified`, its digest is a 64-character lowercase hexadecimal value, and its version matches the final result.
- [ ] Run the focused test before production changes:

```powershell
npm run build:runtime
node --experimental-strip-types --test-concurrency=1 --test --test-name-pattern="logs stable reuse decisions" tests/integration/provider-first-index-repo-fallback.test.ts
```

Expected: FAIL because no matching structured events exist.

### Task 2: Emit the minimum deterministic event

**Files:**

- Modify: `src/indexer/indexer.ts`
- Test: `tests/integration/provider-first-index-repo-fallback.test.ts`

- [ ] In the existing provider-first materialization block, name the two sub-predicates already embedded in `activeProviderInputMatches`:
  - `activeProviderInputHashMatches`
  - `activeProviderInputRecordComplete`
- [ ] Preserve the current fail-closed truth table by defining `activeProviderInputMatches` as the conjunction of those booleans.
- [ ] Name `existingProviderFileCount` once and pass it to `resolveProviderFirstActiveMaterializationPlan`; do not change either plan branch.
- [ ] Immediately after `reuseExistingFullGraph` is resolved, emit `logger.info("provider-first full-graph reuse decision", metadata)`.
- [ ] Include exactly the deterministic fields approved by the design: `repoId`, existing and incoming provider counts, active-input availability/match/completeness booleans, unchanged status, row-reuse decision, edge-write decision, and full-graph reuse decision.
- [ ] Leave the early return, active-input persistence, mandatory no-op integrity verifier, 2,048-row boundary, and FTS lifecycle untouched.
- [ ] Build and rerun the focused test:

```powershell
npm run build:runtime
node --experimental-strip-types --test-concurrency=1 --test --test-name-pattern="logs stable reuse decisions" tests/integration/provider-first-index-repo-fallback.test.ts
```

Expected: PASS with `false/true/true`.

- [ ] Commit the diagnostic implementation:

```powershell
git add src/indexer/indexer.ts tests/integration/provider-first-index-repo-fallback.test.ts
git commit -m "perf: expose provider-first reuse decisions"
```

## Chunk 2: Evidence gate

### Task 3: Run the controlled disposable benchmark

**Files:**

- No repository source changes.
- Evidence artifact: `devdocs/benchmarks/provider-first-repeat-2026-08-04/`

- [ ] Build runtime code once before measuring.
- [ ] Run the same-repository lane in a fresh disposable database: one release-scale build followed by two unchanged full refreshes using the same repository ID.
- [ ] Run the shared-database lane in a separate fresh disposable database family: three equivalent release-scale repositories with distinct repository IDs, indexed successively without recreating the database.
- [ ] Keep native-addon, semantic, provider input, and release-scale fixture settings identical across lanes.
- [ ] Persist stdout/stderr, a compact JSON summary, and the exact benchmark driver source under the evidence directory. Record the commands, environment overrides, fixture inputs, repository IDs, and database paths needed to reproduce both lanes; keep the driver artifact-local rather than adding another production benchmark harness.
- [ ] For each run record:
  - total wall time and provider phase timings
  - the structured reuse-decision event
  - Symbol FTS drop/create durations
  - repository and global Symbol counts
  - `count(Symbol)` and `count(DISTINCT symbolId)`
  - graph-integrity state and digest
  - database and WAL sizes
- [ ] Stop if the same-repository decisions are not `false/true/true`; use the captured predicate values to revise the diagnosis.
- [ ] Ask the LadybugDB specialist to review the benchmark artifacts and classify the next bounded change:
  - predicate miss: repair only the failed reuse predicate
  - successful reuse plus fresh-ID FTS growth: design session-scoped FTS deferral
  - unexplained growth: run close/reopen and fresh-database controls before changing code

### Task 4: Verify the diagnostic change

**Files:**

- Modify only documentation that the measured result makes stale.

- [ ] Run the complete provider-first integration file:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/integration/provider-first-index-repo-fallback.test.ts
```

- [ ] Use the `test-scope` skill to select and run the remaining affected tests.
- [ ] Run static checks:

```powershell
npm run typecheck
npm run lint
```

- [ ] Confirm `git diff --check` and review the final diff.
- [ ] Update the design evidence section with the observed lane results and selected next optimization.
- [ ] Do not implement the selected behavior change until its bounded design is reviewed and approved; the current design authorizes diagnostics and measurement only.
