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

1. Its mean recall@10 is no more than 0.5 percentage points below the matching full-precision baseline.
2. It causes no regression in SDL-MCP's named semantic-retrieval quality cases.

Build speed, checkpoint-inclusive time, database size, memory, and query latency cannot compensate for failing either quality gate. If multiple candidates pass, prefer the simpler and lower-cost candidate. If none pass, retain full precision.

## Source corpus and isolation

Use the current SDL-MCP graph's populated 768-dimensional Jina symbol vectors. The source database remains read-only.

The benchmark extends the existing `scripts/benchmark-hnsw-efc.ts` validated-clone path. Each candidate uses a separate disposable LadybugDB family derived from the same verified source. The benchmark never drops, creates, or mutates an index in the source family.

Before copying, the benchmark must use the existing LadybugDB family-copy protocol and its source-family validation. If a consistent validated clone cannot be established while the source is active, the run must stop with recovery guidance rather than fall back to an unsafe file copy.

All candidates use the same source-vector snapshot, vector count, vector hash, query sample, metric (`cosine`), `efc=200`, and installed `@ladybugdb/core@0.19.0` runtime.

## Candidate matrix

The query-quality matrix contains five candidates:

| Candidate | Quantization | Full-precision reranking |
| --- | --- | --- |
| Full precision | none | not applicable |
| SQ8 | `sq8` | false |
| SQ8 plus rerank | `sq8` | true |
| SQ16 | `sq16` | false |
| SQ16 plus rerank | `sq16` | true |

Build comparisons aggregate by physical quantization mode: full precision, SQ8, and SQ16. Rerank-enabled candidates remain separate physical builds because the setting is stored in the index definition, but the report must not claim their duplicate build measurements prove reranking changes construction cost.

## Sampling and ground truth

Select 200 non-null Jina vectors deterministically by hashing each stable symbol ID and taking the first 200 by hash and then symbol ID. Exclude the query symbol itself from results.

Compute exact cosine top-10 neighbors once per query from the disposable snapshot before candidate construction, using stable symbol ID as the final tie-breaker. Reuse that exact ground truth for every candidate and repetition.

Two hundred queries yield 2,000 top-10 truth positions. A 0.5-percentage-point difference therefore corresponds to ten neighbor matches, avoiding a threshold dominated by a single result.

The evidence artifact records the sampling algorithm, ordered query IDs, source-vector count, and a deterministic hash of the ordered source vector identities and exact stored values so later runs can prove corpus equivalence.

## Metrics

Record the following per candidate and per repetition:

- `CREATE_VECTOR_INDEX` wall time, explicitly labeled as including LadybugDB's forced checkpoint.
- Any separately observable load or setup time, without subtracting unmeasured checkpoint work from the build duration.
- Disposable database-family size after the index is durable and closed.
- Peak RSS only if it can be isolated reliably. Otherwise record it as unavailable with a reason.
- Recall@10 against exact cosine ground truth.
- NDCG@10 using the exact top-10 order as graded relevance and stable tie-breaking.
- Query latency p50 and p95 after a bounded warm-up identical for all candidates.
- Named SDL-MCP semantic-retrieval quality-case results.
- Cleanup outcome and any retained diagnostic path.

Aggregate metrics retain individual observations. Timing summaries use medians across repetitions; quality gates evaluate the combined deterministic query observations and also report each repetition so instability remains visible.

## Order-bias control

Run the five candidates twice:

1. Full precision, SQ8, SQ8 plus rerank, SQ16, SQ16 plus rerank.
2. SQ16 plus rerank, SQ16, SQ8 plus rerank, SQ8, full precision.

Each candidate receives a fresh disposable database in each repetition. Reversing the order reduces warm-cache and system-order bias without pretending that two samples provide a general performance distribution.

## Named retrieval-quality evaluation

For each candidate, run the existing SDL-MCP named semantic-retrieval cases against that candidate's validated full-graph clone through an isolated SDL-MCP runtime. Preserve the production retrieval pipeline, query settings, and non-vector graph state; change only the candidate HNSW definition.

The implementation plan must identify the exact existing harness and case set before code changes. If the harness cannot safely target a disposable database without adding a production quantization setting, add a benchmark-only injected index definition or benchmark adapter. Do not expose an unproven public configuration field to make the experiment convenient.

Record case-level expected and actual identifiers/ranks. A missing expected symbol, a newly failed case, or a worse existing pass criterion is a regression even when aggregate recall passes.

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

Write one JSON artifact only after validating its required fields. It contains:

- schema version and benchmark implementation commit
- timestamp as artifact metadata, not model-facing MCP output
- OS, architecture, Node version, LadybugDB package version, and relevant hardware information when available
- redacted source identity, vector dimension/count/hash, sampling details, and query IDs
- exact candidate parameters and execution order
- all individual measurements and aggregate summaries
- recall and named-case gate decisions with reasons
- retained or deleted disposable-family status
- command exit status and terminal error when incomplete

Use an explicit operator-selected output path. Do not write evidence into the active database directory.

## Failure and cleanup behavior

- Never mutate the source database.
- Create each disposable family beneath a benchmark-owned temporary root.
- After a fully successful run and durable evidence write, strictly close and delete disposable families.
- On any build, query, validation, evidence-write, or strict-close failure, retain affected disposable families and print their exact paths for diagnosis.
- If evidence writing fails, do not delete the databases that produced the unrecorded results.
- A partial run must exit non-zero and must not produce an adoption recommendation.
- Unsupported scalar-quantization syntax in the installed driver is a failed compatibility smoke test, not permission to change the runtime or silently fall back.

## Test-driven implementation

Write and observe failing tests before implementation for:

- accepted full/SQ8/SQ16 index definitions
- invalid quantization and rerank combinations
- exact `CREATE_VECTOR_INDEX` SQL for full precision, SQ8, SQ8 plus rerank, SQ16, and SQ16 plus rerank
- unchanged legacy SQL when optional arguments are absent
- candidate expansion and reverse ordering
- deterministic sampling and corpus hashing
- recall@10 and NDCG@10 calculations
- the 0.5-percentage-point gate boundary
- evidence validation and serialization
- cleanup after success and retention after failure

Add a small real-LadybugDB integration smoke test that creates and queries SQ8 and SQ16 indexes with reranking both off and on through the installed 0.19.0 driver. Run this before the expensive real-graph benchmark.

## Verification sequence

1. Observe focused tests fail for the missing benchmark and helper behavior.
2. Implement the minimum code required to pass them.
3. Run the focused unit tests.
4. Run the real-LadybugDB scalar-quantization smoke test.
5. Run the repository build, script typecheck, main typecheck where affected, and lint for changed production source.
6. Run the real-graph benchmark and verify a complete evidence artifact.
7. Run the named semantic-retrieval quality harness for every candidate.
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
