# Ordinary Test Context-Quality Exclusion Design

## Goal

Keep `npm test` green without weakening the immutable context-quality benchmark.

## Design

Exclude `tests/benchmark/context-quality.test.ts` in the generic
`scripts/run-tests.mjs` file selection. The dedicated scheduled workflow invokes
the benchmark directly with its pinned checkout, graph, and SHA, so it remains
unchanged.

Add a source-contract unit test that requires the exclusion. Do not update the
pinned corpus SHA or alter direct benchmark execution.

