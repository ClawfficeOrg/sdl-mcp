# Tool Output Contract

SDL-MCP projects every public tool result through an explicit output profile. The profile keeps default responses compact, preserves recovery for large results, and keeps operational data out of ordinary model context.

The generated [tool inventory](./generated/tool-inventory.md) is the current source of profile coverage. It lists each profile's projector, budget class, recovery policy, and observability profile.

## Compact response

Action: `sdl.repo.status`

Request compact status when the next decision needs repository availability rather than diagnostic detail.

```json
{ "repoId": "my-repo", "detail": "compact" }
```

The projected response retains content-shaped repository state.

```json
{ "repoId": "my-repo", "rootAvailability": { "status": "available" } }
```

## Full response

Action: `sdl.repo.status`

Request `detail: "full"` when compact output omits a semantic field required for the current task. Full expands the same bounded profile and does not enable diagnostics.

```json
{ "repoId": "my-repo", "detail": "full" }
```

```json
{ "repoId": "my-repo", "rootAvailability": { "status": "available" } }
```

## Diagnostic response

Action: `sdl.repo.status`

Request `includeDiagnostics: true` only while diagnosing a tool result. Diagnostics are an explicit per-call prompt-cache opt-out. They may expose only profile-allowlisted, bounded, redacted operational fields.

```json
{ "repoId": "my-repo", "detail": "full", "includeDiagnostics": true }
```

The normal projected fields remain available; a profile adds diagnostic fields only when its allowlist permits them.

```json
{ "repoId": "my-repo", "rootAvailability": { "status": "available" } }
```

The default `compact`, `standard`, and `full` responses never contain timestamps, durations, session identifiers, counters, or machine-specific paths. Absolute paths additionally require the existing disclosure control.

## Handled response

Action: `sdl.context`

Artifact-capable profiles return a handle when the projected result exceeds the inline budget. Use the handle to recover only the required portion.

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Summarize the repository.",
  "budget": { "maxTokens": 2000 },
  "responseMode": "auto"
}
```

```json
{
  "responseMode": "handle",
  "kind": "responseArtifact",
  "handle": "response-opaque-handle",
  "action": "response.get",
  "metadata": {
    "contentKind": "json",
    "originalBytes": 18000,
    "repoId": "my-repo",
    "toolName": "sdl.context"
  }
}
```

## Error response

Action: `sdl.context`

A context request can fail with a stable, content-shaped error when the supplied budget cannot satisfy the request. This error reports the minimum valid recovery budget and does not invent a recovery action.

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Summarize the repository.",
  "budget": { "maxTokens": 512 }
}
```

```json
{
  "isError": true,
  "error": {
    "code": "CONTEXT_BUDGET_TOO_SMALL",
    "message": "The context budget is too small.",
    "minimumTokens": 1200
  }
}
```

## Author checklist

Use this profile checklist when adding or changing a tool response.

- Choose the profile and its budget owner from the generated inventory and the canonical budget map.
- Define handling for over-budget output and add recovery validation for every recovery action.
- Apply the dual-channel rule: project both MCP content and structured content through one ModelProjection boundary.
- Preserve observability separation: choose an observability extractor that keeps telemetry separate from default model-facing content.
- Add compact, full, and error tests, and add diagnostic coverage when the profile allowlists diagnostics.
- Add or update the determinism fixture, including an explicit exclusion only when session-scoped output is unavoidable.
- Regenerate the inventory and update this contract and related documentation.

## Budget and recovery rules

Budget classes cap the combined model-facing response after projection, not only one response channel. The generated inventory and canonical budget map define the current classes and limits. The profile registry owns the class; the budget map owns the numeric limit.

Project before wrapping or storing an artifact. Sanitize artifacts before exposing them. Validate recovery arguments against the action schema before returning them. Fail closed when projection, sanitization, or recovery validation fails.

## Observability and determinism

Operational measurements belong in logs, persisted runtime artifacts, or explicit diagnostics. Do not add volatile operational fields to normal responses merely because they are useful during diagnosis.

Stable key order, deterministic ordering, and bounded projections are contract requirements. Add a determinism fixture for every changed output contract and keep diagnostic fixture exclusions narrow, documented, and deliberate.
