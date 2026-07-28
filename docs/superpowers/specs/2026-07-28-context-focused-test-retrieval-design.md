# Context Focused Test Retrieval Design

**Date:** 2026-07-28  
**Status:** Approved

## Problem

`sdl.context` misinterprets a broad directory focus as exact evidence. The verified-graph request below returns `createArtifact` from `tests/benchmark/background-graph-integrity.test.ts` and `weight` from `tests/benchmark/beam-parallel.test.ts` as Tier 0 while omitting `tests/unit/code-mode-tool-validation.test.ts`:

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

The response is byte-stable, so the defect is deterministic rather than timing-dependent.

Two independent gaps produce the result:

1. `resolveFocusPathSymbolHits` expands `tests` as a directory prefix. `allocateFocusPathSymbols` sorts matched paths and symbol IDs, then promotes the first budget-sized slice to Tier 0. Alphabetical position, not task relevance, selects the two benchmark symbols.
2. JS and TS module search metadata omits static `describe`, `it`, and `test` titles. The desired contract exists in test-title string literals near the end of `code-mode-tool-validation.test.ts`, so neither symbol FTS nor file-summary retrieval sees the strongest lexical evidence. Hot-path extraction also matches AST identifiers only and falls back to the module start for dotted literals such as `sdl.info`.

The previous rank-first Tier 1 admission change cannot correct either gap because both occur before Tier 1 admission.

## Decision

### Separate exact-file focus from directory scope

Exact file paths remain authoritative. When a normalized focus path equals one indexed file path, that file's eligible symbols may enter the existing bounded Tier 0 allocation.

Directory prefixes remain soft scope. They must not create `exactIdentifier` candidates or receive Tier 0 solely from path and symbol-ID ordering. The preference is deliberately bounded to the existing fused candidate pool: directory focus does not widen lane limits, rerun retrieval, or pull a lower-ranked candidate into the pool.

After fusion, PPR, overlay resolution, and repository-relative path resolution, candidate rows use this stable partition:

1. existing exact-file or exact-symbol pins, in their existing order;
2. unpinned candidates whose normalized path equals or falls under any normalized directory prefix, in their existing fused order; and
3. remaining unpinned candidates, in their existing fused order.

The engine then assigns final one-based ranks from that order. Scores, source ranks, provenance, within-partition relevance, the existing fused candidate limit, test filtering, overlay filtering, and symbol-ID tie-breakers remain unchanged.

A missing focus path has no effect. Multiple directory prefixes match by union. A path that exactly names an indexed file uses exact-file behavior even if it is also under a supplied directory prefix.

### Index static JS and TS test titles on module symbols

One shared TypeScript-side collector runs once per eligible JS or TS test file in `buildSymbolAndEdgeRows`, where native and TypeScript fallback extraction already converge and source content is available. It uses the existing TypeScript compiler API to inspect call expressions; no Rust change, second retrieval lane, new dependency, or new database field is required.

The collector accepts calls whose callee is `describe`, `it`, or `test`, including direct `.only`, `.skip`, and `.todo` variants. The first argument must be a quoted string or a template literal without substitutions. Dynamic titles, empty titles, and other call shapes are ignored.

For each accepted title, the collector:

1. collapses consecutive JavaScript whitespace characters to one ASCII space and trims the result;
2. truncates to 256 Unicode code points;
3. removes exact case-sensitive duplicates after truncation while preserving the first occurrence; and
4. appends titles in source order until either 64 titles or 2,048 Unicode code points of title text have been retained. If the final title would cross the total bound, it is truncated to the remaining code-point allowance and collection stops.

Retained titles join with one newline and append to the containing module symbol's existing `searchText`. Files without a module symbol keep ordinary search metadata. The enrichment does not create synthetic symbols, alter symbol IDs, change graph edges, or alter non-module search text. Because it runs after both parsers converge, native and TypeScript fallback indexing use the same collector and must produce byte-identical module search metadata.

### Preserve dotted query terms for literal hot paths

Query normalization separately retains qualified dotted terms matching the ASCII grammar `[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+`, such as `sdl.info` and `sdl.workflow`. It scans `taskText` left to right first, then scans each `chatMentions` entry left to right in caller-supplied array order. Terms preserve that combined first-occurrence order, remove exact case-sensitive duplicates, truncate to 128 Unicode code points, and stop after 16 retained terms.

Hot-path rendering keeps the existing AST-identifier matching and additionally matches retained dotted terms as exact, case-sensitive source substrings within the selected symbol range. Literal matching only anchors evidence after retrieval selects a symbol. It does not scan the repository or create a query-time filesystem search lane. When no AST or dotted-literal term matches, the existing symbol-start fallback remains unchanged.

## Components and Data Flow

1. Context request normalization keeps the public `focusPaths` schema unchanged and classifies each resolvable path as an exact indexed file or a directory prefix.
2. Exact file hits feed the existing bounded Tier 0 allocation. Directory prefixes do not feed exact-identifier resolution.
3. Hybrid lanes, RRF, and PPR produce the existing bounded fused pool.
4. Candidate search resolves repository-relative paths, applies the exact-pins/in-scope/out-of-scope stable partition, and assigns final ranks without changing scores.
5. During indexing, shared symbol-row construction extracts bounded static test titles once per eligible JS or TS test file and appends them to the existing module `searchText`.
6. Symbol FTS and vector/file-summary lanes otherwise run as they do today. Test-title metadata gives the desired module lexical evidence to enter the ordinary fused pool.
7. Selection applies the existing Tier 0 and rank-first Tier 1 budget rules.
8. Hydration uses bounded dotted terms to center module hot paths on relevant title or assertion lines.

## Alternatives

### Extract synthetic test symbols

Synthetic symbols would give every test an exact range and independent graph identity. They would also change symbol counts, call ownership, graph edges, embeddings, and parser behavior across native and fallback paths. That churn is unnecessary for this retrieval defect.

### Scan focused files at query time

A bounded repository grep could find the exact literals without rebuilding the graph. It would introduce filesystem scanning into context retrieval, weaken snapshot consistency, and make latency depend on directory size. The existing graph-backed retrieval boundary should remain intact.

### Keep directory focus as Tier 0 and rank its symbols by query

The engine could run another relevance pass over every symbol under the prefix before Tier 0 allocation. That duplicates retrieval and remains expensive for broad paths. Soft path preference lets the existing hybrid retrieval rank the same evidence once.

### Oversample focused directories

The engine could widen every retrieval lane whenever a directory focus is present, then partition the larger pool. That increases query cost and still requires an arbitrary oversampling factor. The bounded existing-pool preference is sufficient once test titles provide the missing lexical evidence; oversampling should be considered only if measured acceptance cases still omit relevant in-scope candidates before fusion.

## Error Handling and Limits

- Invalid or missing focus paths remain non-fatal and contribute no preference.
- Dynamic test titles contribute no lexical metadata.
- Test-title extraction failures fall back to ordinary module search metadata and are logged with repository-relative file context; indexing must not fail solely because title enrichment is unavailable.
- Test-title metadata and dotted query terms use the fixed deterministic bounds above and add no configuration.
- Search metadata changes require a fresh or incremental re-index before live acceptance.
- Response schemas, object key order, source scores, source-rank evidence, and serialization remain unchanged.

## Verification

### Focus-path contracts

- An exact file focus retains bounded Tier 0 authority.
- A directory focus does not promote alphabetically early symbols to `exactIdentifier` or Tier 0.
- The bounded fused pool partitions exact pins, in-scope candidates, and out-of-scope candidates in that order while preserving each partition's prior order and score metadata.
- Directory focus does not change source-lane or fusion limits.
- Multiple prefixes, nonexistent paths, overlays, and `includeTests` behavior remain deterministic.

### Test-title metadata contracts

- Shared symbol-row construction adds static `describe`, `it`, and `test` titles to JS and TS module search metadata for both native and TypeScript fallback input.
- `.only`, `.skip`, and `.todo` variants work.
- Dynamic titles and files without module symbols fall back cleanly.
- Whitespace normalization, case-sensitive deduplication, per-title truncation, the 64-title limit, and the 2,048-code-point total limit produce stable output.
- The same bounded fixture produces byte-identical native-path and TypeScript-fallback module `searchText`.
- Symbol IDs, non-module search text, and graph edges do not change because of title metadata.

### Hot-path contracts

- Dotted terms remain available after query normalization with the fixed count and length bounds.
- A selected module containing `sdl.info` and `sdl.workflow` centers its hot-path evidence on exact literal lines for both terms.
- Ordinary AST identifier matching and symbol-start fallback remain unchanged.

### Live acceptance

Build the runtime, index a disposable current checkout, and wait for `graphIntegrityState: "verified"` with clean derived state. Run the exact request from the Problem section twice with `refsMode: "off"`.

Both responses must be byte-identical and must:

- include `tests/unit/code-mode-tool-validation.test.ts`;
- include evidence from that file covering both the `sdl.info` top-level registration assertion and the assertion that an `sdl.workflow` step using `info` or `sdl.info` is rejected as an unknown or disallowed workflow function;
- exclude `createArtifact` and the benchmark `weight` symbol;
- avoid reporting the desired contract test as budget-omitted; and
- remain within the 2,400-token budget.

Focused unit and integration tests, build, typecheck, lint, documentation checks, and prompt-cache determinism checks must pass before merge.

## Documentation

Update the context documentation to distinguish exact-file focus from bounded soft directory scope and to state that static JS and TS test titles participate in lexical retrieval:

- `docs/feature-deep-dives/agent-context.md`
- `docs/feature-deep-dives/context-modes.md`

No public schema or configuration documentation changes are required.
