# Context Evidence Budget Ranking Design

**Date:** 2026-07-28  
**Status:** Approved

## Problem

`sdl.context` can omit its highest-ranked Tier 1 candidate while admitting several lower-ranked candidates. A focused request for `sdl.info` registration tests reproduced the defect on an integrity-verified graph: the response omitted rank 1 from `tests/unit/tool-registration.test.ts` for budget while returning unrelated lower-ranked symbols at 1,600, 3,200, and 12,000 tokens.

The retrieval stage ranks the relevant test first. The inversion occurs in `selectTierOne`, where whole non-exact bundles use value-per-token density. Small differences in serialized path and evidence-shell cost can outweigh a large relevance-rank difference.

## Decision

Admit complete non-exact Tier 1 bundles in deterministic candidate-rank order, using symbol ID as the existing stable tie-breaker. When a higher-ranked bundle does not fit, record every remaining rung as omitted and continue to the next ranked candidate.

A complete bundle means the profile ladder used during estimated pre-hydration admission. The exact-size final budget enforcer remains a safety check and may still evict optional Tier 1 rungs when hydrated content exceeds its estimate.

Keep value-per-token selection for progressive rung upgrades after admission. This preserves efficient enrichment without allowing metadata size to replace retrieval relevance as the primary whole-bundle admission rule.

The change remains local to the shared selector in `src/context/select.ts`. It adds no configuration, dependency, or new abstraction.

## Alternatives

### Reserve the top N candidates

A fixed reservation would preserve some highly ranked evidence while retaining density packing for the remainder. It introduces an arbitrary threshold and can fail immediately below or above that threshold.

### Boost test paths during retrieval

A test-path boost could improve this specific query. The retrieval stage already produces the correct rank, so another boost would duplicate ranking policy and leave the allocator inversion unfixed for non-test requests.

## Verification

Focused unit regressions cover both admission branches:

- A rank-1 bundle has slightly larger serialized metadata than a compact rank-35 bundle. With room for only one complete bundle, the selector admits rank 1 and reports rank 35 as omitted.
- A higher-ranked bundle cannot fit but a lower-ranked bundle can. The selector reports every rung of the higher-ranked bundle as omitted, continues, and admits the lower-ranked bundle.
- Equal-rank candidates retain the existing symbol-ID tie-breaker. Rename the stale value-per-token test so its name states that deterministic contract.

Verification runs:

- Build the runtime output.
- Run the focused context selector test.
- Run the relevant context test scope.
- Check documentation and repository diffs.
- Probe a fresh runtime with this request at 1,600, 3,200, and 12,000 tokens:

```json
{
  "repoId": "sdl-mcp",
  "taskType": "debug",
  "taskText": "Find the exact tests that verify sdl.info tool registration and its public contract.",
  "budget": { "maxTokens": 1600 },
  "chatMentions": ["sdl.info"],
  "includeTests": true,
  "responseMode": "inline",
  "refsMode": "off",
  "wireFormat": "json"
}
```

Repeat the request with `budget.maxTokens` set to `3200` and `12000`. Each response must include evidence from `tests/unit/tool-registration.test.ts` at rank 1, must not admit lower-ranked evidence ahead of rank 1, and must not report that rank-1 candidate as budget-omitted. Larger budgets may add lower-ranked evidence but must not displace rank 1.

## Documentation

Update both public descriptions of context selection:

- `docs/feature-deep-dives/agent-context.md`
- `docs/feature-deep-dives/context-modes.md`

Describe rank-first whole-bundle admission, value-per-token progressive enrichment, and the exact-size finalizer as a safety check.
