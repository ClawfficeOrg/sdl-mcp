# Local Full-Index Deferred Jina HNSW Design

**Status:** Approved design  
**Date:** 2026-08-06

## Problem

A fresh full index of the SDL-MCP repository spends several minutes after Jina embedding inference building the Symbol HNSW index. Recent diagnostics attributed roughly 478–514 seconds of an 872–924 second index to inline `CREATE_VECTOR_INDEX`, while a cold-reopened disposable database built the same index in roughly 30 seconds.

SDL-MCP now defers Jina HNSW creation across a close/reopen boundary during safe rebuilds. Ordinary locally owned full indexing still creates HNSW inside the long-lived indexing session, so the original initial-index wall-time problem remains unchanged.

## Goals

- Apply cold-reopened Jina HNSW creation automatically to every locally owned, one-shot full index.
- Cover both an initial index and `--force` against an existing database without adding a CLI flag.
- Build the global Symbol Jina index once per command, including commands that index multiple repositories.
- Use one configured Jina index specification for the drop, create, and validation paths.
- Fail closed unless the cold-reopened index is healthy and queryable.
- Report end-to-end wall time after HNSW creation and cold validation.

## Non-goals

- Do not change incremental indexing.
- Do not close/reopen a database owned by an HTTP server.
- Do not change `--watch` indexing, which has live queues and watchers.
- Do not tune LadybugDB, embedding inference, persistence batching, or `efc` in this change.
- Do not add a second HNSW implementation or a finalizer subprocess.

## Eligibility

The CLI enables deferred Jina finalization only when all of these conditions hold:

- The CLI owns the LadybugDB instance locally rather than delegating to an HTTP server.
- The invocation is one-shot (`--watch` is absent).
- At least one selected repository resolves to effective `full` mode because `--force` is present, registration is absent, or the registered repository has no indexed files.
- Semantic retrieval enables Jina Symbol embeddings and vector search.

If one repository makes the command eligible, the CLI passes the deferral option to every repository indexed by that command. This prevents a later incremental companion repository from recreating the global Symbol index before the command-level finalizer runs.

## Architecture

The direct CLI path owns orchestration. `indexRepo` continues to own repository indexing and vector persistence, while a shared reopened-HNSW component owns Jina index creation and validation.

One shared effective-mode resolver examines registration and indexed-file state. The CLI uses it to decide command-level eligibility, and `indexRepo` uses the same result instead of independently upgrading an incremental request later.

One shared configured Jina specification contains the model, index name, vector property, dimension, and `efc`. The CLI passes this specification through `indexRepo`, semantic readiness, and embedding refresh so the bulk drop and reopened create always target the same catalog object. The finalizer resolves no second default name.

The implementation extracts only the safe-rebuild builder and cold validator into a shared component. Safe rebuild retains its family lease and stricter requirement that the configured Jina index must be absent after the first reopen. Direct full indexing uses the normal LadybugDB family lifecycle and accepts either an absent index, which it builds, or an already healthy configured index when no bulk refresh dropped it.

The CLI follows this sequence:

1. Resolve all selected repository modes with the shared effective-mode resolver and decide command-level eligibility.
2. Run repository indexing with Jina HNSW creation deferred for the entire eligible command.
3. Finish all foreground writes and stop the one-shot derived refresh queue.
4. Strictly close the normal LadybugDB family.
5. Reopen it through normal `initGraphDb` initialization and inspect the configured Jina index and persisted vectors.
6. Require at least one valid persisted Jina vector for every non-empty selected full repository.
7. Create the global index once when absent, using the shared configured specification, then checkpoint.
8. When creation mutated the catalog, strictly close and cold-reopen through normal initialization again.
9. Validate the healthy index and a logical-Symbol near-zero-neighbor canary.
10. Strictly close the normal family, print final diagnostics, and report command success.

The existing connection operation gate and single write connection continue to serialize index creation and checkpoints. No reader or watcher remains active during either close boundary. Any queue shutdown, strict close, reopen, checkpoint, validation, or final close failure prevents success.

## Existing-Index Behavior

Bulk Symbol embedding refresh already drops an existing HNSW index before updating enough vectors to cross the rebuild threshold. The refresh must use the shared configured Jina specification rather than the model-mapping default. The deferral option leaves that exact index absent until command-level finalization.

When a forced full run reuses all cached Jina vectors and leaves a healthy configured index installed, finalization validates the existing index instead of rebuilding it. An index with the configured name but the wrong table, property, type, or unhealthy state causes a failure rather than an automatic destructive replacement.

## Multiple Repositories

The Jina HNSW index covers the global `Symbol` table, not one repository. The CLI therefore defers creation across the complete repository loop and creates the index once after all selected repositories finish.

Repository phase timings remain attached to their corresponding `IndexResult`. The CLI adds one command-level reopened-HNSW result and one command-level wall duration rather than attributing the shared finalization cost to an arbitrary repository.

Before building the global index, the finalizer checks each selected non-empty full repository independently for a valid Jina vector. A valid vector from an older or companion repository cannot conceal missing vectors in a newly full-indexed repository.

## Failure Handling

A successful indexing phase does not imply command success. The command succeeds only after the applicable cold validation and final strict close.

The embedding path reports whether command-level deferral dropped the configured index or confirmed it absent. It updates an immediate command-scoped callback as soon as that catalog result is known, before vector persistence or later work can throw. The CLI aggregates this state monotonically across repositories: once any callback reports `may-be-absent`, no later `not-needed` result can clear it. This callback remains available even when `indexRepo` throws without returning an `IndexResult`.

The CLI preserves the current continue-and-aggregate behavior when one repository fails. It attempts the remaining selected repositories and retains existing cleanup for commands that did not enable deferral. Only an eligible deferred command in the `may-be-absent` state stops derived work, attempts a strict close, and then attempts one global reopened HNSW repair from durably persisted valid vectors.

The first indexing failure remains primary. Repair and teardown failures are attached as secondary diagnostics. The command never prints completion after any indexing, repair, reopen, validation, or teardown failure.

Cleanup attempts a strict close and never intentionally reopens after a close failure. Because native teardown can fail while ownership remains retained or poisoned, diagnostics report the actual retained ownership state rather than claiming LadybugDB is closed.

An empty Symbol table may skip HNSW creation. A successful non-empty full index with no valid Jina vectors fails closed. The direct path retains the database family for diagnosis and does not claim completion.

## Diagnostics and Output

Inline indexing timings must no longer contain a long `semanticReadiness.symbolEmbeddings:jina-embeddings-v2-base-code.hnsw.create` phase for an eligible command. The CLI reports the shared finalizer outcome separately:

```text
Post-reopen Jina HNSW finalization: created | validated-existing | skipped-empty
  jina-embeddings-v2-base-code (<index-name>, efc=<value>)
  create=<ms> query=<ms> checkpoint=<ms>
```

`created` means the finalizer created and cold-validated the index. `validated-existing` means the first cold reopen found the configured index healthy and queryable without mutation. `skipped-empty` is valid only when every selected full repository and the global Symbol table are empty.

The command-level wall timer starts at `indexCommand` entry, before database initialization and plugin setup, and stops after the final strict close. Output keeps repository phase durations separate and clearly identifies time outside those phases, including setup, SCIP generation, and reopened HNSW finalization.

Progress text changes from the safe-rebuild-specific message to `deferred until cold reopen` so the same embedding path accurately describes both callers.

The canary deterministically selects a valid Jina vector by repository ID and logical Symbol ID. It queries the configured index with `k=10` and `efs=200`, returns `node.symbolId` and `distance`, and accepts any returned non-empty logical ID with a finite absolute distance no greater than `1e-6`. The validator resolves the accepted ID back to its persisted Symbol vector and requires that vector to match the probe within the same cosine tolerance. This contract remains valid when more than ten symbols share an identical vector.

## Testing

Focused tests cover:

- The eligibility matrix: local full and initial indexing enable deferral; incremental, HTTP-delegated, and watch paths do not.
- A registered repository with zero indexed files resolves to full mode before command-level eligibility.
- Mixed repository modes defer globally and run one finalizer.
- Fresh databases build after the first reopen and validate after the second reopen.
- Forced full runs drop and rebuild an existing Jina index once.
- Fully cached forced runs validate a healthy existing index without rebuilding it.
- The configured Jina specification reaches the bulk drop, builder, and validator without falling back to a different name.
- A non-empty selected full repository with no valid Jina vector fails even when another repository has valid vectors.
- Wrong-property, unhealthy, missing-vector, create, checkpoint, reopen, and query failures prevent success.
- Repository failure preserves its primary error while attempting index repair.
- Failure repair runs only when eligible deferral reported that the configured index may be absent; other failures retain existing cleanup.
- Strict-close failure reports retained or poisoned ownership and does not trigger another reopen.
- CLI outcomes distinguish `created`, `validated-existing`, and `skipped-empty`, and wall-time ordering includes the final strict close.
- A disk-backed vector-extension test resolves a returned logical Symbol whose persisted vector matches the deterministic probe within `1e-6` distance after a real cold reopen, including more than ten tied vectors.

Verification runs the affected unit and integration suites, `npm run build:all`, `npm run typecheck`, production lint, and diff hygiene checks.

## Performance Acceptance

The implementation experiment uses the same SDL-MCP repository, configuration, hardware, and Jina vector count as the established baseline. Diagnostics must prove that inline HNSW creation is absent and that post-reopen creation owns the measured HNSW cost.

Run at least two fresh full indexes and compare their median end-to-end wall time with the prior 872–924 second range. The observed disposable result suggests a post-reopen creation time near 30 seconds and a total wall time near 7–8 minutes, but these values are an experiment target rather than a product invariant. If post-reopen creation remains in the hundreds of seconds, treat the lifecycle hypothesis as falsified and stop further rollout.

## Documentation

Update the indexing troubleshooting section to state that local one-shot full indexes and safe rebuilds defer Jina HNSW creation across a cold reopen. Document that incremental, delegated HTTP, and watch indexing retain their existing lifecycle.
