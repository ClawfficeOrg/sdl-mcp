# Semantic Test Case Model Design

**Status:** Proposed

**Date:** 2026-07-28

**Related finding:** `sdl.context` cannot retrieve the exact `sdl.info` contract tests because their titles and assertions live in anonymous test callbacks that are not indexed as symbols.

## Summary

SDL represents an actual test case as an optional semantic facet on a normal structural symbol. `SymbolKind` remains unchanged. Named tests remain `function` or `method` symbols. Anonymous callback and macro tests gain a synthetic `function` symbol whose range covers the complete test construct. Both forms carry the same `testCase` metadata.

This is the smallest cross-language model that lets test titles and bodies use SDL's existing symbol search, ranking, graph, and code evidence. It does not add a test-only graph, a new retrieval lane, embeddings, file chunks, or a `test` symbol kind.

## Problem

The verified acceptance query is:

> Find the tests that assert sdl.info is exposed as a top-level Code Mode tool and rejected as an sdl.workflow action.

The exact contract lives in `tests/unit/code-mode-tool-validation.test.ts`, in these two cases:

- `rejects info and sdl.info as sdl.workflow actions`
- `keeps sdl.info callable and discoverable in exclusive Code Mode`

Today the file produces narrow ordinary symbols such as `registerTool` and `OutputSchema`, but no symbol represents either `it(...)` callback. The titles and assertions therefore do not appear in a candidate symbol's searchable metadata or retrievable range.

Increasing the response budget cannot repair this. Budgeting only chooses among candidates retrieval already found. The missing test cases are absent before selection begins.

SDL already uses test-like paths as a broad preference signal. That signal cannot distinguish a test case from helpers, fixtures, types, or imported methods. A first-class semantic marker must identify the actual case and its complete source range.

## Goals

- Give actual tests a language-neutral semantic identity while preserving structural kinds.
- Make static titles, suite names, framework names, and modifiers searchable through existing symbol FTS.
- Return complete test bodies through existing hot-path and gated-window mechanisms.
- Preserve named symbol IDs when adding test metadata.
- Reuse current call ownership when source call ranges make reassignment provable.
- Work in legacy, worker/native, provider-first, and live-draft indexing without pretending those pipelines share the same intermediate representation.
- Keep indexing and tool responses deterministic and bounded.

## Non-goals

This version does not:

- infer assertion semantics, expected outcomes, coverage, or pass/fail state;
- add a source-chunk or RAG retrieval lane;
- create suite, fixture, assertion, or framework graph nodes;
- change context budgeting, focus paths, or omission reporting;
- scan source at query time;
- invent identities for dynamically computed anonymous test titles;
- reparent provider-first edges when the provider fact does not preserve a source occurrence range;
- ship every framework detector atomically with the domain model.

## Domain model

Add one optional facet to extracted and public/persisted symbols:

```ts
export interface TestCaseFacet {
  framework: string;
  title: string;
  suitePath?: string[];
  category?: "test" | "benchmark" | "example" | "fuzz";
  modifiers?: Array<"skip" | "todo" | "only" | "parameterized">;
}

interface ExtractedSymbol {
  testCase?: TestCaseFacet;
}

interface SymbolCard {
  testCase?: TestCaseFacet;
}
```

- `framework` is a stable normalized string such as `node:test`, `jest`, `vitest`, `pytest`, `unittest`, `go`, `junit`, `xunit`, `rust`, or `bats`. It remains a string so a new detector does not require a public enum change.
- `title` is the normalized static title. Declaration-based tests use the declaration name when the framework supplies no separate title.
- `suitePath` contains enclosing static suite titles from outermost to innermost.
- `category` defaults to `test` and is omitted when it has that value.
- `modifiers` contains only syntax-proven values and uses the fixed order shown above.

The containing symbol already owns language, file, range, and identity, so the facet does not duplicate them. `SymbolKind` stays structural: a test function is still a function and a test method is still a method.

## Detection facts

Adapters normalize framework syntax into a discriminated candidate. Attachment and synthesis are separate operations so a failed attachment can never silently create a duplicate symbol.

```ts
type TestCaseCandidate =
  | {
      mode: "attach";
      targetName: string;
      targetKinds: Array<"function" | "method">;
      constructRange: Range;
      testCase: TestCaseFacet;
    }
  | {
      mode: "synthetic";
      kind: "function";
      name: string;
      nodeId: string;
      constructRange: Range;
      sourceFingerprint: string;
      testCase: TestCaseFacet;
    };
```

A detector receives the repository-relative path, language ID, source content, and the language adapter. It may also reuse a parsed tree, ordinary extracted symbols, imports, decorators, annotations, or attributes when the caller already has them. It must use syntax or a reliable language/framework convention; a `tests/` path alone is not enough to emit a candidate.

### Attachment

For a named test, the merge selects one ordinary symbol in the same file whose name and structural kind match and whose range overlaps or is contained by `constructRange`. If there is no unique match, SDL records a repository-relative diagnostic and drops the candidate. It does not create a synthetic fallback.

The matched symbol keeps its existing name, kind, range, AST fingerprint, and symbol ID. Only the optional facet and derived search text change.

### Synthesis

For an anonymous callback, callback-free `todo` declaration, or statically named macro test, the detector emits an explicit synthetic candidate. The persisted symbol uses:

- kind: `function`;
- name: the normalized static test title;
- node ID: `sdl:test-case:<sourceFingerprint>`;
- range: the complete invocation, declaration, or macro construct;
- AST fingerprint: `sourceFingerprint`;
- facet: the normalized test metadata.

`sourceFingerprint` is a versioned hash of the exact indexed source slice plus a one-based occurrence ordinal among byte-identical candidate slices in that file. The deterministic node ID derives only from that fingerprint. The same detector therefore produces the same node ID and fingerprint across TypeScript fallback, worker/native, provider-first, and live-draft paths without depending on parser-specific IDs. The core adds the node ID to `nodeIdToSymbolId` and passes the fingerprint to the existing `generateSymbolId(repoId, relPath, kind, name, astFingerprint)` function.

Duplicate titles may share a display name. Distinct bodies have distinct source fingerprints; byte-identical duplicates use the occurrence ordinal. Candidates sort by source range before ordinal assignment, so IDs and output ordering are byte-stable for unchanged source.

A full-construct range is intentional because it contains both the title and assertions. In extracted-call pipelines, the normalizer recomputes the smallest enclosing owner for each call across the complete merged set of ordinary and synthetic symbols. It changes `ExtractedCall.callerNodeId` only when the synthetic test is the globally smallest enclosing symbol. A nested ordinary function or method therefore keeps ownership of its own calls.

### Dynamic titles

An anonymous case with no static string or no-substitution template title is not synthesized in the first version. Named declaration tests can still be attached because their declaration name is stable. A dynamic-title detector can be added later only with a deterministic source representation and regression fixture.

## Pipeline integration

The common boundary is semantic normalization immediately before each pipeline constructs persistent symbol rows. The common input/output is `TestCaseCandidate[]`; the pipelines do not need a common parser object.

### Legacy, worker/native, and live-draft paths

These paths retain source content while building rows. They run detection after ordinary symbols and calls are available and before `buildSymbolAndEdgeRows` or the live equivalent persists rows.

Worker/native calls already contain `callerNodeId` and a source `range`, so the normalizer can reassign ownership after extraction. The first version may parse detector-eligible content once more when the worker did not return a reusable tree. It must not reread the file because `BuildRowsParams.content` or the draft content is already available. Transporting candidates directly from a worker is an optimization, not a prerequisite, and should be added only if profiling justifies it.

### Provider-first paths

SCIP/LSP provider facts have symbol and occurrence ranges but no adapter node IDs or parsed tree. Provider `EdgeFact` already contains owner IDs and does not preserve the source occurrence range needed for safe edge reassignment.

Provider-first therefore runs detection on eligible changed source files after provider facts are collected and before `providerFactsToGraphRows` materializes rows. It reuses source content when the scan retains it; otherwise it performs one bounded source read and parse for that semantic augmentation. The resulting candidates:

- attach facets to uniquely matched provider symbols using file, name, structural kind, and range overlap;
- materialize synthetic internal symbols with the shared ID contract, a null SCIP symbol, and SDL/tree-sitter provenance;
- leave existing provider edge ownership unchanged in version 1.

This source read is an explicit provider-first cost, not hidden parity. Later edge reassignment requires extending provider facts with a source occurrence link or range; it is not part of this finding.

### Failure behavior

Detector or merge failure is non-fatal. SDL records a deterministic repository-relative diagnostic and keeps the ordinary symbols. Ambiguous syntax produces no facet rather than a guessed one.

## Detector rollout

The model and merge contract are cross-language from the first change, but detector coverage grows independently. Requiring every framework before the schema can ship would turn one retrieval defect into an unnecessarily large release.

The first implementation slice includes:

1. JavaScript/TypeScript `node:test`, Jest, and Vitest static `test`/`it` cases, suite paths from `describe`, and syntax-proven `.skip`, `.todo`, `.only`, and parameterized forms.
2. One declaration-oriented detector, preferably Python `pytest`/`unittest`, to prove the same facet attaches to existing functions and methods rather than only solving callback syntax.

`describe` contributes `suitePath`; it is not synthesized as a test symbol. A callback-free `.todo("title")` is a real synthetic test case even though it has no body.

Subsequent detectors add coverage without changing the model or schema:

| Language | Reliable target forms |
| --- | --- |
| Go | `_test.go` `Test*`, `Benchmark*`, `Example*`, and `Fuzz*` functions with conventional signatures |
| Java / Kotlin | JUnit, TestNG, and Kotlin test annotations, including parameterized forms |
| Rust | `#[test]`, `#[tokio::test]`, and `#[rstest]` functions |
| C# | xUnit, NUnit, and MSTest test attributes |
| C / C++ | Statically named GoogleTest `TEST*` and Catch2/doctest `TEST_CASE` forms |
| PHP | PHPUnit attributes/annotations and `test*` methods on test-case classes |
| Shell | Statically titled Bats `@test` blocks |

A detector ships only with positive fixtures and negative lookalikes. Unsupported or ambiguous syntax remains unclassified.

## Persistence, integrity, and rebuild

Persist the facet as deterministic nullable JSON, `testCaseJson`, on the existing `Symbol` node. Propagate it through:

- domain and database row types;
- batch writes and shadow finalization;
- provider-first materialization and legacy shadow rows;
- worker/native result adaptation when those paths emit rows directly;
- snapshots, sync export/import, and live overlays;
- card hydration, compact/packed projection, ETags, and content fingerprints;
- persisted-graph-integrity symbol rows, canonical tuples, serialization, and digests.

The JSON uses stable key order, source-ordered `suitePath`, and fixed-order deduplicated modifiers. The public `SymbolCard` includes the facet when present and omits it when absent.

Adding a `Symbol` property changes the LadybugDB schema. Increment `LADYBUG_SCHEMA_VERSION` and require a full graph rebuild. An in-place nullable-property shim is insufficient because old graphs also lack synthetic test symbols and their ranges.

## Retrieval behavior

Add these facet terms to `buildSearchText`:

- title and identifier-like title segments;
- suite titles and their identifier-like segments;
- framework;
- non-default category;
- modifiers.

This reuses existing symbol FTS, candidate ranking, result fusion, and hydration. No test-specific scoring formula or candidate lane is introduced initially.

Where retrieval currently uses `isTestLikePath`, a present `testCase` facet joins that predicate as authoritative test evidence. Path-based behavior remains as a compatibility fallback for helpers and fixtures. This means an inline Rust or Java test in a non-test-named file is treated as a test once its detector exists, while an unrelated helper does not become an actual test merely because it lives under `tests/`.

`includeTests: false` excludes or de-prioritizes semantic test symbols at the same decision points that currently use test-like paths. `includeTests: true` permits or prefers both semantic test symbols and the existing test-like path fallback. Existing task-profile defaults do not change.

Because a synthetic test owns the full construct range, current hot-path hydration can return matching assertions. Existing policy gates still control larger raw windows.

## Graph behavior

No new edge type is required.

Named tests keep existing edges. Legacy, worker/native, and live-draft paths recompute each call owner across the merged symbol set; a synthetic test becomes the caller only when no smaller nested function or method encloses that call. Provider-first synthetic tests initially receive normal repository/file ownership but do not steal pre-owned provider edges without occurrence-range proof.

The broad `test` role tag remains for compatibility and path preference. Consumers use `testCase`, not the role tag, when they need actual cases.

## Bounds and determinism

The existing maximum indexed-file size is the primary work bound. Detectors do not add a per-file test-count cap that could silently omit generated tests.

Persisted test text is bounded as follows:

- title: at most 256 Unicode code points;
- each suite segment: at most 256 Unicode code points;
- suite depth: at most 16 segments, retaining the innermost segments;
- repeated whitespace: normalized to one space;
- empty static anonymous titles: not synthesized.

Candidates sort by construct range, mode, structural kind, name, and source fingerprint. Facet keys and modifier values use fixed order. Queries and response hydration retain explicit tie-breakers. No timestamps, absolute paths, durations, or counters enter tool responses.

## Acceptance criteria

### Model and extraction

- Named test declarations keep their pre-change symbol IDs and receive exactly one facet.
- An anonymous static callback or macro case produces exactly one `function` symbol covering the complete construct.
- Its deterministic `sdl:test-case:<sourceFingerprint>` node ID resolves through `nodeIdToSymbolId` to the generated symbol ID.
- Call ownership is recomputed across all enclosing symbols, and nested functions keep their calls.
- A missing or ambiguous attachment target produces a diagnostic and no synthetic duplicate.
- Helpers in test files may retain the broad test role tag but do not receive `testCase`.
- Duplicate titles produce distinct deterministic IDs and byte-stable ordering.
- JavaScript/TypeScript and the first declaration-oriented detector prove both synthesis and attachment.
- Provider-first, fallback, worker/native, and live-draft fixtures agree on facet content, synthetic range, and synthetic ID for the same source. Provider edge ownership is excluded from this parity assertion until provider facts carry occurrence ranges.

### Exact retrieval acceptance

On a fresh verified graph, repeat this request with `refsMode: "off"`:

```json
{
  "repoId": "sdl-mcp",
  "taskType": "review",
  "taskText": "Find the tests that assert sdl.info is exposed as a top-level Code Mode tool and rejected as an sdl.workflow action.",
  "focusPaths": ["tests"],
  "includeTests": true,
  "budget": { "maxTokens": 2400 },
  "responseMode": "inline",
  "refsMode": "off",
  "wireFormat": "json"
}
```

The first page must contain two semantic test-case evidence items from `tests/unit/code-mode-tool-validation.test.ts`, titled:

1. `rejects info and sdl.info as sdl.workflow actions`
2. `keeps sdl.info callable and discoverable in exclusive Code Mode`

Their evidence ranges must include the matching `Invalid sdl.workflow request` validation and `handlers.has("sdl.info")` assertion respectively. The response must exclude unrelated `createArtifact` and `weight` benchmark evidence, remain within 2,400 tokens, and serialize byte-identically across repeated calls and an unchanged reindex.

### Regression gates

- Existing kind filters and public `SymbolKind` schemas remain unchanged.
- Existing symbol/card, call-edge, overlay, provider-first, sync, determinism, and context tests pass.
- Persistence tests cover null and populated `testCaseJson`, ETags, shadow finalization, canonical integrity digests, and rebuild enforcement.
- Compact schemas, prompt-cache determinism fixtures, and public card documentation change together.
- Documentation states that the schema change requires a full reindex.

## Rollout

1. Add the facet, candidate contract, merge, persistence, integrity digest, search text, hydration, and rebuild enforcement.
2. Add the JavaScript/TypeScript detector and one declaration-oriented detector with parity fixtures.
3. Rebuild a disposable SDL-MCP graph and run the exact acceptance request.
4. Update public card/schema documentation, determinism fixtures, and release notes.
5. Add remaining language detectors independently behind the same stable model.

## Alternatives rejected

### Add a `test` SymbolKind

Rejected because kind describes structural syntax throughout SDL. Reclassifying functions and methods would break kind filters and lose useful structural information.

### Reuse only the broad `test` role tag

Rejected because every helper, fixture, type, and imported symbol in a test-like file can carry that tag. It cannot identify the actual case or provide an anonymous callback's source range.

### Put titles on module or file-summary records

Rejected because normal files do not necessarily produce module symbols, file summaries map back to narrow existing symbols, and neither form owns assertions inside callbacks.

### Create separate TestCase and TestSuite graph entities

Rejected for version 1. Separate nodes would require new storage, edges, hydration, ranking, serialization, and tool contracts. The optional symbol facet provides the required semantics through the existing graph.

### Add a source-chunk/RAG lane

Rejected for this finding. A chunk lane could help non-symbol prose more broadly, but it would add a parallel candidate and evidence model. Tests have stable syntax and benefit from precise ranges.

## Relationship to the focused-retrieval work

The earlier focused-retrieval changes remain useful for segment-safe focus paths, deterministic candidate partitioning, and dotted identifiers. This design supersedes only the module-title workaround: titles attach to actual test symbols instead of depending on a module symbol that most test files do not have.
