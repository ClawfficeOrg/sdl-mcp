# Context Profiles

`sdl.context` uses one retrieval pipeline with declarative task profiles. Callers describe the task, priority targets, and token budget instead of selecting a breadth or semantic mode.

## Mental Model

Three inputs shape a request:

1. `taskType` selects the deterministic profile.
2. Flat focus fields identify Tier-0 seed priorities.
3. `budget.maxTokens` bounds the complete response.

The engine chooses available retrieval lanes, expands the graph, and selects evidence bundles under that budget. Focus fields do not create an unlimited guarantee or hard path boundary.

## Task Profiles

| Task type | Primary goal | Preferred evidence | Test default |
| --- | --- | --- | --- |
| `debug` | Trace a failure and its nearby implementation | card, hot path, skeleton | included |
| `review` | Inspect behavior, dependencies, and risk | card, skeleton, hot path | included |
| `implement` | Find edit targets and supporting structure | card, skeleton | included |
| `explain` | Describe an API or behavior from source evidence | card, skeleton | excluded |

The profile also selects expansion direction and depth. Explicit `includeTests` overrides the profile default.

## Priority Seeds

Use `focusSymbols` when canonical symbol IDs or names are known. Use `focusPaths` for repository-relative files or directories, and use `chatMentions` for identifiers named in the current conversation.

Resolved focus candidates enter Tier 0 in deterministic order. Exact task-text identifiers can also enter Tier 0. Remaining fused and graph-expanded candidates enter Tier 1.

If every selected Tier-0 rung cannot fit, the response uses `status: "budgetLimited"`, emits no Tier-1 evidence, and identifies the highest-ranked omitted Tier-0 work.

## Retrieval Levels

The engine reports capability, not caller preference:

| Level | Meaning |
| --- | --- |
| `hybrid` | Lexical and vector lanes contribute with full configured coverage |
| `hybrid-partial` | Vector retrieval contributes with partial coverage and adjusted weight |
| `lexical` | Lexical evidence contributes without vector evidence |
| `graph-only` | Resolved graph seeds remain available without text or vector candidates |

An unreadable graph fails before lane selection. A request with insufficient capabilities returns a structured error rather than a successful `graph-only` or `empty` payload.

## Evidence Selection

Each candidate owns one bundle:

- card
- optional skeleton
- optional hot path

The selector orders Tier 0 before Tier 1 and compares deterministic value per estimated token. Hydration runs only for selected bundles. After hydration, one exact serialized-size pass evicts optional Tier-1 rungs when estimates were low.

Raw windows are not a context rung. Use `sdl.retrieve` `codeNeedWindow` with a concrete reason and identifiers when exact source is necessary.

## Response Status

- `complete` means all selected evidence fits.
- `budgetLimited` means the budget excludes resolved priority or optional work.
- `empty` means healthy available lanes found no candidates.

`omitted.byReason` summarizes the full omitted set. `omitted.highestRanked` remains bounded and includes logical recovery actions.

## Focused Request

```json
{
  "repoId": "my-repo",
  "taskType": "review",
  "taskText": "Review parseConfig timeout validation",
  "budget": { "maxTokens": 3000 },
  "focusSymbols": ["parseConfig"],
  "focusPaths": ["src/config/parse.ts"],
  "includeTests": true
}
```

## Exploratory Request

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Trace request dispatch from the server entrypoint to handlers",
  "budget": { "maxTokens": 7000 },
  "includeTests": false,
  "responseMode": "auto"
}
```

## Decision Guide

- Use `sdl.context` when the task needs task-shaped evidence across multiple symbols.
- Add focus fields when exact targets are already known.
- Reduce `budget.maxTokens` for a tighter payload; increase it only when bounded omissions identify required work.
- Use `sdl.retrieve` for one exact card, slice, skeleton, hot path, or code window.
- Use `sdl.workflow` for procedural pipelines, runtime execution, transforms, or mutations.

## Related

- [Agent Context](./agent-context.md)
- [Code Mode](./code-mode.md)
- [Token Economy](./token-economy.md)
- [Graph Slicing](./graph-slicing.md)
