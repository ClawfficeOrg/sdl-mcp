# SDL Tool QA Remediation Design

## Purpose

Address the four verified SDL-MCP tool-quality findings from the 2026-07-26 live evaluation:

1. Windows PowerShell runtime executions cannot launch nested native commands because the scrubbed environment omits `PATHEXT`.
2. `sdl.info({ redactPaths: true })` is not byte-stable across fresh processes because the redacted log basename retains a timestamp and process ID.
3. Broad `sdl.context` responses for a single exact code identifier retain too many unrelated rich-evidence subjects.
4. Missing-symbol errors return up to five low-confidence fuzzy candidates.

The implementation must preserve public tool schemas, prompt-cache determinism, existing broad-context behavior for generic and multi-identifier tasks, and safe structured errors.

## Scope

### Included

- Preserve the minimum Windows environment state needed for nested native commands.
- Make redacted logging status truthful and process-stable.
- Narrow broad evidence only for a single resolved high-signal identifier.
- Reduce low-value fuzzy suggestions consistently.
- Add one focused regression for each behavior.
- Update the changelog and affected public documentation.

### Excluded

- Replacing the runtime executor or adding a PowerShell wrapper.
- Changing log filename generation or rotation.
- Globally retuning broad-context retrieval, semantic ranking, or graph expansion.
- Adding reference-search edges to the index.
- Changing exact symbol resolution, ambiguity handling, or auto-resolution thresholds.
- Adding configuration for any value introduced by this remediation.

## Design

### 1. Windows native-command environment

`buildScrubbedEnv()` in `src/runtime/executor.ts` remains the single environment boundary for every runtime execution.

On Windows, copy `PATHEXT` from the parent process when it is present, using the same case-insensitive environment lookup behavior used for `PATH`. Do not add runtime-specific command wrapping. Do not add `SystemRoot`, `ComSpec`, or other variables that did not independently restore the reproduced behavior.

This is the root-cause fix: Windows PowerShell 5.1 uses `PATHEXT` to resolve executable commands, including explicitly qualified `.exe` paths. Preserving that one platform variable restored `cmd.exe` execution and populated `$LASTEXITCODE` in the live reproduction.

### 2. Stable `sdl.info` redaction

`collectInfoReport()` continues to report the real logging path internally. Only the existing MCP redaction projection changes.

When `redactPaths` is true:

- A non-null `logging.path` becomes the literal `"<redacted>"`.
- A null `logging.path` remains null so callers can still distinguish disabled file logging.
- Config, LadybugDB, and native-addon paths continue using their current basename redaction.

No response field or schema changes. The placeholder is intentionally not a fabricated filename and cannot contain timestamps, process IDs, or machine-specific directories.

### 3. Single-identifier broad evidence

Reuse the existing identifier extraction, named-concept provenance, and `evidenceSubjectKey()` helper. Do not add a second parser or a new public option.

The narrow rule applies only when all of these are true:

1. The task is in broad context mode.
2. Existing extraction returns exactly one high-signal code identifier from the task text. If extraction returns any additional high-signal identifier, the rule does not apply even when the additional identifier is unresolved or ambiguous.
3. That identifier resolves by exact name/identity matching—not fuzzy auto-resolution—to exactly one named-concept symbol reference.
4. The caller did not provide `focusSymbols` or `focusPaths`; explicit focus continues to use the existing authority rules.
5. Final evidence contains rich evidence (`skeleton` or non-zero-match `hotPath`) for the exact subject.

When the rule applies, use this deterministic filtering algorithm:

1. Derive the exact subject key from the resolved named-concept reference.
2. Scan final evidence in its existing order and collect the first two distinct rich-evidence subject keys other than the exact subject. These are the secondary subjects.
3. Retain `symbolCard`, `skeleton`, and `hotPath` items only when their subject key is the exact subject or one of the two secondary subjects. A zero-match hot path does not select a secondary subject, but it is retained when another rich item selected the same subject.
4. Discard unrelated card-only symbol evidence and all rich symbol evidence for unselected subjects.
5. Retain runtime results, diagnostics, memories, errors, and every other non-symbol evidence kind without filtering.
6. Serialize the retained evidence as a stable partition: exact-subject items first in their original relative order, selected-secondary-subject items next in their original relative order across both subjects, then retained non-symbol evidence in its original relative order.

In this narrowly triggered mode, the exact identifier is explicit task authority and supersedes inferred protected seed references for symbol-evidence filtering. Existing protected-reference behavior remains authoritative for every request where this rule does not apply. Public response fields, evidence references, and key order do not change.

The cap is deliberately local to the verified failure mode. It avoids a global ranking change and does not undo recent broad-context selection for generic, multi-identifier, or explicitly focused requests.

### 4. Fuzzy suggestion quality

Use the same constants in both NOT_FOUND candidate paths in `src/util/resolve-symbol-ref.ts`:

- Minimum suggestion score: `0.35`.
- Maximum returned suggestions: `3`.

Apply the threshold only to suggestions. Exact matches, strict ambiguity results, and `MIN_FUZZY_AUTO_RESOLVE_SCORE` behavior remain unchanged.

The human-readable “Did you mean” suffix and structured `candidates` array must use the same filtered candidate set so text and structured recovery guidance cannot disagree.

## Data Flow

### Runtime

`runtime.execute` request → runtime policy → `buildScrubbedEnv()` → PowerShell process → native child process → shared stdout/stderr executor → persisted artifact.

Only the environment construction step changes.

### Info

`collectInfoReport()` → full internal report → `redactInfoPaths()` → stable MCP response.

Only the redacted projection changes.

### Context

Context seeding and provenance → planner/executor evidence → existing protected-reference finalization → single-identifier evidence narrowing (which supersedes inferred protected references only when its trigger fully matches) → existing response optimization and serialization.

No retrieval source, graph expansion, or public request/response schema changes.

### Symbol recovery

Symbol reference → exact/scoped resolution → fuzzy candidate generation when needed → shared suggestion threshold and cap → structured NOT_FOUND error.

## Error Handling and Edge Cases

- If `PATHEXT` is absent from the parent environment, do not synthesize a value.
- If file logging is disabled, preserve `logging.path: null`.
- If named-concept provenance is absent or ambiguous, do not narrow broad evidence.
- Zero-match hot paths do not qualify as rich evidence.
- If fewer than two secondary rich subjects exist, return only those available.
- A typo with a strong candidate still receives recovery guidance.
- An unrelated or nonsensical symbol name may return no candidates; the NOT_FOUND error and fallback tools remain actionable.

## Testing

Use Node's built-in test runner and existing fixtures.

### Runtime regression

- Assert the Windows scrubbed environment preserves `PATHEXT`.
- On Windows, run a PowerShell code request that invokes `cmd.exe /c echo`; assert the exact expected stdout and `$LASTEXITCODE === 0`.
- Keep the test independent of Git, npm, and user-installed tools.

### Info regression

- Assert a non-null redacted logging path is exactly `"<redacted>"`.
- Assert a null logging path stays null.
- Compare redacted `sdl.info` structured responses from two fresh server processes after normal fixture setup.

### Context regression

Build production-shaped evidence containing:

- One exact named-concept subject with a card and rich evidence.
- More than two unrelated rich subjects and supporting cards.
- Unrelated card-only symbol evidence.
- A runtime or diagnostic evidence item.

Assert the exact subject is first, the first two secondary rich subjects are retained in their original relative order, supporting cards for selected subjects remain, unrelated card-only symbol evidence is removed, non-symbol evidence remains, no downstream response reference points to a filtered item, and serialization is deterministic. Add companion assertions proving fuzzy-resolved identifiers do not trigger narrowing and generic, multi-identifier, and explicitly focused broad requests keep their existing evidence behavior.

### Symbol recovery regression

- Cover candidate scores immediately below, exactly at, and immediately above `0.35`; the threshold is inclusive.
- Assert an unrelated missing name returns no candidate below `0.35` and no more than three candidates.
- Assert a close typo still returns its strong intended candidate.
- Assert text hints and structured candidates agree.

## Verification

Run the focused unit and integration files selected by the repository's test-scope workflow, followed by:

- Typecheck.
- Lint for changed source files.
- Determinism and raw MCP wire checks affected by `sdl.info`.
- Existing broad-context acceptance tests.
- A live verified-graph probe for `SDL_MCP_SERVER_INSTRUCTIONS`.
- A live Windows PowerShell native-command probe.

Do not claim completion from focused unit tests alone.

## Documentation

Update:

- `CHANGELOG.md` under Unreleased with all four user-visible fixes.
- `docs/mcp-tools-reference.md` with the redacted `sdl.info` logging placeholder, the single-exact-identifier broad-context narrowing rule, and the bounded missing-symbol suggestions.
- `docs/prompt-cache-hygiene.md` with the stable `"<redacted>"` logging-path contract.

The `PATHEXT` preservation is an internal runtime compatibility fix. It does not require public reference, configuration, or migration documentation. No new configuration or migration documentation is needed for the other changes.

## Acceptance Criteria

- PowerShell runtime artifacts contain nested native-command stdout on Windows.
- Redacted `sdl.info` output is byte-stable across fresh processes.
- The exact-identifier live context probe retains the target rich evidence, keeps at most the first two secondary rich subjects, removes unrelated card-only symbol evidence, and preserves deterministic ordering.
- Generic, multi-identifier, and explicitly focused broad-context regressions remain unchanged.
- Missing-symbol recovery returns at most three candidates, all scoring at least the inclusive `0.35` threshold.
- Public schemas, tool names, and tool order remain unchanged.
- Focused tests, affected integration tests, typecheck, lint, and live probes pass.
