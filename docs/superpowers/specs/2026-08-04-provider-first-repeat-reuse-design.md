# Provider-First Repeat Diagnostics Design

## Problem

Full provider-first indexing grew from 31.6 seconds to 79.7–111.0 seconds. Provider decode-to-materialized time accounts for most of the increase, and Symbol FTS drop/create work occupies 41–54 seconds in representative slow runs. Pass-2 active database writes remain below 1.3 seconds.

The historical slow series does not prove a same-repository reuse defect. Several runs used new worktree repository IDs in one shared database, so they had no active rows to reuse and rebuilt a global Symbol FTS index over an expanding table. Current source also returns from a proven full-graph reuse before it writes the active-input record, which falsifies the earlier self-poisoning theory.

## Chosen approach

Add structured diagnostics at the existing full-graph reuse decision, before any reuse return or provider materialization. Then run controlled disposable benchmarks that separate same-repository repeats from fresh repository IDs in one shared database.

This is the first implementation gate. It changes observability only and preserves every reuse, mutation, graph-integrity, and FTS behavior. The benchmark evidence determines the next design:

- If unchanged same-repository runs miss reuse, repair only the predicate proven to fail.
- If unchanged same-repository runs reuse successfully but fresh repository IDs show growing global FTS cost, design one final Symbol FTS rebuild for an explicit multi-repository rebuild session.
- If growth survives both controls, test close/reopen and fresh-database variants before attributing it to persisted update history or retained native state.

This approach is preferred over two immediate changes:

- A speculative reuse repair is unsafe because the alleged record-truncation path is unreachable on a true reuse hit.
- Immediate FTS deferral expands lifecycle state before the controlled benchmark proves that repeated global FTS rebuilds are the remaining bottleneck.

## Components

### Reuse diagnostics

`src/indexer/indexer.ts` logs one `provider-first full-graph reuse decision` event immediately after it resolves the active materialization plan and `reuseExistingFullGraph`, before the early reuse return.

The event contains only deterministic values for the current run:

- `repoId`
- `existingProviderFileCount`
- `existingProviderSymbolCount`
- `incomingProviderSymbolCount`
- `activeProviderInputHashAvailable`
- `activeProviderInputRecordAvailable`
- `activeProviderInputHashMatches`
- `activeProviderInputRecordComplete`
- `activeProviderInputMatches`
- `allFilesUnchanged`
- `reuseExistingProviderRows`
- `writeEdges`
- `reuseExistingFullGraph`

Existing provider phase timings and FTS lifecycle logs remain the timing source. The change adds no absolute paths, timestamps, generated IDs, tool-output fields, or public response keys.

### Diagnostic regression

Extend the existing release-scale provider-first integration fixture, which creates 2,112 Symbols and exercises the large-graph safety path. Capture the structured decision while running the same full index three times.

The test fails before production code changes because the diagnostic event does not exist. After the logging change, the expected decision sequence for an unchanged input is `reuseExistingFullGraph=false/true/true`. If the observed sequence differs, stop and use the captured predicate values to revise the diagnosis before changing reuse behavior.

The regression also confirms that existing no-op integrity verification still runs. It does not alter the 2,048-row boundary, COPY restrictions, materialization policy, active-input record, or early-return control flow.

## Benchmark gate

Run two disposable lanes, each from its own fresh database family:

1. **Same repository:** run one initial build, then two unchanged full refreshes with the same repository ID.
2. **Shared database growth:** run equivalent fresh repository IDs successively in one process and one database.

Capture for every run:

- reuse-decision fields
- provider phase timings
- Symbol FTS drop/create lines
- total index duration
- repository and global Symbol counts
- `count(Symbol)` versus `count(DISTINCT symbolId)`
- graph-integrity state and digest
- database and WAL sizes

Interpret the results conservatively:

- `false/true/true` with no later materialization confirms same-repository reuse works.
- Reuse predicate failures identify the exact bounded repair.
- Increasing fresh-ID FTS time with stable per-repository work justifies a separate session-scoped FTS-deferral design.
- Growth that survives close/reopen but disappears on a fresh database supports persisted update/index history; database size alone does not.

## Safety

- The diagnostic change performs no additional database writes.
- A missing, truncated, mismatched, or changed input remains fail-closed.
- The mandatory no-op integrity verifier remains on the reuse path.
- The 2,048-row mutation boundary and large COPY prohibition remain unchanged.
- Benchmarks use disposable database families and never open or modify the active database.

## Acceptance criteria

- One deterministic structured log explains every full-graph reuse hit or miss.
- The log executes before both the reuse return and provider materialization.
- Focused coverage observes the release-scale three-run decision sequence without changing production behavior.
- The disposable benchmark distinguishes same-repository reuse from shared-database fresh-ID growth.
- The next optimization is selected from benchmark evidence rather than the falsified truncation theory.
- Focused provider-first tests, typecheck, lint, and the scoped test matrix pass.
