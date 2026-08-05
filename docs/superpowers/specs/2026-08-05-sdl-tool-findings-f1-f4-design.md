# SDL Tool QA Findings F1-F4 Design

## Status

Approved on 2026-08-05 after independent safety review.

## Goal

Address the four verified QA findings at their shared boundaries while preserving workflow control flow, graph-integrity safety, context budgets, mutation isolation, and existing response payloads.

## Non-goals

The change does not add a new mutation framework, general workflow state machine, parser support, or alternate raw-source reader. It does not change `onError`, rollback, stale-plan, or asynchronous indexing semantics.

## F1: Workflow error classification

`executeWorkflow` already retains failed and skipped step envelopes. The MCP response boundary fails to classify those retained errors because `buildToolResponseEnvelope` only recognizes top-level `status: "failure"` and `status: "denied"`.

Add one workflow-specific predicate at the response-envelope boundary. For `sdl.workflow`, the predicate marks the MCP envelope with `isError: true` when any retained step has `status: "error"`. The predicate leaves `structuredContent`, failure traces, skipped steps, rollback details, stale-plan details, and `onError` behavior unchanged.

Regressions cover invalid `fileWrite`, stale `searchEdit`, and failed `runtimeExecute` steps through raw MCP and Code Mode response paths.

## F2: Fail-closed graph recovery

The public graph admission classifier currently scans the whole workflow for any graph-backed step. A new repository therefore fails admission before an earlier `indexRefresh` step can run.

Keep graph admission fail-closed. Bypassing admission based only on workflow order would be unsafe when refresh fails under `onError: "continue"` or when the existing graph is degraded. When an unavailable workflow contains `indexRefresh` before graph retrieval, enrich the graph-unavailable response with a compact instruction to run indexing in one workflow, wait for completion, and run retrieval in a second workflow.

Tests cover synchronous and asynchronous refresh-before-graph requests, graph-before-refresh, and degraded graph state. All cases remain rejected until graph integrity is verified, while the refresh-before-graph cases receive the specific split-workflow recovery.

## F3: Authoritative exact focus paths

`resolveFocusPaths` distinguishes exact files from directory prefixes, but an exact indexed file with no non-external symbols currently disappears from the result. Retrieval then spends the budget on same-name symbols from unrelated files.

Record exact focus files that resolve but produce no symbols. Stop context candidate retrieval when any authoritative exact focus file is unavailable, then return the existing context error envelope with a dedicated `CONTEXT_FOCUS_PATH_UNAVAILABLE` code. The message names the repository-relative paths. Recovery remains bounded to an incremental refresh and a retry of the same context request.

Missing paths retain their current behavior because the caller may intentionally provide speculative paths. Directories retain priority rather than boundary semantics. Tests cover exact files with symbols, exact files without symbols, missing paths, and the model-facing context response.

The public contract change updates the context result union, MCP output schema, response projection, documentation, and `tests/integration/determinism.fixtures.json`.

## F4: Isolated runner diagnostics and preflight

The isolated runner currently checks tool failures without reporting their MCP payload and discovers missing Code Mode tools only after a call fails.

After connecting, request the child server's tool list and verify `sdl.info` plus every top-level MCP tool named by the scenario before executing it. Internal workflow `fn` names are not part of `tools/list`. When required `sdl.file`, `sdl.retrieve`, or `sdl.workflow` tools are absent, the error states that the child configuration does not expose the required Code Mode tools.

Expand the existing failure assertion to include the first text content block, structured error code, structured classification, and `isError` value when present. Keep the retained QA paths, database-family checks, child environment isolation, and cleanup rules unchanged.

## Documentation and verification

Update `docs/agent-workflows.md`, `docs/mcp-tools-reference.md`, and `docs/mcp-tools-detailed.md` for workflow error classification, split-workflow recovery, and authoritative focus-path errors. Update runner documentation only if an existing public runner section describes its error output.

Verification uses the runtime build, focused unit and integration tests, documentation checks, deterministic fixtures, `git diff --check`, and the full test suite.
