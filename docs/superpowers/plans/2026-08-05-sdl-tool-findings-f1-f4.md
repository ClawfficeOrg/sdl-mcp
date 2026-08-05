# SDL Tool QA Findings F1-F4 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow failures unmistakable, keep graph admission fail-closed with actionable recovery, reject unavailable exact focus paths, and expose useful isolated-runner diagnostics.

**Architecture:** Patch the existing shared boundaries instead of adding a framework: the MCP response envelope owns error classification, public graph admission owns recovery detection, ContextEngine owns authoritative focus-path availability, and the isolated runner owns child-tool preflight. Each finding gets a focused red-green cycle and a small commit.

**Tech Stack:** TypeScript ESM, Node.js `node:test`, MCP TypeScript SDK, Zod, LadybugDB integration fixtures, JavaScript ESM runner.

---

## File map

- `src/server.ts`: classify top-level and nested workflow error payloads; attach workflow-specific graph recovery.
- `src/mcp/public-graph-retrieval-admission.ts`: detect refresh-before-graph workflow order without weakening admission.
- `src/context/engine.ts`: record exact focus files with no symbols and stop unrelated candidate retrieval.
- `src/context/types.ts`: add the focus-path-unavailable error code to the public result union.
- `src/mcp/tools.ts`: add the new code to the MCP output schema.
- `scripts/run-isolated-mutating-qa.mjs`: preflight top-level MCP tools and format child errors.
- Existing focused unit and integration tests receive regressions; do not create parallel helper abstractions.
- `tests/integration/determinism.fixtures.json` and the three tool reference documents track intentional contract changes.

## Chunk 1: Workflow boundaries

### Task 1: Propagate workflow step failures to the MCP envelope

**Files:**
- Modify: `tests/unit/tool-output-visibility.test.ts`
- Modify: `tests/integration/mcp-output-schema-wire.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add the response-envelope regression**

Add a table-driven unit test around `buildToolResponseEnvelope`:

```ts
it("marks retained workflow step errors as MCP errors", () => {
  const payload = {
    results: [
      { stepIndex: 0, fn: "fileWrite", status: "error", error: "invalid source" },
      { stepIndex: 1, fn: "dataTemplate", status: "skipped" },
    ],
    totalTokens: 10,
    durationMs: 1,
    truncated: false,
  };

  const envelope = buildToolResponseEnvelope(
    payload,
    null,
    "",
    "sdl.workflow",
    {},
  );

  assert.equal(envelope.isError, true);
  assert.deepEqual(envelope.structuredContent?.results, payload.results);
});
```

Also prove a workflow containing only `ok` and `skipped` steps is not an MCP error.

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/tool-output-visibility.test.ts
```

Expected: the nested-workflow assertion fails.

- [ ] **Step 3: Add raw-client mutation/runtime regressions**

Extend the existing disposable repository in `tests/integration/mcp-output-schema-wire.test.ts`. Before changing `src/server.ts`, add raw `Client.callTool` cases for:

1. `fileWrite` with invalid indexed TypeScript.
2. `searchEditPreview`, an intervening `fileWrite`, then stale `searchEditApply`.
3. `runtimeExecute` with Node code that exits non-zero.

For each response, assert:

```ts
assert.equal(response.isError, true);
assert.equal(
  (response.structuredContent as { results: Array<{ status: string }> })
    .results.some((step) => step.status === "error"),
  true,
);
```

Restore disposable source content between cases and assert the stale apply never overwrites the intervening write.

- [ ] **Step 4: Run all F1 regressions and verify RED**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/tool-output-visibility.test.ts tests/integration/mcp-output-schema-wire.test.ts
```

Expected: all new cases retain nested step errors but lack top-level `isError: true`.

- [ ] **Step 5: Implement one shared classifier**

In `src/server.ts`, replace the inline status check with a private helper equivalent to:

```ts
function isToolErrorPayload(toolName: string, payload: unknown): boolean {
  if (!isRecordValue(payload)) return false;
  if (payload.status === "failure" || payload.status === "denied") {
    return true;
  }
  return toolName === "sdl.workflow"
    && Array.isArray(payload.results)
    && payload.results.some(
      (step) => isRecordValue(step) && step.status === "error",
    );
}
```

Do not alter the payload, result projection, `onError`, or skipped-step behavior.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/tool-output-visibility.test.ts tests/integration/mcp-output-schema-wire.test.ts
```

Expected: both files pass. Run `node --experimental-strip-types --test tests/integration/determinism.test.ts` and confirm the existing concrete `sdl.workflow` allowlist remains valid because workflow artifacts are intentionally excluded.

- [ ] **Step 7: Commit F1**

```powershell
git add src/server.ts tests/unit/tool-output-visibility.test.ts tests/integration/mcp-output-schema-wire.test.ts
git commit -m "fix(workflow): propagate failed steps to MCP errors"
```

### Task 2: Return safe split-workflow graph recovery

**Files:**
- Modify: `tests/unit/public-graph-retrieval-admission.test.ts`
- Modify: `tests/integration/public-graph-retrieval-admission.test.ts`
- Modify: `src/mcp/public-graph-retrieval-admission.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add ordered-detection unit tests**

Export a narrowly named helper and test these requests:

```ts
workflowHasRefreshBeforeGraph({
  steps: [
    { fn: "indexRefresh", args: { mode: "full" } },
    { fn: "symbolSearch", args: { query: "main" } },
  ],
}); // true
```

The helper returns false for graph-before-refresh and workflows without both actions. Synchronous and asynchronous refreshes both return true because the helper selects recovery text only; it never grants admission.

- [ ] **Step 2: Add fail-closed integration regressions**

In `tests/integration/public-graph-retrieval-admission.test.ts`, call `sdl.workflow` against unverified and failed graph states with both `async: false` (or omitted) and `async: true` refresh-before-graph steps. Assert:

```ts
assert.equal(response.isError, true);
assert.match(error.message ?? "", /separate workflows|split.*workflow/i);
assert.match(error.message ?? "", /wait.*complet/i);
```

Keep the existing graph-before-refresh response unchanged and prove degraded graph state remains rejected before execution.

- [ ] **Step 3: Run the admission tests and verify RED**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/public-graph-retrieval-admission.test.ts tests/integration/public-graph-retrieval-admission.test.ts
```

Expected: the new recovery text assertions fail while all existing fail-closed assertions still pass.

- [ ] **Step 4: Add recovery metadata without bypassing admission**

In `src/mcp/public-graph-retrieval-admission.ts`, reuse `GRAPH_WORKFLOW_STEPS` and the existing record parser to scan ordered steps and export `workflowHasRefreshBeforeGraph(args: unknown): boolean`.

In `src/server.ts`, catch only `GraphRetrievalUnavailableError` around `assertGraphRetrievalAvailable`. When the tool is `sdl.workflow` and the helper returns true, rethrow a `GraphRetrievalUnavailableError` whose message appends:

```text
Run indexRefresh in one sdl.workflow, wait for it to complete, then run graph retrieval in a second sdl.workflow.
```

Do not attach new recovery metadata, catch unrelated errors, rewrite graph state, or admit the request.

- [ ] **Step 5: Run focused admission tests and verify GREEN**

Run the command from Step 3. Expected: both files pass and degraded-state coverage remains fail-closed.

- [ ] **Step 6: Commit F2**

```powershell
git add src/server.ts src/mcp/public-graph-retrieval-admission.ts tests/unit/public-graph-retrieval-admission.test.ts tests/integration/public-graph-retrieval-admission.test.ts
git commit -m "fix(workflow): explain split graph recovery"
```

## Chunk 2: Focused context and QA runner

### Task 3: Reject indexed exact focus files without symbols

**Files:**
- Modify: `tests/unit/context-v2-overlay-expansion.test.ts`
- Modify: `tests/unit/context-v2.test.ts`
- Modify: `src/context/engine.ts`
- Modify: `src/context/types.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `tests/unit/context-response-projection.test.ts`
- Modify: `tests/integration/determinism.fixtures.json`
- Modify: `tests/integration/determinism.test.ts`
- Create: `tests/stress/fixtures/src/javascript/unparseable.mjs`

- [ ] **Step 1: Add focus-path resolution regression**

Extend the `resolveFocusPaths` suite with an exact durable file whose `getSymbolsByFile` returns `[]`. Expect:

```ts
assert.deepEqual(result, {
  exactFileSymbolHits: [],
  directoryPrefixes: [],
  unavailableExactFiles: ["scripts/run-isolated-mutating-qa.mjs"],
});
```

Update existing exact, directory, missing, overlay, and tombstone expectations with `unavailableExactFiles: []`.

- [ ] **Step 2: Add model-facing ContextEngine regression**

Export the small `FocusPathUnavailableError` used across the read-snapshot boundary. Add a `ContextEngineV2` test whose injected `retrieve` dependency throws `new FocusPathUnavailableError(["scripts/run-isolated-mutating-qa.mjs"])`. Assert the engine returns:

```ts
{
  isError: true,
  error: {
    code: "CONTEXT_FOCUS_PATH_UNAVAILABLE",
    message: /scripts\/run-isolated-mutating-qa\.mjs/,
    recovery: [
      { id: "index.refresh", args: { mode: "incremental" } },
      {
        id: "context",
        args: {
          repoId: "repo",
          taskType: "explain",
          taskText: "Explain parseArgs",
          budget: { maxTokens: 1_000 },
          focusPaths: ["scripts/run-isolated-mutating-qa.mjs"],
          focusSymbols: ["parseArgs"],
        },
      },
    ],
  },
}
```

Also assert candidate search/hydration is not invoked and unrelated symbols do not appear.

- [ ] **Step 3: Run context tests and verify RED**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts
```

Expected: missing `unavailableExactFiles` and error-code assertions fail.

- [ ] **Step 4: Implement the authoritative-path boundary**

In `src/context/engine.ts`:

1. Add `unavailableExactFiles: string[]` to `FocusPathResolution`.
2. Record an exact file path after filtering external symbols when its symbol list is empty.
3. Export `FocusPathUnavailableError`, carrying a sorted, read-only path list, because `buildContext` and the injected retrieval test seam cross an async dependency boundary.
4. Before `searchContextCandidates`, throw that error.
5. Catch only that error in `ContextEngineV2.buildContext` and return a bounded context error using incremental refresh plus `canonicalRetryArgs(request)`.

In `src/context/types.ts`, extend `ContextRecoveryError.error.code` with `"CONTEXT_FOCUS_PATH_UNAVAILABLE"`.

In `src/mcp/tools.ts`, extend `ContextRecoveryErrorSchema` with the same literal. In `tests/unit/context-response-projection.test.ts`, pass the complete error through `projectToolResultForModelContent("sdl.context", ...)` and assert the code, repository-relative path, and both recovery actions remain present. Do not add a parallel projector.

- [ ] **Step 5: Update deterministic contract fixture**

Create `tests/stress/fixtures/src/javascript/unparseable.mjs` with stable source that the current index records as a file but does not emit symbols for. Add an `expectError: true` `sdl.context` call focused on that path to `tests/integration/determinism.fixtures.json`.

In `tests/integration/determinism.test.ts`, extend the fixture-call type with optional `expectError`. Keep rejecting unexpected errors, but allow an error only when the fixture explicitly opts in; still canonicalize and compare the complete response across repeat calls, unchanged re-indexes, and fresh server legs. Assert the expected error code is `CONTEXT_FOCUS_PATH_UNAVAILABLE`.

- [ ] **Step 6: Run focused tests and schema validation**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts
npm run test:golden
node --experimental-strip-types --test tests/unit/context-response-projection.test.ts tests/integration/determinism.test.ts
```

Expected: all commands pass.

- [ ] **Step 7: Commit F3**

```powershell
git add src/context/engine.ts src/context/types.ts src/mcp/tools.ts tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts tests/unit/context-response-projection.test.ts tests/integration/determinism.fixtures.json tests/integration/determinism.test.ts tests/stress/fixtures/src/javascript/unparseable.mjs
git commit -m "fix(context): reject unavailable exact focus paths"
```

### Task 4: Expose isolated-runner tool failures and availability

**Files:**
- Modify: `tests/unit/isolated-mutating-qa.test.ts`
- Modify: `tests/integration/isolated-mutating-qa.test.ts`
- Modify: `scripts/run-isolated-mutating-qa.mjs`

- [ ] **Step 1: Add error-formatting unit tests**

Export `assertToolSucceeded` and verify a failed result containing text and structured error data throws a message containing:

```text
QA tool failed: sdl.file
isError=true
code=VALIDATION_ERROR
classification=invalid_input
<first text block>
```

Verify absent optional fields are omitted rather than printed as `undefined`.

- [ ] **Step 2: Add tool-list preflight unit tests**

Export `assertScenarioToolsAvailable`. Pass a child tool list without `sdl.file`, `sdl.retrieve`, and `sdl.workflow`, then assert the error names the missing top-level tools and explains that Code Mode is unavailable. Verify internal workflow `fn` names are never checked.

- [ ] **Step 3: Tighten the integration failure assertion**

Update the existing unknown-tool integration case so failure happens during preflight and still exposes `qaDbPath`, `qaRootPath`, and retained fixture existence. Add a scenario call to `sdl.repo.register` with `arguments: {}`. Preflight must pass because the top-level tool exists, then execution must fail with `isError=true`, non-empty first text, `code=VALIDATION_ERROR`, and `classification=invalid_input` in the retained runner error.

- [ ] **Step 4: Run runner tests and verify RED**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/isolated-mutating-qa.test.ts tests/integration/isolated-mutating-qa.test.ts
```

Expected: exported-helper and diagnostic assertions fail.

- [ ] **Step 5: Implement minimal preflight and formatting**

In `scripts/run-isolated-mutating-qa.mjs`:

1. Extract the first text block from `result.content`.
2. Read `code` and `classification` from `result.structuredContent?.error`.
3. Build one deterministic error line containing only present fields.
4. After `client.connect`, call `client.listTools()`.
5. Check `sdl.info` plus `scenario.map(step => step.tool)` against returned top-level tool names before any scenario call.

Do not inspect workflow `steps[].fn`, change child environment variables, or alter cleanup and retained-path behavior.

- [ ] **Step 6: Run focused runner tests and verify GREEN**

Run the command from Step 4. Expected: both files pass.

- [ ] **Step 7: Commit F4**

```powershell
git add scripts/run-isolated-mutating-qa.mjs tests/unit/isolated-mutating-qa.test.ts tests/integration/isolated-mutating-qa.test.ts
git commit -m "fix(qa): expose child tool failures"
```

### Task 5: Update public documentation

**Files:**
- Modify: `docs/agent-workflows.md`
- Modify: `docs/mcp-tools-reference.md`
- Modify: `docs/mcp-tools-detailed.md`
- Inspect and modify only if relevant: existing isolated mutating QA documentation

- [ ] **Step 1: Document the contracts**

Document:

- Any workflow step with `status: "error"` sets top-level MCP `isError: true` while preserving `structuredContent.results`.
- An unverified graph keeps mixed refresh/retrieval workflows fail-closed and returns split-workflow recovery.
- An indexed exact focus file with no symbols returns `CONTEXT_FOCUS_PATH_UNAVAILABLE` instead of unrelated same-name evidence.
- The isolated runner preflights top-level tools and reports child MCP error details. Update the existing isolated-runner section in `docs/agent-workflows.md`; do not create a duplicate section.

- [ ] **Step 2: Run documentation checks**

Run:

```powershell
npm run docs:tools:check
git diff --check
```

Expected: both commands pass.

- [ ] **Step 3: Commit documentation**

```powershell
git add docs/agent-workflows.md docs/mcp-tools-reference.md docs/mcp-tools-detailed.md
git commit -m "docs: describe SDL QA error contracts"
```

### Task 6: Final verification

- [ ] **Step 1: Run focused build and tests**

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/tool-output-visibility.test.ts tests/unit/public-graph-retrieval-admission.test.ts tests/unit/context-v2-overlay-expansion.test.ts tests/unit/context-v2.test.ts tests/unit/context-response-projection.test.ts tests/unit/isolated-mutating-qa.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/public-graph-retrieval-admission.test.ts tests/integration/determinism.test.ts tests/integration/isolated-mutating-qa.test.ts
npm run test:golden
npm run docs:tools:check
```

Expected: all pass.

- [ ] **Step 2: Run the full suite**

```powershell
npm test
```

Expected: exit 0. Restore only known generated fixture churn produced by this run; do not touch unrelated changes.

- [ ] **Step 3: Verify final scope**

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate -6
```

Expected: clean worktree on `codex/address-f1-f4`, with only the design, four focused fixes, documentation, and any intentional deterministic fixture update in history.
