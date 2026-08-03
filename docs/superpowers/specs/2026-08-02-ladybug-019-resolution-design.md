# LadybugDB 0.19 Resolution Design

## Problem

LadybugDB 0.18.1 can return incoherent STRING values during persisted multi-segment scans. SDL-MCP's integrity verifier correctly treats those results as a graph mismatch and fails closed, but the false mismatch leaves a healthy source tree read-only. The old quarantined database family also has a base/WAL identity mismatch and must not be repaired or reopened in place.

## Chosen approach

Adopt LadybugDB 0.19.0 only behind an executable qualification gate that reproduces the incident shape. Disable engine-managed automatic checkpoints and run explicit checkpoints only after SDL-MCP has blocked new database operations and drained active ones. Production adoption uses a fresh safe rebuild on a new path; neither the quarantined family nor the current 0.18.1 database is upgraded in place.

This is preferred over two alternatives:

- Keeping 0.18.1 and replacing scans with point lookups would spread a driver workaround throughout graph code and would not address the separate multi-column result-lifetime risk.
- Upgrading without qualification would fix the known filtered-segment defect but leave Windows `getAll()`, FTS/HNSW, WAL replay, and checkpoint concurrency unproven.

## Components

### Driver qualification

Extend `scripts/qualify-ladybug-driver.mjs` so every candidate runs in fresh processes against a verified disposable database-family clone. In addition to the existing graph digest checks, the clone will:

1. Create at least 24,500 deterministic rows over multiple batches containing five projected STRING columns, mixed string lengths, NULLs, non-ASCII UTF-8, a numeric sort key, and a 128-element numeric vector.
2. Checkpoint and reopen between insertion batches so the probe occupies genuinely distinct persisted segments.
3. Validate the complete ordered `queryAll()/getAll()` projection byte-for-byte against deterministic expected values and sampled primary-key lookups. Create an HNSW index on the probe vector, query a known nearest neighbor after each persisted boundary, and drop the index before final cleanup.
4. Delete a bounded interior segment, checkpoint, close, and validate from a fresh process before any reinsertion.
5. Reinsert the deleted segment, checkpoint, close, and validate again from a fresh process.
6. Delete all probe rows, checkpoint, close, and confirm from a final fresh process that none remain.
7. Require the SDL Symbol graph validation and digest to remain unchanged through every phase.

Any mismatch retains the disposable clone for diagnosis and rejects the candidate. Qualification proves only the clone; production cutover still requires a new-path safe rebuild, explicit checkpoint, strict close, fresh-process reopen, graph/manifest/index validation, and atomic cutover.

The qualifier requires the offline source family to remain byte-identical. It denies aliases to active database families and never opens the active path; active bytes are not fingerprinted because a running watcher can legitimately change them.

### Database-operation and checkpoint quiescence

Add one writer-preferring process-local shared/exclusive database-operation gate at the existing Ladybug boundary. The global acquisition order is:

1. Database-operation lease.
2. Serialized write limiter, when needed.
3. Per-connection query mutex.

Normal result-producing queries hold a shared lease through native execution, complete result materialization or iteration, and `result.close()`. `withWriteConn`, post-index write sessions, read-only transactions, and write transactions hold one shared lease across their entire callback/lifetime, so checkpoint cannot split a transaction or take the writer first.

A manual checkpoint acquires exclusive operation admission first, blocks later readers and writers, drains active leases, then acquires the serialized write connection and executes `CHECKPOINT`. Nested behavior is explicit:

- Shared inside shared reuses the shared lease.
- Shared inside exclusive reuses exclusive admission.
- Exclusive inside exclusive reuses exclusive admission.
- Exclusive requested from shared throws a typed error instead of upgrading or deadlocking.

Each `AsyncLocalStorage` context carries an active lease token. Nested work increments the token's in-flight count, and the root lease does not release until already-started nested work settles. Once the root callback starts closing, later detached work cannot reuse the stale context and must reacquire admission. A regression test covers a fire-and-forget task inherited from a released lease.

Queued exclusive admission supports a bounded wait. A timeout while queued removes the waiter and reopens admission when appropriate. Once native `CHECKPOINT` begins, exclusivity remains held until its promise settles even if the original caller no longer waits.

`Database.close()` also runs under exclusive admission because Ladybug may checkpoint during close. Generic query helpers must not execute raw `CHECKPOINT`; production checkpoints route through the gated function.

### Database configuration

Open LadybugDB with:

- `autoCheckpoint=false`.
- `throwOnWalReplayFailure=true` explicitly, because 0.19 changes the default toward lenient torn-tail handling.
- Existing checksum and compression behavior unchanged.

Strict WAL replay applies to production, qualification children, safe-rebuild validation, and recovery tools. Bounded scheduled and pre-close checkpoints remain so disabling automatic checkpoints cannot permit unbounded WAL growth.

### Dependency and operations

Pin `kuzu` to `npm:@ladybugdb/core@0.19.0`. Keep the old database quarantine, safe-rebuild cutover, and fail-closed graph-integrity admission unchanged.

## Error handling

- Qualification failures include the failed phase and retain the clone path.
- Checkpoint queue timeout/failure remains best-effort and returns `false`; an already-started native checkpoint keeps exclusive ownership until settled.
- A checkpoint requested from shared transaction/write context fails immediately with a typed error.
- Query and transaction errors preserve their existing typed error and rollback behavior.

## Verification

- Red/green integration test showing the incident-shaped 0.18.1 STRING scan fails and the 0.19.0 candidate passes.
- Unit tests for writer preference, shared/exclusive nesting, illegal shared-to-exclusive upgrade, queued-timeout cleanup, and nested query reuse.
- Integration tests proving an active result delivery, held read-only transaction, held write transaction/session, and shutdown all serialize correctly with checkpoint.
- Runtime assertion that a deliberately low threshold does not auto-checkpoint before the explicit gated checkpoint.
- Driver qualification against a disposable safe-rebuild database.
- Focused tests, typecheck, lint, build, then the full project test suite.

## Acceptance criteria

- The deterministic large STRING scan returns exactly the expected rows and digest at initial persisted build, post-delete reopen, post-reinsert reopen, and post-final-delete reopen.
- No checkpoint or database close overlaps an SDL-managed query, result delivery, write callback, or transaction.
- Automatic checkpoints are disabled and strict WAL replay is explicit.
- The original offline source family remains byte-identical and active-family aliases are rejected.
- Production cutover uses a fresh 0.19.0 safe rebuild on a new path.
- SDL-MCP remains fail-closed when a real qualification or graph-integrity mismatch occurs.

## Post-review safety remediation

The implementation review found three remaining process-lifetime races. They are resolved at the existing lineage and operation-gate boundaries:

1. Stale family locks are no longer deleted automatically. Even after confirming that the recorded PID is dead, a path-based unlink can delete a replacement lock created by another process. Acquisition therefore fails closed with the exact lock path and instructions to stop all SDL-MCP processes before removing that lock offline.
2. A shadow database holds exclusive operation admission for its complete lifetime: construction, callback execution, checkpoint, connection close, and database close. Global shutdown waits for that lifetime instead of closing the gate while shadow handles are still live. If a native close rejects, SDL-MCP retains that handle, latches ordinary operation admission closed, and retries it during strict global close.
3. A lease that cannot be initialized or released remains owned by one process-local pending-cleanup slot. New acquisitions fail while cleanup is pending, strict close retries it, and a failure during error cleanup is reported with the primary failure in an `AggregateError`. If the lock path disappears or is replaced, cleanup permanently detaches from that path and retries only the retained descriptor, never the foreign path.

The single pending-cleanup slot is sufficient because SDL-MCP permits only one live family lease in a process. This avoids a second lease manager while preserving retryable ownership of the native descriptor and its recorded file identity.

### Remediation acceptance criteria

- Two processes cannot both reclaim a stale path or delete a replacement owner's lock.
- Global close cannot complete while a shadow database callback or its native handles remain active; a failed shadow close fences ordinary work until strict-close retry succeeds.
- Failed lease initialization or release cannot silently discard the last cleanup handle.
- Strict close retries pending cleanup, ownership-loss retry never touches a replacement lock path, and both primary and cleanup failures remain observable.
