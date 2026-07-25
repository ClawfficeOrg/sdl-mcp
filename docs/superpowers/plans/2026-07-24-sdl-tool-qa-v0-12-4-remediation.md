# SDL Tool QA v0.12.4 Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents are explicitly requested) or superpowers:executing-plans to
> implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every finding in
`devdocs/qaplans/2026-07-24-sdl-tool-qa-live-v0-12-4.md` while preserving the
34-tool public surface, existing retrieval primitives, policy gates, concise
text fallbacks, and deterministic behavior outside explicitly session-scoped
refs and handles.

**Architecture:** Finalize `sdl.context` once, after evidence selection: choose
implementation symbols when the task explicitly asks for implementation,
select evidence bundles against the whole serialized-response budget, project
actions from that same selected set, and retain removed evidence behind the
existing workflow continuation store. Make stable repository and checkpoint
responses the default by avoiding volatile work and ID allocation unless the
caller opts in or work exists. Complete the MCP contract by describing existing
success shapes with Zod, normalizing output schemas to the SDK's required object
root, and adding `sdl.info` to the existing meta-action catalog.

**Tech Stack:** TypeScript, Node.js 24, `node:test`,
`@modelcontextprotocol/sdk@^1.29.0`, Zod, LadybugDB, PowerShell.

**Source findings:**
`devdocs/qaplans/2026-07-24-sdl-tool-qa-live-v0-12-4.md`

---

## Assumptions and guardrails

- Keep `sdl.info` public. Removing a useful, already advertised tool would fix
  catalog inconsistency by reducing capability and would be the wrong tradeoff.
- Keep `refsMode: "auto"` as the session-compaction default. Scope
  byte-stability to `refsMode: "off"` and non-handle responses instead of
  discarding the compaction feature.
- Do not redesign the context ranking pipeline. Add one generic
  implementation-intent alias rule, then reuse the existing evidence selector
  at the final response boundary.
- Do not add another MCP response envelope. Output schemas describe the
  structured success variants that handlers already return.
- The current MCP SDK requires an advertised `outputSchema` to have an object
  root. Successful `structuredContent` is validated against that schema;
  `isError` results retain the repository's generic structured error envelope
  and are not parsed as successful output.
- Dynamic continuation and response handles are intentionally session-scoped.
  Their responses are outside byte-stability guarantees and must say how to
  resume.
- Run all mutating tool-wire tests against disposable repositories, files, and
  LadybugDB databases. Do not refresh or edit the live `sdl-mcp` graph.
- Add short comments only where they explain a non-obvious ordering constraint,
  such as "select before render" or "return before checkpoint ID allocation."

## Acceptance matrix

| Finding | Required proof |
| --- | --- |
| Context implementation path | The report's runtime-query task returns `handleRuntimeQueryOutput`, `handleRuntimeExecute`, and implementation code evidence in precise and broad modes. |
| Context budget | `estimateTokens(JSON.stringify(result)) <= budget.maxTokens`; removed evidence has a resolvable continuation handle. |
| Context provenance | Every rendered action reference comes from `finalEvidence`; skeleton references use `symbol:` for symbol requests and `file:` only for repository-relative paths. |
| Stable status | Two unchanged full `repo.status` calls with `includeTelemetry: false` serialize identically and omit absolute paths, freshness, prefetch, runtime, and other operational fields. |
| Static no-op checkpoint | Two zero-candidate calls serialize identically, return `requested: false`, and contain no ID, counter, timestamp, zero-count, or null-status noise. |
| Determinism contract | Tests and docs require `refsMode: "off"` for byte comparison and explicitly exempt session refs and handles. |
| Output schemas | Raw `tools/list` reports object-root `outputSchema` for all 34 tools; real success results parse and error results retain structured, actionable errors. |
| `sdl.info` discovery | Exact action search and the full manual expose `sdl.info` without changing tool-list order or count. |

## File map

- Modify `src/agent/context-engine.ts`: prefer implementation aliases under
  explicit implementation intent, finalize evidence/actions/summary together,
  and enforce the whole-response budget.
- Modify `src/agent/evidence.ts` and `src/agent/executor.ts`: give skeleton
  evidence the correct `symbol:` or `file:` reference at the call site.
- Modify `src/agent/types.ts`: expose continuation metadata on truncated context
  results.
- Modify `src/code-mode/workflow-truncation.ts`: extract a small reusable
  continuation-storage function from the existing store.
- Modify `src/mcp/tools/repo.ts`: omit volatile status fields and expensive
  telemetry work unless `includeTelemetry` is true.
- Modify `src/live-index/checkpoint-service.ts`,
  `src/live-index/types.ts`, and `src/mcp/tools/buffer.ts`: return before
  checkpoint ID allocation when no candidate exists.
- Modify `src/mcp/tools.ts`: define the missing structured success schemas and
  update affected response types without changing handler payloads.
- Modify `src/gateway/compact-schema.ts` and `src/server.ts`: normalize every
  advertised output schema to an object root in both flat and gateway modes.
- Modify `src/mcp/tools/tool-descriptors.ts`: attach response schemas to the
  eight flat tools that currently omit them.
- Modify `src/mcp/tools/index.ts` and `src/code-mode/action-catalog.ts`: attach
  the `sdl.info` response schema and add it to the existing meta catalog.
- Modify focused unit/integration tests named below.
- Modify `docs/prompt-cache-hygiene.md`, generated tool inventory/reference
  output, and `CHANGELOG.md`.

## Chunk 1: Context Relevance, Provenance, and Budget

### Task 1: Prefer implementation symbols when the task asks for implementation

**Files:**

- Modify: `src/agent/context-engine.ts`
- Test: `tests/unit/agent/context-seeding-runtime.test.ts`
- Test: `tests/unit/agent/context-engine.test.ts`

- [ ] **Step 1: Add a failing implementation-intent regression**

Use the exact QA task:

```text
Diagnose why runtimeQueryOutput might fail to find a known term in a persisted
runtimeExecute artifact and identify the implementation path.
```

Cover both `contextMode: "precise"` and `contextMode: "broad"` with
`semantic: false`. Assert that the selected symbols include
`handleRuntimeQueryOutput` and `handleRuntimeExecute`; precise mode must not end
with only the identically named CLI action declarations.

- [ ] **Step 2: Build and confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/agent/context-seeding-runtime.test.ts `
  tests/unit/agent/context-engine.test.ts
```

Expected: the precise assertion fails because exact-name seeding resolves the
CLI declarations and never queries the conventional handler names.

- [ ] **Step 3: Add one generic implementation alias rule**

Reuse the existing identifier extraction and exact-symbol lookup. When the
inferred task intent explicitly asks for an implementation or handler, place
the conventional handler alias ahead of the declaration candidate:

```ts
function implementationAliases(identifier: string): string[] {
  return ["handle" + toPascalCase(identifier), identifier];
}
```

Use the repository's existing case-conversion helper if one exists. Do not add
runtime-specific names, prompt vocabulary, score bumps, or a second ranking
pipeline. Preserve explicit focus authority and deterministic ordering.

- [ ] **Step 4: Confirm GREEN**

Run the focused command from Step 2. Expected: both modes identify both
handlers; the existing non-implementation exact-name cases remain unchanged.

- [ ] **Step 5: Commit the selection fix**

```powershell
git add src/agent/context-engine.ts `
  tests/unit/agent/context-seeding-runtime.test.ts `
  tests/unit/agent/context-engine.test.ts
git commit -m "fix(context): resolve requested implementation handlers"
```

### Task 2: Give evidence one canonical reference and provenance set

**Files:**

- Modify: `src/agent/evidence.ts`
- Modify: `src/agent/executor.ts`
- Modify: `src/agent/context-engine.ts`
- Test: `tests/unit/agent/context-engine.test.ts`
- Test: `tests/unit/agent/evidence.test.ts`
- Test: `tests/unit/context-summary-enrichment.test.ts`

- [ ] **Step 1: Add failing reference and parity tests**

Add a focused `captureSkeleton` test proving that a symbol skeleton is
`symbol:<symbolId>` and a file skeleton is
`file:<repository-relative-path>`. Add a context test with selected and pruned
evidence that asserts exact set equality between references rendered under
Actions and the selected `finalEvidence` records assigned to those actions.
No selected action evidence
may be omitted, and no removed evidence may be cited.

Prefer asserting a structured reference list returned by an existing summary
helper. Parse prose only if no structured boundary exists.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/agent/evidence.test.ts `
  tests/unit/agent/context-engine.test.ts `
  tests/unit/context-summary-enrichment.test.ts
```

Expected: symbol skeletons use `file:<symbolId>`, and action references include
evidence that is absent from `finalEvidence`.

- [ ] **Step 3: Make the caller provide the evidence namespace**

Rename the `captureSkeleton` parameter from a path-like name to `reference`.
Pass `symbol:<symbolId>` from the symbol-skeleton branch and
`file:<filePath>` from the file-skeleton branch. Do not infer namespaces by
examining whether a string resembles a path.

- [ ] **Step 4: Project actions from selected evidence**

Add one pure helper near the existing evidence identity/deduplication helpers:

```ts
function projectActionsToEvidence(
  actions: Action[],
  selectedEvidence: Evidence[],
): Action[] {
  const selected = new Set(selectedEvidence.map(evidenceIdentityKey));
  return actions.map((action) => {
    const evidence = action.evidence.filter((item) =>
      selected.has(evidenceIdentityKey(item)),
    );
    return { ...action, evidence, evidenceCount: evidence.length };
  });
}
```

Generate `actionsTaken`, `summary`, and any action reference list from these
projected actions. Preserve an action with zero selected evidence so execution
history remains accurate, but do not render a reference to removed evidence.

- [ ] **Step 5: Confirm GREEN and commit**

Run the focused command from Step 2, then:

```powershell
git add src/agent/evidence.ts src/agent/executor.ts `
  src/agent/context-engine.ts `
  tests/unit/agent/evidence.test.ts `
  tests/unit/agent/context-engine.test.ts `
  tests/unit/context-summary-enrichment.test.ts
git commit -m "fix(context): align action and evidence provenance"
```


### Task 3: Enforce the budget at the final serialized-response boundary

**Files:**

- Modify: `src/agent/context-engine.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/code-mode/workflow-truncation.ts`
- Modify: `src/mcp/tools.ts` if the context response schema enumerates
  truncation metadata
- Test: `tests/unit/agent/context-engine.test.ts`
- Test: `tests/unit/context-wire-format.test.ts`
- Test: `tests/unit/context-response-artifacts.test.ts`
- Test: `tests/unit/code-mode-workflow-truncation.test.ts`

- [ ] **Step 1: Add the reported hard-budget regression**

Build a deterministic fixture whose highest-value bundles are the two runtime
handler cards plus a skeleton or hot path for each, followed by unrelated cards
from other lanes. Request `evidenceOptimization: "budgeted"` and
`budget.maxTokens: 2600`. Assert:

- both handlers and at least one implementation skeleton or hot path survive;
- unrelated late bundles are removed first;
- summary/action counts describe only retained evidence;
- the token estimator applied to the final serialized object is at most 2,600;
- truncation metadata includes a non-empty continuation handle; and
- `getContinuation(handle)` resolves the complete pre-truncation result; and
- at the minimum valid context budget, a continuation-only fallback still
  serializes within the cap, while one token below that minimum fails request
  validation.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/agent/context-engine.test.ts `
  tests/unit/context-wire-format.test.ts `
  tests/unit/context-response-artifacts.test.ts `
  tests/unit/code-mode-workflow-truncation.test.ts
```

Expected: the current code budgets evidence before adding the rest of the
response, slices evidence positionally, and can still serialize above the cap.

- [ ] **Step 3: Extract continuation storage without adding a new store**

Extract the ID allocation, bounded eviction, JSON serialization, and TTL write
inside `truncateStepResult` into a small exported function such as
`storeContinuation(result)`. Keep `truncateStepResult` on that same function so
workflow and context continuations share one store and retrieval action.

- [ ] **Step 4: Replace late positional slicing with one finalizer**

Generalize the existing global/budgeted evidence-selection path into one
`finalizeContextResult` boundary:

1. Build the complete untruncated result.
2. If it fits, return it unchanged and allocate no handle.
3. If it does not fit, store the complete result and include the fixed-size
   continuation metadata in the base envelope.
4. Compute the evidence allowance from
   `maxTokens - estimateTokens(baseEnvelope)`.
5. Select whole evidence bundles with the existing value-per-token selector.
6. Project actions, regenerate summary/answer, and serialize again.
7. If estimator rounding leaves the result over budget, remove the
   lowest-ranked remaining bundle and repeat steps 5-6.
8. If no bundle remains and the normal base envelope still exceeds the cap,
   return a minimal, truthful continuation-only `ContextResult` with empty
   actions/evidence rather than returning an oversized response.

Set `AgentContextBudgetSchema.maxTokens` and its alias to a 512-token minimum,
and assert that the fixed continuation-only envelope fits below that bound with
headroom. Reject smaller requests as validation errors. Delete or stop calling
the positional `finalEvidence.slice(...)` branch. Do not
claim skeleton/hot-path counts for evidence that was removed. Keep a short
comment explaining that continuation metadata participates in the budget.

Use this truncation shape:

```ts
truncation: {
  originalTokens,
  truncatedTokens,
  fieldsAffected,
  continuationHandle,
  continuationAction: "workflowContinuationGet",
}
```

- [ ] **Step 5: Confirm GREEN across all context regressions**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/agent/context-seeding-runtime.test.ts `
  tests/unit/agent/context-engine.test.ts `
  tests/unit/agent/evidence.test.ts `
  tests/unit/context-summary-enrichment.test.ts `
  tests/unit/context-wire-format.test.ts `
  tests/unit/context-response-artifacts.test.ts `
  tests/unit/code-mode-workflow-truncation.test.ts
```

- [ ] **Step 6: Commit the finalization boundary**

```powershell
git add src/agent/context-engine.ts src/agent/types.ts `
  src/code-mode/workflow-truncation.ts src/mcp/tools.ts `
  tests/unit/agent/context-engine.test.ts `
  tests/unit/context-wire-format.test.ts `
  tests/unit/context-response-artifacts.test.ts `
  tests/unit/code-mode-workflow-truncation.test.ts
git commit -m "fix(context): enforce whole-response token budgets"
```

## Chunk 2: Stable Default Responses

### Task 4: Gate volatile repository status behind explicit telemetry

**Files:**

- Modify: `src/mcp/tools/repo.ts`
- Modify: `src/mcp/tools.ts` only if optional response fields need correction
- Test: `tests/unit/server-unit.test.ts`
- Test: `tests/unit/context-response-projection.test.ts`
- Test: `tests/integration/determinism.test.ts`

- [ ] **Step 1: Add failing stable/telemetry response tests**

Freeze graph state but vary mocked freshness, prefetch counters, latency, and
runtime version between two calls. For `detail: "full"` with
`includeTelemetry: false`, assert exact serialized equality and absence of:

```text
rootPath
healthComponents.freshness
prefetchStats
serverInfo
diagnostics/timings
wall-clock timestamps and machine-specific absolute paths
```

Assert that safety-relevant stable fields remain: repository ID, root
availability status, latest version, indexed counts, watcher state,
derived-state staleness, and graph-integrity state/version/digest. Add a
separate `includeTelemetry: true` assertion that retains the operational
fields.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/server-unit.test.ts `
  tests/unit/context-response-projection.test.ts `
  tests/integration/determinism.test.ts
```

- [ ] **Step 3: Avoid volatile work when telemetry is disabled**

Make `includeTelemetry` the gate for the expensive health-component loader,
prefetch statistics, runtime information, absolute root path, live-index
operational fields, and diagnostics. Let `detail` control only the breadth of
stable status. Build the response conditionally instead of populating volatile
fields and deleting them after serialization.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused command from Step 2, then:

```powershell
git add src/mcp/tools/repo.ts src/mcp/tools.ts `
  tests/unit/server-unit.test.ts `
  tests/unit/context-response-projection.test.ts `
  tests/integration/determinism.test.ts
git commit -m "fix(repo): make status output stable by default"
```

### Task 5: Return a static checkpoint no-op before allocating an ID

**Files:**

- Modify: `src/live-index/checkpoint-service.ts`
- Modify: `src/live-index/types.ts`
- Modify: `src/mcp/tools/buffer.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/unit/checkpoint-service.test.ts`
- Test: `tests/unit/mcp-buffer-tool.test.ts`
- Test: `tests/integration/explicit-checkpoint-api.test.ts`

- [ ] **Step 1: Add a failing exact no-op regression**

Call checkpoint twice with no eligible or pending buffers. Assert deep equality
with this minimal response:

```ts
{
  repoId,
  requested: false,
  pending: false,
  message: "No checkpoint-eligible buffers were pending.",
}
```

Assert that neither call increments the checkpoint counter, updates
`lastCheckpointAt`, marks checkpoint work in progress, or returns
`checkpointId`, zero counters, timestamps, or null status.

Add a second case with dirty drafts but zero eligible candidates. It must return
a stable no-ID result with `pending: true`, the actionable pending count/reason,
and no checkpointed/failed counters or timestamps.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/checkpoint-service.test.ts `
  tests/unit/mcp-buffer-tool.test.ts `
  tests/integration/explicit-checkpoint-api.test.ts
```

- [ ] **Step 3: Move the no-candidate branch before state mutation**

Preserve the existing in-progress concurrency guard first. Then list candidates
and current drafts. Use the minimal `pending: false` result only when both are
empty. When candidates are empty but dirty drafts remain, return the separate
stable `pending: true` no-ID variant. Both branches return before allocating a
wall-clock ID or mutating checkpoint status. Keep the normal
requested-result shape for real work. Model the service result as a small
discriminated union, or make work-only fields optional if that yields a smaller
diff; do not add a wrapper envelope.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused command from Step 2, then:

```powershell
git add src/live-index/checkpoint-service.ts src/live-index/types.ts `
  src/mcp/tools/buffer.ts src/mcp/tools.ts `
  tests/unit/checkpoint-service.test.ts `
  tests/unit/mcp-buffer-tool.test.ts `
  tests/integration/explicit-checkpoint-api.test.ts
git commit -m "fix(buffer): keep empty checkpoints static"
```

### Task 6: Make the determinism scope executable and explicit

**Files:**

- Modify: `tests/integration/determinism.fixtures.json`
- Modify: `tests/integration/determinism.test.ts`
- Modify: `docs/prompt-cache-hygiene.md`

- [ ] **Step 1: Add the contract regression**

Set `refsMode: "off"` on context calls included in the byte-stability matrix.
Add a separate assertion proving `refsMode: "auto"` may compact repeated
evidence to `{ ref, unchanged: true }` and is intentionally not byte-compared.
Likewise exclude response-artifact and continuation-handle payloads with a
concrete session-state reason.

- [ ] **Step 2: Document the same boundary**

State that tool names, descriptions, schemas, ordering, and non-session response
content remain byte-stable against an unchanged index. State that callers and
tests requiring byte equality must use `refsMode: "off"` and inline,
non-continuation responses.

- [ ] **Step 3: Run and commit the determinism contract**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/integration/determinism.test.ts
git add tests/integration/determinism.fixtures.json `
  tests/integration/determinism.test.ts docs/prompt-cache-hygiene.md
git commit -m "docs(cache): scope deterministic context refs"
```


## Chunk 3: Complete MCP Output Contracts and Catalog Discovery

### Task 7: Normalize advertised output schemas to an object root

**Files:**

- Modify: `src/gateway/compact-schema.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/compact-schema.test.ts`
- Test: `tests/unit/tool-registration.test.ts`

- [ ] **Step 1: Add a failing flat-mode union-schema test**

Register a tool whose response schema is a Zod union of object variants. Inspect
raw `tools/list` and assert:

```ts
assert.equal(tool.outputSchema?.type, "object");
assert.equal("anyOf" in tool.outputSchema, false);
assert.equal("oneOf" in tool.outputSchema, false);
assert.equal("allOf" in tool.outputSchema, false);
```

Keep the existing gateway compact-schema assertions.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/compact-schema.test.ts `
  tests/unit/tool-registration.test.ts
```

- [ ] **Step 3: Reuse the existing root normalizer for output only**

Export the existing object-root normalization helper from
`src/gateway/compact-schema.ts`. In `src/server.ts`, run raw flat-mode
`outputSchema` conversion through that helper; keep input-schema conversion
unchanged. Gateway mode continues to use the compact converter, which already
normalizes the root.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused command from Step 2, then:

```powershell
git add src/gateway/compact-schema.ts src/server.ts `
  tests/unit/compact-schema.test.ts `
  tests/unit/tool-registration.test.ts
git commit -m "fix(mcp): normalize output schema roots"
```

### Task 8: Advertise the existing overview, code-window, and file result shapes

**Files:**

- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/tool-descriptors.ts`
- Modify: `src/mcp/tools/file-read.ts` only if its exported result type must be
  derived from the schema
- Modify: `src/mcp/tools/file-write.ts` only if its exported result type must be
  derived from the schema
- Test: `tests/unit/tool-descriptors.test.ts`
- Test: `tests/unit/tool-registration.test.ts`
- Add: `tests/unit/mcp-output-schemas.test.ts`

- [ ] **Step 1: Add failing descriptor and response-shape tests**

Require `outputSchema` for:

- `sdl.repo.overview`
- `sdl.code.needWindow`
- `sdl.file.read`
- `sdl.file.write`

Parse representative inline and artifact success variants through the source
Zod schemas. Include the approved/denied/artifact code-window variants and the
full/not-modified overview variants.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/mcp-output-schemas.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts
```

- [ ] **Step 3: Compose schemas from existing variants**

Attach the existing `RepoOverviewResponseSchema` and
`CodeNeedWindowResponseSchema`. Define `FileReadResponseSchema` and
`FileWriteResponseSchema` in `src/mcp/tools.ts` from their current inline result
fields plus the existing response-artifact schema. Do not change handler output
keys to make schema authoring easier.

- [ ] **Step 4: Remove only the four resolved omission entries**

Delete these tools from the intentional-output-schema omission maps in
`tool-descriptors.test.ts` and `tool-registration.test.ts`. Keep unresolved
entries until Task 9 proves their schemas.

- [ ] **Step 5: Confirm GREEN and commit**

Run the focused command from Step 2, then:

```powershell
git add src/mcp/tools.ts src/mcp/tools/tool-descriptors.ts `
  src/mcp/tools/file-read.ts src/mcp/tools/file-write.ts `
  tests/unit/mcp-output-schemas.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts
git commit -m "feat(mcp): describe overview code and file outputs"
```

Omit unchanged optional handler files from `git add`.

### Task 9: Advertise edit and semantic-enrichment result shapes

**Files:**

- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/tool-descriptors.ts`
- Modify: edit or semantic handlers only if compile-time result annotations
  reveal an existing schema/implementation mismatch
- Test: `tests/unit/mcp-output-schemas.test.ts`
- Test: `tests/unit/tool-descriptors.test.ts`
- Test: `tests/unit/tool-registration.test.ts`
- Test: `tests/integration/search-edit-tool.test.ts`

- [ ] **Step 1: Add failing schema coverage**

Require `outputSchema` and parse every existing success variant for:

- `sdl.symbol.edit`
- `sdl.search.edit`
- `sdl.semantic.enrichment.refresh`
- `sdl.semantic.enrichment.status`

Cover preview, apply, and artifact edit results; cover dry-run/disabled and
enabled semantic results. Reuse shared plan, snippet, artifact, selection, and
run schemas instead of restating their fields.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/mcp-output-schemas.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts `
  tests/integration/search-edit-tool.test.ts
```

- [ ] **Step 3: Define and attach the four schemas**

Keep schema definitions in `src/mcp/tools.ts` as required by the MCP layer
convention. Root unions are acceptable in Zod because Task 7 flattens their
advertised JSON Schema root. Do not introduce a generic "tool result" envelope
or weaken known nested records to unbounded `z.unknown()`.

- [ ] **Step 4: Clear the resolved omission entries, confirm GREEN, and commit**

Run the focused command from Step 2, then:

```powershell
git add src/mcp/tools.ts src/mcp/tools/tool-descriptors.ts `
  tests/unit/mcp-output-schemas.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts `
  tests/integration/search-edit-tool.test.ts
git commit -m "feat(mcp): describe edit and semantic outputs"
```

### Task 10: Add `sdl.info` to the existing catalog and complete wire coverage

**Files:**

- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/index.ts`
- Modify: `src/code-mode/action-catalog.ts`
- Modify: `tests/unit/code-mode-catalog.test.ts`
- Modify: `tests/unit/tool-registration.test.ts`
- Add: `tests/integration/mcp-output-schema-wire.test.ts`

- [ ] **Step 1: Add failing catalog and schema tests**

Assert that:

- raw `tools/list` still contains exactly one `sdl.info`;
- `sdl.info` advertises an object-root output schema;
- exact action search for
  `sdl.info server information version capabilities` ranks `info` first; and
- the full manual contains the `sdl.info` action and schema.

- [ ] **Step 2: Confirm RED**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/code-mode-catalog.test.ts `
  tests/unit/tool-registration.test.ts
```

- [ ] **Step 3: Describe and catalog the existing info result**

Define `InfoResponseSchema` from the current `InfoReport` shape. Pass it to the
existing special `server.registerTool("sdl.info", ...)` call. Add `info` to the
existing meta-action schema, description, example, tag, and definition maps in
`src/code-mode/action-catalog.ts`; do not move the tool to a second registration
path or reorder the flat tool list. Preserve active-tool filtering so exclusive Code
Mode does not advertise `sdl.info` when that mode intentionally omits the raw
tool.

- [ ] **Step 4: Add table-driven success and error wire tests for all nine tools**

Use a disposable repository/database and safe preview or dry-run calls. For
each of the nine tools from the QA report:

- assert the success call returns concise non-empty text;
- parse `structuredContent` with the source success schema;
- make one safe invalid, missing, or expired call;
- assert `isError: true`, concise actionable text, and the generic structured
  error object; and
- do not parse an error object with the success schema because the MCP SDK
  intentionally skips output-schema validation for `isError` results.

The file-write case must target a disposable file. Edit cases must preview or
operate only inside the disposable fixture.

- [ ] **Step 5: Assert complete raw tool coverage**

Replace the "proven plus intentional omissions" split with an assertion that
all 34 advertised structured tools have object-root output schemas. Preserve
the exact tool ordering assertion and update
`tests/integration/determinism.fixtures.json` for intentional contract changes.

- [ ] **Step 6: Confirm GREEN and commit**

```powershell
npm.cmd run build:all
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/mcp-output-schemas.test.ts `
  tests/unit/code-mode-catalog.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts `
  tests/integration/mcp-output-schema-wire.test.ts `
  tests/integration/search-edit-tool.test.ts `
  tests/integration/mcp-runtime-tool.test.ts
git add src/mcp/tools.ts src/mcp/tools/index.ts `
  src/code-mode/action-catalog.ts `
  tests/unit/code-mode-catalog.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts `
  tests/integration/mcp-output-schema-wire.test.ts `
  tests/integration/determinism.fixtures.json
git commit -m "feat(mcp): complete output schemas and info discovery"
```


## Chunk 4: Documentation and End-to-End Acceptance

### Task 11: Regenerate public tool documentation and record the behavior change

**Files:**

- Modify: `docs/prompt-cache-hygiene.md` if Task 6 did not complete all wording
- Modify: `docs/mcp-tools-reference.md` or its checked source when required by
  the generator/checker
- Generate: `docs/generated/tool-inventory.json`
- Generate: `docs/generated/tool-inventory.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update public behavior documentation**

Document:

- stable `repo.status` fields versus `includeTelemetry: true`;
- the minimal no-op checkpoint result;
- whole-response context budget enforcement, the 512-token request minimum, and
  continuation retrieval;
- implementation-intent behavior in precise context;
- `refsMode: "off"` for byte-stability checks; and
- 34-of-34 output-schema coverage plus `sdl.info` discovery.

Keep operational telemetry out of examples unless the example explicitly asks
for it.

- [ ] **Step 2: Regenerate, do not hand-edit, generated inventory**

```powershell
npm.cmd run docs:tools:generate
npm.cmd run docs:tools:check
```

Inspect the diff. Expected: `sdl.info` appears in catalog-derived references,
and all 34 tool inventory records report output schemas. If a checked
non-generated reference is stale, update its source and rerun generation.

- [ ] **Step 3: Add an Unreleased changelog entry**

Describe user-visible fixes under the repository's existing headings. Mention
the narrowed prompt-cache contract for refs/handles so the behavior change is
not hidden.

- [ ] **Step 4: Commit documentation**

```powershell
git add docs/prompt-cache-hygiene.md docs/mcp-tools-reference.md `
  docs/generated/tool-inventory.json docs/generated/tool-inventory.md `
  CHANGELOG.md
git commit -m "docs: record SDL tool QA remediations"
```

Omit any unchanged path from `git add`.

### Task 12: Run the complete acceptance gate on a fresh server

**Files:**

- Verify: all files changed in Tasks 1-11
- Verify: `devdocs/qaplans/2026-07-24-sdl-tool-qa-live-v0-12-4.md`

- [ ] **Step 1: Run fresh static and focused verification**

```powershell
npm.cmd run build:all
npm.cmd run typecheck
npm.cmd run lint
node --experimental-strip-types --test-concurrency=1 --test `
  tests/unit/agent/context-seeding-runtime.test.ts `
  tests/unit/agent/context-engine.test.ts `
  tests/unit/agent/evidence.test.ts `
  tests/unit/context-summary-enrichment.test.ts `
  tests/unit/context-response-projection.test.ts `
  tests/unit/context-wire-format.test.ts `
  tests/unit/context-response-artifacts.test.ts `
  tests/unit/code-mode-workflow-truncation.test.ts `
  tests/unit/checkpoint-service.test.ts `
  tests/unit/mcp-buffer-tool.test.ts `
  tests/unit/server-unit.test.ts `
  tests/unit/compact-schema.test.ts `
  tests/unit/mcp-output-schemas.test.ts `
  tests/unit/code-mode-catalog.test.ts `
  tests/unit/tool-descriptors.test.ts `
  tests/unit/tool-registration.test.ts `
  tests/integration/explicit-checkpoint-api.test.ts `
  tests/integration/determinism.test.ts `
  tests/integration/mcp-output-schema-wire.test.ts `
  tests/integration/search-edit-tool.test.ts `
  tests/integration/mcp-runtime-tool.test.ts
npm.cmd run docs:tools:check
npm.cmd run test:golden
```

Expected: zero failed tests, zero type or lint errors, generated docs current,
and golden MCP responses accepted.

- [ ] **Step 2: Run the full repository suite**

```powershell
npm.cmd test
```

Do not treat the focused matrix as proof for unrelated server registrations or
response projections. Record the exact pass, fail, and skip counts.

- [ ] **Step 3: Start a fresh built server**

Stop the implementation test server and start a new process from the just-built
`dist/`. The existing MCP connection may retain pre-change modules and cannot
serve as live acceptance evidence.

- [ ] **Step 4: Repeat the exact context probe in both modes**

For precise and broad calls, use the report's task, `semantic: false`,
`refsMode: "off"`, `evidenceOptimization: "budgeted"`, and
`budget.maxTokens: 2600`. Verify:

- both runtime handlers are present;
- at least one implementation skeleton or hot path is present;
- unrelated structural-search, stress-test, SCIP, benchmark, and
  graph-integrity cards do not displace the implementation path;
- final serialized tokens are at most 2,600;
- action and final-evidence references have exact parity; and
- any truncated response has a continuation handle that retrieves the removed
  evidence.

- [ ] **Step 5: Repeat stable response probes**

Call full `repo.status` twice with `includeTelemetry: false` and compare exact
serialized bytes. Confirm the prohibited volatile fields are absent. Call it
once with `includeTelemetry: true` to prove the operational path still works.

With zero pending buffers, call checkpoint twice and compare exact serialized
bytes. Confirm `requested: false` and absence of checkpoint IDs, counters,
timestamps, zeros, and null status.

- [ ] **Step 6: Repeat catalog and wire probes**

Inspect raw `tools/list`: expect 34 tools and 34 object-root output schemas.
Search for the exact `sdl.info` query and inspect the full manual: both must
expose `sdl.info`. Check one structured success and one structured error through
the raw MCP wire and confirm concise text remains present.

- [ ] **Step 7: Inspect the final diff and request review**

```powershell
git diff --check
git status --short --branch
git diff --stat
```

Map every QA acceptance bullet to fresh evidence from Steps 1-6. Request a
focused code review of the context finalization boundary, output-schema
strictness, and checkpoint concurrency ordering. Resolve blockers and rerun
affected checks before merging.
