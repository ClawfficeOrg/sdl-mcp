# Ignore-Aware Live Index Sync Design

## Problem

`file.write` and `search.edit` both call `syncLiveIndex()` after a source-file write. The full scanner excludes paths that match the repository's `ignore` patterns, but `syncLiveIndex()` currently checks only the file extension. A write under an ignored path can therefore add graph state that a full scan will never reproduce. The background integrity verifier detects that mismatch and marks the graph failed.

Rebuilding the graph without closing this boundary leaves the failure repeatable.

## Approved scope

Make the shared live-sync boundary apply the scanner's existing ignore decision before calling `patchSavedFile()`. An ignored file remains writable, but it is ineligible for graph synchronization and the mutation response omits `indexUpdate`.

Preserve these existing contracts:

- Eligible source writes still synchronize through `patchSavedFile()`.
- Non-source writes still skip graph synchronization.
- A malformed stored repository configuration returns `indexUpdate.applied: false`. `file.write` restores or unlinks the written file and throws; `search.edit` keeps its existing best-effort behavior, retains the file edit, and surfaces the failed `indexUpdate`.
- No mutation path runs a full repository scan.
- No new dependency or indexing abstraction is introduced.

Configured-language eligibility is outside this repair. The observed integrity failure comes from bypassing `config.ignore`; changing the broader source-extension contract would be a separate behavior change.

## Design

Export the existing ignore-pattern compiler and path predicate from `src/indexer/fileWalker.ts`. The scanner continues using those functions exactly as it does now.

Inside the existing `syncLiveIndex()` `try` block:

1. Load the repository row through the existing Ladybug query layer.
2. Parse and validate `configJson` with `RepoConfigSchema`.
3. Compile `config.ignore` with the scanner's exported compiler.
4. Return `undefined` when the repository-relative file path matches an ignore pattern.
5. Otherwise continue to `patchSavedFile()` unchanged.

Keeping configuration parsing inside the existing error boundary returns the current failed `indexUpdate` on malformed configuration. The callers preserve their distinct behavior: `file.write` rolls back and throws, while `search.edit` retains the edit and reports the failed sync. Placing the guard in `syncLiveIndex()` fixes every current caller once.

## Alternatives rejected

### Guard each mutation handler

This duplicates policy in `file.write` and `search.edit`, and leaves future callers exposed. The shared function is the smaller root-cause boundary.

### Reimplement glob matching in the MCP layer

This creates a third ignore implementation beside the scanner and watcher. Reusing the scanner functions prevents semantic drift.

### Run the scanner or rebuild after every write

This is disproportionate and would add avoidable latency. A single-path eligibility check is sufficient.

## Tests

Use test-driven development and demonstrate the regression before changing production code.

- `file.write`: configure an ignored TypeScript path, write it through the public handler, and verify the file changes while `indexUpdate` is absent. Compare before and after graph revision, targeted File and Symbol rows, integrity manifest, and integrity digest; each remains unchanged.
- `search.edit`: preview and apply an edit through the public search-edit handler for a configured ignored TypeScript path. Verify the edit succeeds while `indexUpdate` is absent, and make the same explicit before and after assertions for graph revision, targeted File and Symbol rows, integrity manifest, and integrity digest.
- Eligible `search.edit`: assert `indexUpdate.applied` is true and graph revision advances.
- Retain and run the existing eligible `file.write` synchronization test and malformed-config `file.write` rollback test.

Update the public mutation-tool documentation to state that source files excluded by repository ignore patterns are written without a live graph update.

## Safe rebuild and verification

After build, focused tests, typecheck, and lint pass:

1. Stop the SDL-MCP process that owns the active Ladybug database.
2. Use the freshly built fixed CLI to run `sdl-mcp index --force --safe-rebuild <absolute-new-path>` against a nonexistent candidate path.
3. If the safe rebuild fails, leave the configured database path unchanged and preserve both database families and command evidence.
4. Start the freshly built fixed server on the validated candidate database and confirm after reopen that `repo.status` reports `graphIntegrityState: "verified"` and the verified revision equals the current revision.
5. If post-reopen validation fails, stop the candidate server, leave the configured database path unchanged, and preserve both database families and evidence.
6. Exercise ignored-path writes through both public mutation surfaces. After each write, confirm graph revision is unchanged, integrity remains verified, and verified revision equals current revision.
7. If either live check fails, stop the candidate server and preserve the candidate and original database families plus logs. Cut over the configured database path only after every gate passes.

The existing failed database is never overwritten or deleted during the rebuild.

## Success criteria

- Both ignored-path regression tests fail before the production change and pass afterward.
- Ignored writes do not call the live graph patcher, create targeted File or Symbol rows, change the integrity manifest or digest, or advance graph revision.
- Eligible writes still synchronize; eligible `search.edit` reports `indexUpdate.applied: true` and advances revision.
- Malformed-config behavior remains caller-specific: `file.write` rolls back, while `search.edit` retains the edit and surfaces the failed sync.
- Documentation describes the ignore-aware mutation contract.
- The replacement production graph reports verified integrity after reopen and after each live acceptance check before cutover.
