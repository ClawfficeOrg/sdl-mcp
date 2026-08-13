# LadybugDB HNSW Scalar Quantization Benchmark Design

**Date:** 2026-08-13

**Status:** Approved for implementation planning

## Goal

Evaluate LadybugDB 0.19.0 full-precision, SQ8, and SQ16 HNSW indexes against SDL-MCP's real Jina symbol vectors and determine whether SDL-MCP should adopt SQ8, adopt SQ16, or retain full precision.

The experiment must produce reproducible evidence without changing the active graph, production configuration, or production vector-index behavior.

## Background

SDL-MCP currently creates full-precision cosine HNSW indexes. LadybugDB 0.19.0 adds opt-in scalar quantization through `quantization := 'sq8'` and `quantization := 'sq16'`, plus optional query-time `use_full_precision_rerank := true`.

Quantization changes HNSW construction and candidate generation. Full-precision reranking does not rebuild the graph or recover candidates omitted during traversal; it reorders the returned quantized candidates using the original embedding column. The benchmark therefore treats quantization as a build dimension and reranking as a query-quality and query-latency dimension.

## Decision criteria

A quantized candidate is eligible only if it satisfies both quality gates:

1. In each repetition, its mean recall@10 is no more than 0.5 percentage points below the full-precision result from that same repetition.
2. It causes no regression in SDL-MCP's named semantic-retrieval quality cases in either repetition.

For repetition r, define recall loss as fullPrecisionRecall_r minus candidateRecall_r. The candidate passes only when recall loss is less than or equal to 0.005 in both repetitions. Compare unrounded floating-point means; round only display values. Report the pooled mean across the same 200 queries and two repetitions as a stability summary, but do not claim that repeating the same queries creates 400 independent semantic samples.

Query latency is a viability gate: reject a candidate only when its median p95 is both more than 10 percent and more than 2 milliseconds slower than full precision. This combined rule avoids treating timer noise on very short queries as material.

Apply this deterministic recommendation hierarchy:

1. Reject every candidate that fails recall, named-case, compatibility, or query-latency gates.
2. Prefer reranking off when both rerank states for one quantization mode pass. Use reranking on only when reranking off fails any eligibility gate and reranking on passes all eligibility gates, or when reranking improves mean NDCG@10 by at least 0.005 without failing the latency gate.
3. A quantized mode must improve median forced-checkpoint-inclusive build time by at least 10 percent relative to full precision; otherwise retain full precision because two repetitions cannot establish a smaller difference reliably.
4. Among remaining quantized modes, choose the lowest median build time when the difference is at least 10 percent. If build times are within 10 percent, choose the smaller durable database family when its advantage is at least 10 percent. If both are within 10 percent, prefer SQ16 for greater numerical fidelity.
5. If evidence is incomplete, contradictory, or inside all declared noise bands, retain full precision.

Build speed, database size, and memory cannot compensate for failing a quality gate.

## Source corpus and isolation

Use the current SDL-MCP graph's populated 768-dimensional Jina symbol vectors. The source database remains read-only.

The benchmark extends the existing `scripts/benchmark-hnsw-efc.ts` validated-clone path. Each candidate uses a separate disposable LadybugDB family derived from the same verified source. The benchmark never drops, creates, or mutates an index in the source family.

Before copying, the benchmark must use the existing LadybugDB family-copy protocol and its source-family validation. If a consistent validated clone cannot be established while the source is active, the run must stop with recovery guidance rather than fall back to an unsafe file copy.

Each fresh clone initially contains the production full-precision index. Before measuring a candidate, drop that cloned index, record the drop duration, run an explicit successful CHECKPOINT outside the build timer, record the checkpoint duration, and verify from the catalog that the target index is absent. Only then start the CREATE_VECTOR_INDEX timer. This prevents the candidate's forced create checkpoint from absorbing the previous index drop's uncheckpointed WAL and internal-table changes.

All candidates use the same source-vector snapshot, vector count, vector hash, query sample, metric (cosine), efc=200, query-time efs=200, and installed @ladybugdb/core@0.19.0 runtime.

## Candidate matrix

The query-quality matrix contains five candidates:

| Candidate | Quantization | Full-precision reranking |
| --- | --- | --- |
| Full precision | none | not applicable |
| SQ8 | `sq8` | false |
| SQ8 plus rerank | `sq8` | true |
| SQ16 | `sq16` | false |
| SQ16 plus rerank | `sq16` | true |

The rerank flag is an optional CREATE_VECTOR_INDEX argument with a default of false. LadybugDB persists it in the index definition and consults it during queries. It does not create a different HNSW graph, but a fair compatibility test still creates all five physical definitions per repetition. Therefore each repetition performs five physical builds. After recommendation step 2 selects one rerank state for each quantization mode, that mode's build value is the median of exactly the selected definition's two repetition build times. The other rerank definition's two builds remain compatibility and diagnostic observations; never pool all four or average rerank states when applying the 10-percent adoption boundary.

## Sampling, validation, and ground truth

Null Jina embeddings are permitted and excluded from the candidate corpus. Record the total Symbol row count, excluded-null count, and non-null vector count. For every non-null Jina-vector row, require a unique non-empty stable symbol ID, exactly 768 finite IEEE-754 values, and a finite non-zero norm. Reject the run on any invalid non-null row rather than silently changing the corpus.

For query sampling, compute SHA-256 over the UTF-8 bytes of each validated non-null vector's stable symbol ID. Sort by digest bytes and then by UTF-8 symbol ID bytes, and take the first 200 vectors.

Build the corpus hash in stable symbol-ID byte order. Feed SHA-256 a versioned binary stream containing, for each row, the unsigned 32-bit little-endian UTF-8 ID length, ID bytes, unsigned 32-bit little-endian dimension, and each exact loaded vector value encoded as IEEE-754 Float64 little-endian. Record the hash algorithm and stream version.

Compute exact cosine top-10 neighbors once per query from the disposable snapshot before candidate construction. Exclude the query stable ID before ordering and LIMIT 10. Order equal cosine scores by stable symbol ID bytes. Reuse that exact ground truth for every candidate and repetition.

Two hundred queries yield 2,000 top-10 truth positions per repetition. A 0.5-percentage-point boundary equals ten matches within each paired repetition. The second repetition evaluates build and runtime stability over the same semantic sample; it does not double the number of independent queries.

The evidence artifact records the ordered query IDs, source-vector count, validation result, and corpus hash.

## ANN query protocol

Use the same deterministic ordered 200-query list for every candidate. Set efs=200 explicitly. Request k=11 from QUERY_VECTOR_INDEX, remove exactly the query stable ID, and truncate to the first 10 remaining results. Fail the query if ten results do not remain. This prevents self-matches from reducing the evaluated result set to nine.

After index creation, run one untimed warm-up pass over all 200 queries in the same order. Then run three timed passes in that order, recording all 600 invocation latencies and per-query results. Recall and NDCG use the first timed pass for the paired quality gate; the other passes measure query latency and verify byte-stable result IDs. A result-ID disagreement across timed passes is an instability failure.

LadybugDB applies full-precision reranking to the approximate candidate set before its final resize to k. Reranking cannot recover a true neighbor absent from that candidate set, so all five candidates must use identical k, efs, warm-up, and query ordering.

## Metrics

Record the following per candidate and per repetition:

- DROP_VECTOR_INDEX wall time before the pre-build checkpoint.
- Explicit pre-build CHECKPOINT wall time.
- CREATE_VECTOR_INDEX wall time after the clean checkpoint boundary, explicitly labeled as including LadybugDB's forced create checkpoint.
- Any separately observable clone/load/setup time.
- Disposable database-family size after the index is durable and strictly closed.
- Peak RSS only if measured in a candidate-isolated child process. Otherwise record it as unavailable with a reason.
- Recall@10 against exact cosine ground truth.
- NDCG@10 defined below.
- Query latency p50 and p95 over the 600 timed invocations.
- Named SDL-MCP semantic-retrieval quality-case results.
- Cleanup outcome and any retained diagnostic path.

For NDCG@10, assign relevance 11-r to the item at exact rank r, producing gains 10 through 1; any item outside exact top-10 has relevance 0. For predicted position i, compute DCG as the sum of (2^relevance - 1) / log2(i + 1), with one-based i. IDCG is the same calculation over the exact stable order. NDCG is DCG divided by IDCG. The exact symbol-ID tie-breaker defines IDCG deterministically.

Aggregate metrics retain individual observations. Timing summaries use medians across repetitions. Recall eligibility evaluates each repetition independently from the first timed ANN pass against the paired full-precision candidate. Named-case eligibility evaluates the separate isolated SDL-MCP harness results against static expectations and the paired full-precision harness run. Pooled quality values are summary-only and never change eligibility.

## Order-bias control

Run the five candidates twice:

1. Full precision, SQ8, SQ8 plus rerank, SQ16, SQ16 plus rerank.
2. SQ16 plus rerank, SQ16, SQ8 plus rerank, SQ8, full precision.

Each candidate receives a fresh disposable database in each repetition. Reversing the order reduces warm-cache and system-order bias without pretending that two samples provide a general performance distribution.

## Named retrieval-quality evaluation

For each candidate in each repetition, finish ANN measurement, strictly close the benchmark-owned connection and Database handle, then run the existing SDL-MCP named semantic-retrieval cases against that same validated full-graph family through an isolated child-process SDL-MCP runtime. Require the child process to close strictly before measuring durable family size or continuing cleanup. Preserve the production retrieval pipeline, query settings, and non-vector graph state; change only the candidate HNSW definition. Never open the same family through two independent Database owners concurrently.

The implementation plan must identify the exact existing harness and case set before code changes. If the harness cannot safely target a disposable database without adding a production quantization setting, add a benchmark-only injected index definition or benchmark adapter. Do not expose an unproven public configuration field to make the experiment convenient.

Apply both static and paired comparators. The full-precision candidate must pass every harness-defined static expectation in each repetition; otherwise the entire experiment is inconclusive and produces no adoption recommendation. Each quantized candidate must pass the same static expectations and, for every expected identifier exposed by the ordered result, return it at a numeric rank no worse than the paired full-precision run. Treat a missing identifier as infinite rank. When a case has only a boolean harness predicate, require both full precision and the quantized candidate to pass it. Record all expected and actual identifiers/ranks and both comparator outcomes. Artifact finalization and successful cleanup occur only after these named-case results have been recorded.

## Code boundaries

### Production helper

Extend `createVectorIndex()` with optional internal, closed-enum arguments for:

- quantization: `sq8` or `sq16`
- full-precision reranking: boolean, legal only with quantization

Omitting both arguments must preserve today's exact SQL text and behavior. Construct named arguments from validated internal values; never interpolate caller-controlled strings.

This helper capability is not a production opt-in. Do not add quantization to `src/config/types.ts`, the public JSON schema, example configuration, or production index orchestration in this task.

### Benchmark

Extend `scripts/benchmark-hnsw-efc.ts` rather than create a second overlapping benchmark. Add:

- closed candidate definitions and validation
- deterministic two-pass candidate ordering
- the 200-query sample
- NDCG@10
- durable database-family size measurement
- explicit quality-gate evaluation
- JSON evidence output
- failed-run retention and successful-run cleanup reporting

Retain the existing real-vector copy, validated-clone, exact-cosine, source-isolation, and query-latency machinery.

### Documentation

Update the benchmark and HNSW troubleshooting documentation with the command, metrics, source-safety contract, expected run duration, artifact interpretation, recall threshold, rerank meaning, and cleanup behavior.

## Evidence artifact

Use an explicit operator-selected output path outside the active database directory and reject an existing output path unless the operator explicitly selects a different path. Evidence uses a versioned discriminated schema:

- complete: all candidates, repetitions, ANN queries, named cases, aggregates, gates, and recommendation are present.
- incomplete: the completed subset, failure phase, terminal error, retained paths, and cleanup state are present; it contains no adoption recommendation.

Both forms contain the benchmark implementation commit, timestamp, OS, architecture, Node and LadybugDB versions, hardware data when available, redacted source identity, corpus validation/hash, ordered query IDs, candidate parameters/order, measurements, and cleanup state.

Write JSON to a uniquely named sibling temporary file, flush and close it, then atomically rename it to the selected output path. On a recoverable failure after option parsing and before validated deletion begins, make a best-effort atomic write of a schema-valid incomplete artifact. Failure to write either form before deletion remains a non-zero terminal error and requires all disposable families to be retained.

For a successful benchmark, first strictly close every disposable family and atomically write a complete, recommendation-bearing artifact with cleanup state pending. That durable complete artifact is the deletion authorization boundary. Then delete only validated descendants of the benchmark-owned temporary root and atomically replace the artifact with cleanup state deleted. The final replacement is a cleanup receipt, not benchmark evidence finalization. If it fails after deletion, the prior complete artifact and recommendation remain valid with cleanup pending; the command exits non-zero with an explicit receipt-update warning, but the run is not reclassified as partial and the already deleted families cannot be retained.

## Failure and cleanup behavior

- Never mutate the source database.
- Create each disposable family beneath a benchmark-owned temporary root.
- Record the resolved root and require every recursive deletion target to be a resolved descendant owned by that run.
- After a fully successful run, strict close, complete evidence persistence, and descendant validation, delete disposable families.
- On any build, query, named-case, validation, initial evidence-write, or strict-close failure, retain affected disposable families and print their exact paths.
- A pre-deletion partial run exits non-zero, emits a validated incomplete artifact when possible, retains its families, and contains no adoption recommendation.
- A post-deletion cleanup-receipt update failure is the sole exception: it exits non-zero while preserving the already durable complete recommendation artifact with cleanup pending.
- Unsupported scalar-quantization syntax in the installed driver is a failed compatibility smoke test, not permission to change the runtime or silently fall back.

## Test-driven implementation

Write and observe failing tests before implementation for:

- accepted full/SQ8/SQ16 index definitions
- invalid quantization and rerank combinations
- exact CREATE_VECTOR_INDEX SQL for full precision, SQ8, SQ8 plus rerank, SQ16, and SQ16 plus rerank
- unchanged legacy SQL when optional arguments are absent
- candidate expansion, five physical definitions, and reverse ordering
- explicit drop, pre-build checkpoint, absence verification, and timer boundaries
- canonical source validation, sampling, and corpus hashing
- k+1 self-exclusion and fixed efs query behavior
- recall@10 and the specified NDCG@10 calculation
- the paired 0.5-percentage-point gate boundary without display rounding
- deterministic recommendation hierarchy and noise bands
- complete and incomplete evidence validation and atomic serialization
- cleanup after success, failure retention, and descendant-only deletion

Add a small real-LadybugDB integration smoke test that creates and queries SQ8 and SQ16 indexes with reranking both off and on through the installed 0.19.0 driver. Run this before the expensive real-graph benchmark.

## Verification sequence

1. Observe focused tests fail for the missing benchmark and helper behavior.
2. Implement the minimum code required to pass them.
3. Run the focused unit tests.
4. Run the real-LadybugDB scalar-quantization smoke test.
5. Run the repository build, script typecheck, main typecheck where affected, and lint for changed production source.
6. Run the real-graph benchmark. Within each candidate run, complete ANN measurements and named semantic-retrieval cases before strict close.
7. Verify the complete evidence artifact, paired gates, recommendation hierarchy, and cleanup receipt.
8. Request LadybugDB-specialist review of the implementation and evidence.
9. Recommend SQ8, SQ16, or full precision strictly from the declared gates.

## Explicit non-goals

- Do not change production index defaults.
- Do not add public quantization configuration.
- Do not tune `efc`, `efs`, embedding inference, persistence batching, or checkpoint behavior.
- Do not compare a different vector model or synthetic corpus.
- Do not remove or bypass LadybugDB's forced checkpoint.
- Do not treat quantized ONNX inference models as HNSW scalar quantization.
- Do not publish results from an incomplete or non-equivalent corpus.

## Completion criteria

The task is complete when a reproducible, reviewed artifact from the real SDL-MCP Jina corpus supports exactly one evidence-backed recommendation:

- adopt SQ8, with or without reranking;
- adopt SQ16, with or without reranking; or
- retain full precision.

Production adoption, configuration design, release notes, and migration behavior require a separate approved implementation task after this benchmark.
