# Ignore-Aware Live Index Sync Design

## Problem

`file.write` and `search.edit` both call `syncLiveIndex()` after a source-file write. The full scanner excludes paths that match the repository's `ignore` patterns, but `syncLiveIndex()` currently checks only the file extension. A write under an ignored path can therefore add graph state that a full scan will never reproduce. The background integrity verifier detects that mismatch and marks the graph failed.

Rebuilding the graph without closing this boundary leaves the failure repeatable.

## Approved scope

Make the shared live-sync boundary apply the scanner's existing ignore decision before calling `patchSavedFile()`. An ignored file remains writable, but it is ineligible for graph synchronization and the mutation response omits `indexUpdate`.

Preserve these existing contracts:

- Eligible source writes still synchronize through `patchSavedFile()`.
- Non-source writes still skip graph synchronization.
- A malformed stored repository configuration still becomes a failed index update, allowing the existing write rollback path to restore the file.
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

Keeping configuration parsing inside the existing error boundary preserves rollback behavior for invalid stored configuration. Placing the guard in `syncLiveIndex()` fixes every current caller once: `file.write` and the `search.edit` batch executor.

## Alternatives rejected

### Guard each mutation handler

This duplicates policy in `file.write` and `search.edit`, and leaves future callers exposed. The shared function is the smaller root-cause boundary.

### Reimplement glob matching in the MCP layer

This creates a third ignore implementation beside the scanner and watcher. Reusing the scanner functions prevents semantic drift.

### Run the scanner or rebuild after every write

This is disproportionate and would add avoidable latency. A single-path eligibility check is sufficient.

## Tests

Use test-driven development and demonstrate the regression before changing production code.

- `file.write`: configure an ignored TypeScript path, write it, and verify the file changes while `indexUpdate` is absent, graph revision does not advance, and no file or symbol graph state is created.
- `search.edit`: apply a prepared edit to a configured ignored TypeScript path and verify the edit succeeds while `indexUpdate` is absent and graph state remains unchanged.
- Run the existing eligible indexed-source and reconciliation-failure tests to prove synchronization and rollback contracts remain intact.

Update the public mutation-tool documentation to state that source files excluded by repository ignore patterns are written without a live graph update.

## Safe rebuild and verification

After build, focused tests, typecheck, and lint pass:

1. Stop the SDL-MCP process that owns the active Ladybug database.
2. Run `sdl-mcp index --force --safe-rebuild <absolute-new-path>` against a new database path.
3. Start SDL-MCP on the validated replacement database.
4. Confirm `repo.status` reports `graphIntegrityState: "verified"` and the verified revision equals the current revision.
5. Exercise ignored-path writes through both mutation surfaces and confirm graph integrity remains verified.

The existing failed database is not overwritten during the rebuild. Cutover occurs only after the replacement validates.

## Success criteria

- Both regression tests fail before the production change and pass afterward.
- Ignored writes do not call the live graph patcher or advance graph revision.
- Eligible writes and rollback-on-sync-failure behavior still pass.
- Documentation describes the ignore-aware mutation contract.
- The replacement production graph reports verified integrity before and after live acceptance checks.
