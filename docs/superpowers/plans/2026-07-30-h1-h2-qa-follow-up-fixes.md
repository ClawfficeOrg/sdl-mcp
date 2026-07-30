# H1/H2 QA Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public `sdl.workflow` schema match its accepted request schema and make provider-first semantic precision accurate and availability-preserving across LadybugDB persistence.

**Architecture:** Reuse `WorkflowRequestSchema` as the only workflow input-schema authority. Compute successful provider-first run precision from existing coverage facts with `computeSemanticPrecisionScore`, store missing scores as null, and preserve null through active reads and shadow copies.

**Tech Stack:** TypeScript, Zod, MCP TypeScript SDK, LadybugDB, Node.js built-in test runner.

---

## Chunk 1: Workflow schema parity

### Task 1: Advertise every accepted workflow control

**Files:**
- Modify: `tests/unit/tool-registration.test.ts`
- Modify: `src/code-mode/index.ts`
- Modify if fixture validation requires it: `tests/integration/determinism.fixtures.json`

- [x] Add an in-memory SDK regression that deep-compares `client.listTools()`'s `sdl.workflow.inputSchema` with `buildCompactJsonSchema(WorkflowRequestSchema)`, including nested `steps[].maxResponseTokens`.
- [x] Run the focused test and confirm it fails because the current handwritten wire schema is incomplete.
- [x] Replace the handwritten workflow wire schema with `buildCompactJsonSchema(WorkflowRequestSchema)`.
- [x] Rerun the focused registration, Code Mode validation, and determinism tests; refresh only the intentional workflow fixture if required.

## Chunk 2: Provider-first precision and nullable persistence

### Task 2: Compute precision for successful provider-first runs

**Files:**
- Modify: `tests/unit/provider-first-indexing.test.ts`
- Modify: `src/indexer/provider-first/provenance.ts`

- [x] Change the provider-fact regression to expect `0.875`, assert every mapped input, and add a failed/skipped run whose score stays undefined.
- [x] Run the focused test and confirm it fails because `precisionScore` is undefined.
- [x] For coverage facts matching the run's repo, generation, provider type, and provider ID, call `computeSemanticPrecisionScore` only when `run.status === "succeeded"` with: files `coverage.length/run.fileCount`; symbols `sum(emittedSymbols)/sum(totalSymbols)`; resolved edges `sum(totalResolvedReferences - callProofUnavailableReferences)/sum(totalResolvedReferences)`; diagnostics available when any `diagnosticCoverage !== "none"`; pass-2 skipped files where `legacyFallback === "skip"` over `run.fileCount`. Existing scorer zero-denominator and clamping behavior remains authoritative.
- [x] Rerun the focused provider-first test.

### Task 3: Preserve unavailable precision through LadybugDB

**Files:**
- Modify: `tests/unit/ladybug-semantic-queries.test.ts`
- Modify: `tests/unit/provider-first-indexing.test.ts`
- Modify: `src/db/ladybug-semantic.ts`
- Modify: `src/db/ladybug-shadow-finalization.ts`

- [x] Add an isolated LadybugDB round-trip regression proving an omitted score remains unavailable, a populated score remains numeric, and updating populated to omitted stores raw null.
- [x] Extend shadow-finalization coverage to copy and assert null, literal zero, and a nonzero score.
- [x] Run both tests and confirm the current zero coercions fail them.
- [x] Persist absent scores as null and map database null back to undefined.
- [x] Make the shadow copy row nullable, remove its zero coalescing, and copy null/numeric values unchanged; do not add a schema migration.
- [x] Rerun the LadybugDB, provider-first, and semantic projection regressions.

## Chunk 3: Documentation and verification

### Task 4: Close the QA hypotheses with evidence

**Files:**
- Modify: `devdocs/qaplans/2026-07-29-sdl-tool-qa-live-v0-12-4.md`
- Verify/update if required: `tests/integration/determinism.fixtures.json`

- [x] Promote H1/H2 from hypotheses to verified and remediated findings; record the regression boundaries and note graph-version freshness remains separate.
- [x] Run focused tests for tool registration, workflow execution, semantic enrichment, Ladybug semantic queries, provider-first indexing, shadow finalization, and determinism.
- [x] Run typecheck, lint, build, golden tests, `npm test`, and `git diff --check`.
- [x] Request independent spec-compliance, code-quality, and LadybugDB reviews; address all critical or important findings.
