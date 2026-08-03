# LadybugDB 0.19 Resolution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** Eliminate the confirmed LadybugDB 0.18.1 large-scan projection defect without risking the active database, and prevent checkpoints or close from overlapping in-flight native operations.

**Architecture:** Keep the existing single write limiter and per-connection mutexes. Add one process-wide, writer-preferring operation gate at the Ladybug boundary: queries/writes hold shared admission through result materialization and close; checkpoint and database close hold exclusive admission. Disable Ladybug auto-checkpoints, require strict WAL replay, and retain SDL-MCP's bounded scheduled/manual/pre-close checkpoints. Qualify 0.19.0 only against a verified offline DB-family clone with an incident-shaped stress table and repeated checkpoint/reopen cycles.

**Tech Stack:** TypeScript ESM, Node.js AsyncLocalStorage, node:test, LadybugDB Node driver, PowerShell/SDL-MCP runtime.

---

## Task 1: Add the operation gate

**Files:**
- Create: `src/db/ladybug-operation-gate.ts`
- Create: `tests/unit/ladybug-operation-gate.test.ts`

1. Write failing tests for shared concurrency, writer preference, exclusive serialization, nested shared reuse, exclusive-to-shared reuse, shared-to-exclusive rejection, timed-out waiter cleanup, and stale detached AsyncLocalStorage contexts.
2. Run `node --experimental-strip-types --test-concurrency=1 --test tests/unit/ladybug-operation-gate.test.ts` and verify the tests fail because the gate does not exist.
3. Implement the smallest writer-preferring shared/exclusive gate. Use active lease tokens so a root waits for already-started nested work and stale detached contexts reacquire after root closure.
4. Rerun the focused test and verify it passes.
5. Commit: `feat(db): serialize native Ladybug operations`

## Task 2: Integrate checkpoint and lifecycle safety

**Files:**
- Modify: `src/db/ladybug-core.ts`
- Modify: `src/db/ladybug.ts`
- Modify: `tests/integration/background-graph-integrity-snapshot.test.ts`
- Add or modify one focused database lifecycle test if needed.

1. Add failing tests proving:
   - a live native result holds shared admission until `result.close()`;
   - checkpoint waits for a materialized read to finish and later reads do not pass a queued checkpoint;
   - plain `withWriteConn` callbacks between queries, post-index write sessions, and read-only/write transactions hold shared admission through commit or rollback;
   - `Database.close()` cannot overlap a native operation;
   - raw generic `CHECKPOINT` execution is rejected;
   - if a checkpoint caller times out after native execution starts, exclusive admission remains held until native settlement;
   - the driver is created with auto-checkpoint disabled and strict WAL replay enabled;
   - with a deliberately low constructor threshold, no automatic checkpoint occurs before the gated explicit checkpoint.
2. Integrate shared admission at the common query/write boundaries and exclusive admission around checkpoint/close. Acquire the operation lease before the write limiter. Keep the exclusive lease after native checkpoint starts until it settles.
3. Remove or close any unused helper that can return a live native result outside the gate.
4. Run the focused lifecycle/integrity tests and verify they pass.
5. Commit: `fix(db): isolate checkpoints from active operations`

## Task 3: Make the qualification gate reproduce the incident

**Files:**
- Modify: `scripts/qualify-ladybug-driver.mjs`
- Modify: `tests/integration/ladybug-driver-qualification.test.ts`

1. Extend the integration test to require an offline, verified clone; rejection of active aliases; a retained failed clone; and a receipt containing every qualification phase.
2. Expand the disposable probe to at least 24,500 deterministic rows with five STRING projections, mixed lengths, NULLs, non-ASCII values, a numeric sort key, and a 128-dimensional vector.
3. Across fresh child processes, insert multiple batches, checkpoint, reopen, validate the complete ordered scan/digest and sampled point lookups, create/query/drop HNSW, delete an interior range, reopen before reinsertion, reinsert, reopen, then delete all and reopen at zero.
4. At initial build, delete/reopen, reinsert/reopen, and final cleanup, validate the production Symbol graph, manifest, scalar indexes, FTS indexes, and original graph digest are unchanged.
5. Confirm the existing 0.18.1 dependency fails this gate for the scan-projection defect.
6. Commit: `test(db): reproduce large-scan projection corruption`

## Task 4: Adopt LadybugDB 0.19.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

1. Update the existing npm alias to exact `@ladybugdb/core@0.19.0`; add no dependency.
2. Run `npm rebuild kuzu --foreground-scripts`.
3. Run `npm ls kuzu @ladybugdb/core` and the full qualification test. Verify 0.19.0 passes all scan, HNSW, checkpoint, delete/reinsert, reopen, and unchanged-production-graph phases.
4. Commit: `fix(db): qualify LadybugDB 0.19.0`

## Task 5: Document the operational resolution

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/cli-reference.md`

1. Document the confirmed 0.18.1 projection defect and distinguish it from logical graph corruption.
2. State that quarantined/current databases are never upgraded in place; production cutover requires a fresh safe rebuild at a new path.
3. Document the offline clone qualification command, active-path rejection, retained failure artifact, explicit strict WAL replay, and auto-checkpoint policy.
4. Record that the production safe rebuild and atomic path cutover are a separate operator-authorized follow-up gate; code completion does not perform or imply cutover.
5. Commit: `docs: document LadybugDB 0.19 cutover`

## Task 6: Verify and review

1. Run targeted tests first, then `npm run typecheck`, `npm run lint`, `npm run build:all`, and the full project test suite.
2. Run the 0.19.0 qualification gate one final time from a clean build.
3. Request LadybugDB specialist review, spec-compliance review, and code-quality review; fix and re-run checks for every actionable finding.
4. Confirm the worktree is clean and report the branch/commits. Do not modify, migrate, delete, or cut over the active or quarantined database.

## Task 7: Address review findings

**Files:**
- Modify: `src/db/ladybug-lineage.ts`
- Modify: `src/db/ladybug-database-lifecycle.ts`
- Modify: `src/db/ladybug-operation-gate.ts`
- Modify: `src/db/ladybug.ts`
- Modify: `tests/unit/ladybug-lineage.test.ts`
- Modify: `tests/unit/ladybug-lineage-release.test.ts`
- Modify: `tests/unit/ladybug-database-lifecycle.test.ts`
- Modify: `docs/troubleshooting.md`

1. Add a failing stale-lock regression proving acquisition never removes a path after merely observing a dead owner.
2. Add a failing lifecycle regression that holds a shadow callback open, requests global close, and proves close cannot complete before the callback releases and both shadow handles close.
3. Add failing cleanup regressions proving initialization/release failures retain retryable ownership, reject later acquisitions, and surface primary plus cleanup failures.
4. Remove automatic stale-lock unlinking and return an actionable fail-closed error with the exact offline cleanup boundary.
5. Put the complete shadow-database lifetime inside existing exclusive operation admission.
6. Retain one pending lease cleanup, switch path-loss cases to descriptor-only retry, retry it during strict close, and preserve paired errors with `AggregateError`.
7. Retain failed shadow native handles, latch ordinary operation admission closed, and retry them during strict global close.
8. Update changelog/troubleshooting guidance, run the focused tests red then green, and finish with typecheck, lint, build, and the proportionate project test matrix.
