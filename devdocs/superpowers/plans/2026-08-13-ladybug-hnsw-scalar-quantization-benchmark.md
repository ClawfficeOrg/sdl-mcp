# LadybugDB HNSW Scalar Quantization Benchmark Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a read-only-source, disposable-database benchmark that compares LadybugDB 0.19.0 full-precision, SQ8, and SQ16 HNSW indexes on SDL-MCP's real Jina vectors and emits one gate-driven recommendation.

**Architecture:** Preserve the existing EFC benchmark as the command entry point, but add a fixed `--quantization` experiment mode. Keep LadybugDB DDL construction in a small pure production module, benchmark math/decision logic in a pure script module, and evidence/cleanup logic in a second script module. The orchestration script creates one validated immutable snapshot, derives one disposable family per candidate and repetition, hands each family between one direct LadybugDB owner and one isolated context-quality child process, then writes atomic evidence before validated cleanup.

**Tech Stack:** TypeScript ESM, Node.js 24 built-in test runner, LadybugDB `@ladybugdb/core@0.19.0`, existing Ladybug family-copy and context-quality benchmark infrastructure, PowerShell/SDL-MCP runtime execution.

**Specification:** `devdocs/superpowers/specs/2026-08-13-ladybug-hnsw-scalar-quantization-benchmark-design.md`

---

## Execution prerequisites

- Execute in an isolated `codex/hnsw-scalar-quantization-benchmark` worktree created with `@using-git-worktrees`.
- Use `@subagent-driven-development`: one fresh implementation agent per task, followed by spec-compliance and code-quality review.
- Use `@test-driven-development` for every behavior change and record the observed RED failure before implementation.
- Use `@verification-before-completion` before each commit and before reporting benchmark results.
- Invoke `ladybug-db-expert` for Tasks 2, 3, 6, 8, and 11.
- Do not alter production vector configuration, defaults, the active graph, `efc`, `efs`, embedding generation, checkpoint behavior, or release metadata.
- Run repository commands through SDL-MCP `runtimeExecute` with persisted output and explicit timeouts.
- Stop without a recommendation if the source graph is not `graphIntegrityState: "verified"`, the driver smoke test fails, source validation fails, a candidate is incomplete, or evidence is not durable.

## File map

- Create `src/retrieval/index-identifier.ts` — shared pure identifier validator moved from `index-lifecycle.ts`.
- Create `src/retrieval/vector-index-definition.ts` — pure closed-enum validation and deterministic `CREATE_VECTOR_INDEX` statement construction.
- Modify `src/retrieval/index-lifecycle.ts` — delegate vector DDL construction to the pure module; preserve all existing callers and defaults.
- Create `tests/unit/vector-index-definition.test.ts` — executable contract tests for full/SQ8/SQ16/rerank SQL and invalid combinations.
- Create `tests/integration/vector-index-quantization.test.ts` — real-driver compatibility smoke coverage.
- Create `scripts/hnsw-quantization-model.ts` — pure candidates, corpus validation/hash, sampling, recall/NDCG, gates, and recommendation.
- Create `scripts/hnsw-quantization-evidence.ts` — versioned complete/incomplete schemas, atomic persistence, family sizing, and safe cleanup checks.
- Modify `scripts/benchmark-hnsw-efc.ts` — retain legacy EFC mode; add quantization orchestration, clone ownership handoff, ANN queries, and context-quality child execution.
- Modify `tests/unit/hnsw-efc-benchmark.test.ts` — quantization CLI and orchestration source-contract coverage.
- Create `tests/unit/hnsw-quantization-model.test.ts` — pure measurement and decision tests.
- Create `tests/unit/hnsw-quantization-evidence.test.ts` — atomic artifact and cleanup tests.
- Modify `docs/troubleshooting.md` — operator command, safety, duration, metrics, gates, and failure recovery.
- Create ignored evidence at `.benchmark/hnsw-quantization-2026-08-13.json` during the real run; never commit it.

## Chunk 1: Closed LadybugDB index-definition contract

### Task 1: Add a pure, closed HNSW definition builder

**Files:**
- Create: `src/retrieval/index-identifier.ts`
- Create: `src/retrieval/vector-index-definition.ts`
- Modify: `src/retrieval/index-lifecycle.ts:110-125`
- Modify: `tests/unit/retrieval-index-lifecycle.test.ts`
- Create: `tests/unit/vector-index-definition.test.ts`

- [ ] **Step 1: Write failing exact-SQL and validation tests**

Assert complete string equality for all five statements: full precision, SQ8, SQ8 plus rerank, SQ16, and SQ16 plus rerank. Use the exact common prefix:

~~~typescript
const prefix =
  "CALL CREATE_VECTOR_INDEX('Symbol', 'symbol_vec_jina_code_v2', 'embeddingJinaCodeVec', metric := 'cosine', efc := 200";
~~~

Expected suffixes are `)`, `, quantization := 'sq8')`, `, quantization := 'sq8', use_full_precision_rerank := true)`, and the corresponding SQ16 strings.

Test runtime rejection of:

- rerank `true` without quantization
- an explicitly present rerank `false` without quantization
- unknown quantization such as `sq4`
- non-boolean rerank such as `"yes"`
- invalid identifiers
- non-positive, non-integer, and non-finite `efc`

Add source-contract assertions that `index-lifecycle.ts` imports `validateIndexIdentifier` and no longer declares its own validator.

- [ ] **Step 2: Run focused tests and verify RED**

~~~powershell
node --experimental-strip-types --test tests/unit/vector-index-definition.test.ts tests/unit/retrieval-index-lifecycle.test.ts
~~~

Expected: FAIL because the pure modules/shared validator import do not exist.

- [ ] **Step 3: Move the existing identifier validator without changing behavior**

Move the current private regex and throwing behavior verbatim from `index-lifecycle.ts` into `index-identifier.ts` as `validateIndexIdentifier`. Import it with `.js` back into `index-lifecycle.ts`. Do not duplicate the regex. Existing FTS/vector create/drop paths must keep using the shared helper.

- [ ] **Step 4: Implement the minimal statement builder**

Export `HnswScalarQuantization = "sq8" | "sq16"` and `VectorIndexBuildOptions`. Call the shared validator for all identifiers. Validate `efc` and every runtime option. If the rerank property is present, require a boolean and quantization even when false. Append named arguments in fixed order. Omit quantization/rerank entirely for the exact legacy SQL. Comment why validated literals are necessary for this stored procedure.

- [ ] **Step 5: Rerun Step 2 and verify GREEN**

- [ ] **Step 6: Run `npm run typecheck` and `npm run lint`**

- [ ] **Step 7: Commit**

~~~powershell
git add src/retrieval/index-identifier.ts src/retrieval/vector-index-definition.ts src/retrieval/index-lifecycle.ts tests/unit/vector-index-definition.test.ts tests/unit/retrieval-index-lifecycle.test.ts
git commit -m "feat(retrieval): define scalar HNSW builds"
~~~

### Task 2: Wire the builder into the production helper without enabling it

**Files:**
- Modify: `src/retrieval/index-lifecycle.ts:314-349`
- Modify: `tests/unit/retrieval-index-lifecycle.test.ts:469-520`

- [ ] **Step 1: Add failing source-contract tests**

Require `createVectorIndex` to accept a final optional `VectorIndexBuildOptions`, call `buildCreateVectorIndexStatement`, and keep every existing call valid without options.

- [ ] **Step 2: Run focused tests and verify RED**

~~~powershell
node --experimental-strip-types --test tests/unit/vector-index-definition.test.ts tests/unit/retrieval-index-lifecycle.test.ts
~~~

- [ ] **Step 3: Implement minimal wiring**

~~~typescript
export async function createVectorIndex(
  conn: Connection,
  tableName: string,
  propertyName: string,
  indexName: string,
  dimension: number,
  efc: number = 200,
  options: VectorIndexBuildOptions = {},
): Promise<boolean>
~~~

Import with `.js`, delegate SQL construction, and preserve `try/catch`, boolean returns, shared identifier safety, logging, and all existing callers. Add only bounded log fields.

- [ ] **Step 4: Rerun tests and require PASS**

- [ ] **Step 5: Run `npm run typecheck` and `npm run lint`**

- [ ] **Step 6: Request LadybugDB specialist review; fix important findings and rerun Steps 4-5**

- [ ] **Step 7: Commit**

~~~powershell
git add src/retrieval/index-lifecycle.ts tests/unit/retrieval-index-lifecycle.test.ts
git commit -m "feat(retrieval): pass scalar HNSW options"
~~~

### Task 3: Prove installed-driver SQ8/SQ16 compatibility

**Files:**
- Create: `tests/integration/vector-index-quantization.test.ts`

- [ ] **Step 1: Write the real-driver compatibility smoke test**

Follow `tests/integration/semantic-embedding.test.ts`. For SQ8/SQ16 with rerank off/on, create a fresh database, load at least 64 deterministic 8-dimensional vectors, build through production `createVectorIndex`, query with explicit `efs`, and strictly close.

Then reopen, `LOAD vector`, and query:

~~~cypher
CALL SHOW_INDEXES()
RETURN table_name, index_name, index_type, extension_loaded, index_definition
~~~

Filter by exact table/index/type. Require `extension_loaded === true`. Require `index_definition` to contain the expected `quantization := 'sq8'|'sq16'` and require the rerank token only for rerank-on. Its absence proves persisted false. Run a real `QUERY_VECTOR_INDEX` after reopen, then drop and strictly close. Retain/report the family on any close or cleanup failure.

- [ ] **Step 2: Build and run the authoritative compatibility gate**

~~~powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/integration/vector-index-quantization.test.ts
~~~

Expected after Tasks 1-2: GREEN for all four definitions. This is a post-implementation compatibility gate, not a contrived RED phase. Public docs do not yet enumerate these 0.19 arguments, so installed behavior is authoritative.

If installed 0.19 disproves assumed SQL, correct `vector-index-definition.ts` and all five exact-SQL tests together. Do not make a fixture-only workaround or add fallback syntax.

- [ ] **Step 3: Rerun Step 2 after any evidence-backed correction and require all four cases PASS**

- [ ] **Step 4: Request LadybugDB review and commit**

~~~powershell
git add src/retrieval/vector-index-definition.ts tests/unit/vector-index-definition.test.ts tests/integration/vector-index-quantization.test.ts
git commit -m "test(db): qualify scalar HNSW definitions"
~~~

## Chunk 2: Deterministic benchmark model and orchestration

### Task 4: Implement candidates, corpus identity, metrics, and recommendation

**Files:**
- Create: `scripts/hnsw-quantization-model.ts`
- Create: `tests/unit/hnsw-quantization-model.test.ts`

- [ ] **Step 1: Write failing candidate-order tests**

Assert exact forward and reverse orders using IDs `full`, `sq8`, `sq8-rerank`, `sq16`, `sq16-rerank`.

- [ ] **Step 2: Run and verify RED**

~~~powershell
node --experimental-strip-types --test tests/unit/hnsw-quantization-model.test.ts
~~~

- [ ] **Step 3: Implement readonly candidate definitions and repetition order**

- [ ] **Step 4: Write failing corpus tests**

Cover null count/exclusion; duplicate/empty IDs; wrong dimension; non-finite component; zero norm; exactly 200 deterministic sampled IDs; and SHA-256 sensitivity to one changed bit. Define stream version 1 bytes as ASCII `SDL-HNSW-CORPUS\0V1\0`; encode UInt32LE ID length, UTF-8 ID bytes, UInt32LE dimension, and Float64LE components. The production stream requires strictly increasing `Buffer.compare(Buffer.from(id, "utf8"))` order and rejects non-monotonic IDs across page boundaries. Add a hard-coded golden digest for a two-row corpus containing a multibyte UTF-8 ID and known values, assert exact encoded bytes, and prove identical digest and top-200 sample across different page chunking of the same canonical stream. Return and test only `{ algorithm: "sha256", streamVersion: 1, digest }`; evidence inclusion belongs to Task 8.

- [ ] **Step 5: Run RED, implement minimal corpus functions, rerun GREEN**

Require at least 200 valid vectors.

- [ ] **Step 6: Write failing metric and gate tests**

Cover recall@10; specified NDCG; exact `0.005` paired boundary; pooled-summary non-eligibility; latency's joint `>10%` and `>2ms` gate; static and paired named cases; rerank selection; 10-percent build/size bands; SQ16 tie preference; selected-rerank two-build median; and incomplete fallback.

- [ ] **Step 7: Run RED, implement decision functions, rerun GREEN**

Return structured eligibility, rejected gates, winner/rerank state, and reasons. Incomplete input yields no adoption choice.

- [ ] **Step 8: Run script typecheck and commit**

~~~powershell
npm run typecheck:scripts
git add scripts/hnsw-quantization-model.ts tests/unit/hnsw-quantization-model.test.ts
git commit -m "feat(benchmark): model HNSW quantization gates"
~~~

### Task 5: Add a fixed quantization CLI mode while preserving EFC mode

**Files:**
- Modify: `scripts/benchmark-hnsw-efc.ts:11-106`
- Modify: `tests/unit/hnsw-efc-benchmark.test.ts:13-105`

- [ ] **Step 1: Write failing parser tests**

Command:

~~~powershell
npm run bench:hnsw-efc -- --quantization --source <absolute-source.lbug> --load-mode clone --output <absolute-artifact.json>
~~~

Require clone mode, fixed `efc=200`, `efs=200`, `k=10`, and 200 queries. Before opening Ladybug, canonicalize the source database directory and output parent using Windows case-insensitive normalized path identity; reject an existing output and any output inside the active database directory, including a non-family sibling, `..` alias, separator variant, and case-only alias. Prove these boundaries and unchanged legacy parsing.

- [ ] **Step 2: Run benchmark unit test and verify RED**

- [ ] **Step 3: Implement a discriminated option union**

Keep `HnswBenchmarkOptions` and `runHnswEfcBenchmark` unchanged; branch to new `HnswQuantizationBenchmarkOptions` and runner.

- [ ] **Step 4: Rerun and verify GREEN**

~~~powershell
node --experimental-strip-types --test tests/unit/hnsw-efc-benchmark.test.ts
npm run typecheck:scripts
~~~

- [ ] **Step 5: Commit**

~~~powershell
git add scripts/benchmark-hnsw-efc.ts tests/unit/hnsw-efc-benchmark.test.ts
git commit -m "feat(benchmark): add scalar HNSW mode"
~~~

### Task 6: Implement immutable snapshot and candidate ANN execution

**Files:**
- Modify: `scripts/benchmark-hnsw-efc.ts:213-528`
- Modify: `tests/unit/hnsw-efc-benchmark.test.ts`
- Use: `scripts/hnsw-quantization-model.ts`

- [ ] **Step 1: Write failing orchestration behavioral tests**

Use injected family-copy, free-space, clock, query-runner, catalog, persisted-definition verifier, benchmark-only quality-handoff callback, and event-trace dependencies. Task 6 uses a stub handoff callback solely to prove close-before-child ordering; Task 7 supplies the real process runner. Prove exact operation order rather than only searching source text. Retain a small source-contract assertion solely for absence of the legacy unconditional cleanup path.

- [ ] **Step 2: Run and verify RED**

- [ ] **Step 3: Implement and test disk preflight before the first copy**

Measure the complete validated source family. Compute required bytes with overflow-safe integer arithmetic as `ceil(sourceFamilyBytes * 12 * 1.20)` and unit-test below/equal/above, zero, and overflow boundaries. Resolve the benchmark temp root first, query free bytes on that root's actual volume (not the source volume), and fail before the first snapshot copy when insufficient. Resolve every family beneath one `mkdtemp` root.

- [ ] **Step 4: Implement and test the immutable snapshot ownership sequence**

Execute exactly: validated source-family copy and consume; open the disposable snapshot read-only as its sole owner; stream bounded pages to validate/hash all non-null vectors while retaining only the top-200 hash sample; compute one exact-truth map; strictly close Connection and Database; only then derive candidate families from the closed snapshot. Never reopen or mutate the active source and never fall back to an unsafe copy. The event-trace test must prove close completes before the first candidate copy.

Add a pure/injected ground-truth test with equal cosine scores and a self-match. Prove self exclusion occurs before LIMIT 10, ties use UTF-8 byte comparison, exactly ten truth IDs remain, and the same immutable truth map object/hash is supplied to all five candidates in both repetitions. Do not materialize all 768-D vectors in JavaScript merely to sort or hash; update the streaming digest in stable byte order and retain only 200 query vectors.

- [ ] **Step 5: Implement one candidate with observable setup phases**

Validated-copy the closed snapshot and record copy/validation time separately. Open the single owner, load extension, and record open/load time separately. Resolve inherited index; time drop; time explicit checkpoint; verify absence; time create including forced checkpoint. Keep every setup phase outside the DROP, pre-build CHECKPOINT, and CREATE timers. Strictly close the timed owner. Sequentially reopen the candidate as sole owner outside every build/query timer, `LOAD vector`, run `CALL SHOW_INDEXES() RETURN table_name, index_name, index_type, extension_loaded, index_definition`, select the exact HNSW row, require `extension_loaded = true`, and assert the canonical persisted definition: full precision has neither quantization nor rerank tokens; SQ8/SQ16 has the exact quantization token; the rerank token is present if and only if enabled. After the definition assertion, use that same sole owner for Step 6's ANN runner; persisted-definition verification remains outside the query timers. Strictly close after ANN and before ownership passes to the quality child. Return all phase observations plus family path and a bounded post-reopen compatibility record containing the selected SHOW_INDEXES table/index/type identity, canonical `index_definition` or its bounded hash plus parsed quantization/rerank state, `extension_loaded: true`, and a successful post-reopen ANN probe. The event-trace test must prove `timed CREATE close -> reopen/verify -> ANN -> close -> child` with no overlapping Database owners or verification time inside CREATE/query timers.

- [ ] **Step 6: Implement and behavior-test the ANN pass runner**

With an injected query runner, prove one untimed pass over the ordered 200 queries followed by three timed passes in the identical order. Retain the 200 normalized warm-up result lists as evidence but no warm-up latencies. For each timed invocation, start immediately before `QUERY_VECTOR_INDEX` and stop only after its result is fully materialized and the result handle is closed. Perform distance/UTF-8 sorting, duplicate/non-finite validation, self removal, truncation, and cross-pass comparison only after the timer stops; behavior-test this event boundary. Every invocation must use `k=11` and `efs=200` and return stable IDs plus finite numeric distances. Canonicalize each result set by distance ascending, then UTF-8 ID-byte comparison; reject duplicate IDs or non-finite distances; remove exactly the query ID; and truncate to ten. Fewer than ten is fatal. Retain 600 timed latencies/result lists; feed only the first timed pass to recall/NDCG; fail any result-ID disagreement in later passes.

- [ ] **Step 7: Run five candidates twice in exact forward/reverse order**

Abort on any incomplete candidate. Pass the same frozen truth identity to every candidate. Never pool rerank variants for build decisions.

- [ ] **Step 8: Run focused tests and typecheck**

~~~powershell
node --experimental-strip-types --test tests/unit/hnsw-efc-benchmark.test.ts tests/unit/hnsw-quantization-model.test.ts
npm run typecheck:scripts
~~~

- [ ] **Step 9: Request LadybugDB review**

Review snapshot ownership, drop/checkpoint timer boundary, persisted-definition verification, deterministic equal-distance ordering, result closure, reranking query semantics, and strict-close transitions. Fix findings and rerun Step 8 plus any specifically affected behavioral test.

- [ ] **Step 10: Commit**

~~~powershell
git add scripts/benchmark-hnsw-efc.ts tests/unit/hnsw-efc-benchmark.test.ts
git commit -m "feat(benchmark): run scalar HNSW candidates"
~~~

## Chunk 3: Quality harness, evidence, and failure safety

### Task 7: Run named context-quality cases against every candidate

**Files:**
- Modify: `scripts/benchmark-hnsw-efc.ts`
- Modify: `tests/unit/hnsw-efc-benchmark.test.ts`
- Reuse unchanged: `tests/benchmark/context-quality.test.ts`

- [ ] **Step 1: Write failing child-command/parser tests**

Behavior-test the exact child contract: invoke `node --experimental-strip-types --test --test-concurrency=1 tests/benchmark/context-quality.test.ts` directly; set candidate `SDL_GRAPH_DB_PATH`; delete inherited `SDL_GRAPH_DB_DIR` and any conflicting database-path aliases; set `SDL_CONTEXT_QUALITY_REQUIRE_INDEX=1`, `SDL_CONTEXT_QUALITY_VARIANT=semantic`, `SDL_CONTEXT_QUALITY_CORPUS=sdl-mcp`, `SDL_CONTEXT_QUALITY_REPO_ID=sdl-mcp`, implementation HEAD in `SDL_CONTEXT_QUALITY_REPO_SHA`, a candidate-unique `SDL_CONTEXT_QUALITY_OUTPUT_PATH`, and `SDL_CONTEXT_QUALITY_CASE_DETAILS=1`. Do not set a selected case ID: the exact set is every harness case whose corpus is `sdl-mcp`. Parse schema 2 by selecting `variants.find((variant) => variant.name === "semantic")`, then read its `caseResults`; reject skips, absent or duplicate expected cases, malformed numeric ordered ranks, missing artifact, or non-zero exit. The unchanged harness writes its artifact only after `closeLadybugDb({ strict: true })`, so exit 0 plus a valid artifact is the strict-close proof; do not invent another sentinel.

- [ ] **Step 2: Run unit test and verify RED**

- [ ] **Step 3: Implement isolated ownership handoff**

After the parent strictly closes its Connection and Database, spawn the context test with `windowsHide: true`, the sanitized candidate-specific environment above, and persisted stdout/stderr. Accept only exit 0 plus the post-strict-close artifact, then measure family size. Never overlap independent Database owners.

- [ ] **Step 4: Evaluate paired named-case gates**

Store all five named-case observations for a repetition and evaluate paired gates only after that repetition's exact full-precision observation exists; never borrow the other repetition's baseline. Full precision must pass every static case. Quantized candidates must pass each static boolean predicate and return every expected identifier at a numeric rank no worse than the paired same-repetition full precision result; missing is infinity. Behavior-test both candidate orders, delayed evaluation, missing-as-infinity, boolean-only cases, and evidence for every expected/actual identifier and numeric rank plus both static and paired comparator outcomes.

- [ ] **Step 5: Run focused tests/typecheck and commit**

~~~powershell
node --experimental-strip-types --test tests/unit/hnsw-efc-benchmark.test.ts tests/unit/hnsw-quantization-model.test.ts
npm run typecheck:scripts
git add scripts/benchmark-hnsw-efc.ts tests/unit/hnsw-efc-benchmark.test.ts
git commit -m "feat(benchmark): gate quantization on context quality"
~~~

### Task 8: Add atomic evidence and recoverable cleanup

**Files:**
- Create: `scripts/hnsw-quantization-evidence.ts`
- Create: `tests/unit/hnsw-quantization-evidence.test.ts`
- Modify: `scripts/benchmark-hnsw-efc.ts`

- [ ] **Step 1: Write failing complete/incomplete schema tests**

Define evidence schema version `1` with discriminator `status: "complete" | "incomplete"` and runtime validation. Complete evidence must contain exactly all ten candidate/repetition observations; candidate order and fixed parameters; each candidate's 200 ordered warm-up result records and all 600 ordered timed query records with latency and result IDs; exact truth IDs, first-pass recall/NDCG, all named-case expected/actual identifiers and numeric ranks; per-repetition static/paired gates; aggregates; recommendation; complete child artifact references; environment and implementation commit; LadybugDB version; and `cleanup.state: "pending" | "deleted"`. Incomplete evidence contains the actually completed subset plus failure phase, terminal error, every retained family path, and cleanup state, and must reject any recommendation. Both carry common metadata with timestamp, OS, architecture, Node and LadybugDB versions, hardware data or an explicit unavailable reason, redacted source identity, total Symbol/null/non-null embedding counts and validation outcome, ordered query IDs, and the exact corpus identity `{ algorithm: "sha256", streamVersion: 1, digest }` returned by Task 4. Every candidate/repetition observation explicitly carries DROP time, pre-build CHECKPOINT time, forced-checkpoint-inclusive CREATE time, separately observable clone/load/setup times, durable closed-family size, p50/p95 query latency, and `peakRss` measured in a candidate-isolated child or `unavailable` with a reason. It also validates the bounded post-reopen compatibility record returned by Task 6: selected SHOW_INDEXES identity/canonical definition (or bounded hash plus parsed state), `extension_loaded: true`, exact quantization/rerank state, and successful post-reopen ANN probe. Add negative validation tests that delete each required common and per-observation category from both complete and incomplete fixtures.

- [ ] **Step 2: Write failing atomic persistence tests**

Prove existing output rejection, sibling-temp atomic rename, pre-delete all-family retention, durable complete/pending before deletion, deletion-failure behavior, post-delete receipt-update failure semantics, and no recommendation in incomplete evidence.

- [ ] **Step 3: Write failing descendant-cleanup tests**

Reject root, sibling, unresolved, and escaped paths; accept only real resolved descendants carrying the run ownership marker. Validate every deletion target before the first injected `rm`, and prove that one invalid target causes zero deletions. Inject `rm` in tests; do not expose a generic deletion utility.

- [ ] **Step 4: Run and verify RED**

~~~powershell
node --experimental-strip-types --test tests/unit/hnsw-quantization-evidence.test.ts
~~~

- [ ] **Step 5: Implement minimal evidence and cleanup helpers**

Use discriminated runtime validation; exclusive sibling temp creation; UTF-8 JSON/newline; sync/close/rename; ownership markers; preflight validation of the entire deletion set; and distinct post-authorization deletion-failure and cleanup-receipt-update handling.

- [ ] **Step 6: Integrate finalization**

Write complete/pending only after ten candidates and named gates. Before that durable boundary, every validation, build, query, child, strict-close, or initial-artifact failure must retain every run-created snapshot and candidate family, best-effort write incomplete evidence, print exact retained paths, and exit non-zero. After complete/pending is durable, delete only the fully prevalidated set. If a deletion fails, preserve the valid pending artifact, exit non-zero, and report already-deleted and remaining paths without reclassifying the run as incomplete. If all deletion succeeds but the deleted-receipt replacement fails, preserve the prior complete/pending artifact and use the separate receipt-update warning semantics.

- [ ] **Step 7: Run focused tests and typecheck**

~~~powershell
node --experimental-strip-types --test tests/unit/hnsw-quantization-evidence.test.ts tests/unit/hnsw-quantization-model.test.ts tests/unit/hnsw-efc-benchmark.test.ts
npm run typecheck:scripts
~~~

- [ ] **Step 8: Request security and LadybugDB reviews**

Inspect path containment, atomic output, child environment, deletion, family retention, strict close, and checkpoint evidence. Fix important findings and rerun Step 7.

- [ ] **Step 9: Commit**

~~~powershell
git add scripts/hnsw-quantization-evidence.ts tests/unit/hnsw-quantization-evidence.test.ts scripts/benchmark-hnsw-efc.ts
git commit -m "feat(benchmark): persist scalar HNSW evidence"
~~~

### Task 9: Document the operator contract

**Files:**
- Modify: `docs/troubleshooting.md:480-505`

- [ ] **Step 1: Document the exact command, read-only source, verified graph gate, matrix, fixed parameters, checkpoint timing, quality gates, disk requirement and expected run duration, complete-versus-incomplete artifact interpretation including cleanup pending/deleted, full-precision reranking meaning and its candidate-set limitation, retention/cleanup recovery, and no production change**

- [ ] **Step 2: Verify docs**

~~~powershell
git diff --check
npm run docs:tools:check
~~~

- [ ] **Step 3: Commit**

~~~powershell
git add docs/troubleshooting.md
git commit -m "docs: explain scalar HNSW evaluation"
~~~

## Chunk 4: Verification, real graph, and recommendation

### Task 10: Verify before the expensive run

- [ ] **Step 1: Inspect `git diff --stat <plan-start-sha>..HEAD` and `git diff --check`; confirm no production config/schema/default changes**

- [ ] **Step 2: Run focused units**

~~~powershell
node --experimental-strip-types --test tests/unit/vector-index-definition.test.ts tests/unit/retrieval-index-lifecycle.test.ts tests/unit/hnsw-efc-benchmark.test.ts tests/unit/hnsw-quantization-model.test.ts tests/unit/hnsw-quantization-evidence.test.ts
~~~

- [ ] **Step 3: Build, typecheck, and lint**

~~~powershell
npm run build:all
npm run typecheck
npm run typecheck:scripts
npm run lint
~~~

- [ ] **Step 4: Run real-driver smoke**

~~~powershell
node --experimental-strip-types --test-concurrency=1 --test tests/integration/vector-index-quantization.test.ts
~~~

- [ ] **Step 5: Run `npm test` serially and require exit 0 plus the final TAP summary**

- [ ] **Step 6: Request spec, quality, security, and LadybugDB reviews; fix findings and rerun affected checks**

### Task 11: Run the real SDL-MCP graph benchmark

**Output:** an operator-approved unique ignored `.benchmark/hnsw-quantization-<run-id>.json` path

- [ ] **Step 1: Call `repo.status` and require root available, no conflicting mutation, and `graphIntegrityState: "verified"`**

Resolve the effective active database path without putting it in the final artifact. Do not refresh or checkpoint the active graph.

- [ ] **Step 2: Record exact HEAD, clean tracked status, Node/Ladybug versions, hardware, sufficient free disk, and a source immutability baseline**

Before any benchmark copy, use the validated-copy protocol's read-only source-family inventory/fingerprint and record repo version, graph-integrity identity, and vector-index identity. Do not checkpoint or open a competing Database owner.

- [ ] **Step 3: Run once via persisted SDL runtime**

~~~powershell
npm run bench:hnsw-efc -- --quantization --source <absolute-active-lbug-path> --load-mode clone --output <absolute-worktree-path>\\.benchmark\\hnsw-quantization-<run-id>.json
~~~

Preflight that the selected artifact path does not exist. If it exists, preserve it and obtain a new operator-approved unique filename; never overwrite or delete prior evidence. Use persisted digest output and set the runtime timeout to the documented upper-bound duration plus a 15-minute finalization margin. Run no other Ladybug repository command concurrently.

- [ ] **Step 4: Monitor only phase transitions/errors; do not terminate a long create solely for exceeding prior timing**

- [ ] **Step 5: Validate the artifact, cleanup branch, and source immutability**

For ordinary success require exit 0, a validated complete artifact with corpus hash, 200 ordered IDs, ten observations, two paired baselines, stable ANN results, all child artifacts, exactly one recommendation, and cleanup deleted. For the receipt-update exception accept non-zero only with the validated durable complete/pending artifact, explicit receipt-update warning, and proof every disposable family was deleted; its recommendation remains valid. For deletion failure after authorization, preserve complete/pending, exit non-zero, and report already-deleted and remaining paths. Every pre-authorization or incomplete failure produces no recommendation and retains every run family.

After the child owners close and without checkpointing or opening a competing Database owner, recompute the same read-only source-family inventory/fingerprint and re-check repo version, graph-integrity identity, and vector-index identity. Require exact equality with Step 2 and no new repo mutation operation; otherwise mark equivalence failed and the experiment inconclusive even if benchmark evidence is complete.

### Task 12: Audit evidence and report exactly one decision

- [ ] **Step 1: Ask LadybugDB specialist to audit equivalence, timers, paired recall, rerank, size, latency, and cleanup**

Evidence defects require a fresh full run; never patch measured JSON.

- [ ] **Step 2: Report complete decision evidence**

For each definition report both build times and the definition-specific two-build median/build delta; never pool rerank variants. Report both paired recall losses plus the pooled mean over the same 200 queries across two repetitions, explicitly noting that these are not 400 independent samples; NDCG; p50/p95; median-p95 latency delta used by the joint `>10%` and `>2 ms` gate; named-case gate; both durable closed-family sizes plus median and relative size delta; eligibility; and rejection reasons. For the selected rerank setting, use only that exact definition's two-build median.

- [ ] **Step 3: Choose SQ8, SQ16, or full precision mechanically from the approved hierarchy and state rerank choice**

- [ ] **Step 4: Stop before production adoption**

Do not add public config, rebuild the active index, merge/push, publish, or release. Offer a separate adoption plan only if requested.
