# Engine-affine live parsing design

Date: 2026-08-07
Status: Approved for implementation

## Problem

Full indexing uses the native Rust parser when it is available, while live edits always parse the candidate in-memory text through the TypeScript adapter. The two engines currently agree on the extracted symbols, imports, and calls for `scripts/run-tests.mjs`, but they produce different AST fingerprints and symbol IDs. Those identity fields participate in the persisted graph-integrity digest.

The live parser attempts to preserve a durable symbol ID by matching kind, name, and start position, then combines that ID with a TypeScript-generated fingerprint. This crosses parser identity domains inside a graph established by the native engine. The first live edit of `scripts/run-tests.mjs` advanced graph-integrity revision 4 to revision 5 with equal symbol counts but a different file digest.

## Goals

- Parse a live edit with the same parser engine and identity contract that established the durable file.
- Let the native engine parse supplied in-memory text without reading stale disk content.
- Preserve the optional-native-addon contract and TypeScript/plugin-language support.
- Fail before mutation when provenance coverage, the required parser engine, or its identity contract is unavailable.
- Cover the exact identity fields used by graph-integrity hashing.

## Non-goals

- Remove the TypeScript parser or plugin adapter system.
- Make every TypeScript and Rust extraction implementation identical.
- Repair or rebuild an already-failed graph in place.
- Change watcher scheduling, edit batching, or graph-integrity recovery policy.

## Design

### Native in-memory parsing

Add an explicit native `parseContent` entry point accepting repository ID, normalized repository-relative path, language, and UTF-8 content. It reuses the same Rust parsing, extraction, fingerprint, enrichment, and symbol-ID implementation as disk-backed `parseFiles`, but never reads the filesystem.

Expose it through `rustIndexer.ts` as a capability-checked wrapper. The native addon also exposes its parser identity contract version. Compatibility requires both `parseContent` and the expected contract version; older or unavailable addons must never silently fall back to disk parsing for a live candidate buffer.

### Persisted parser provenance

Add two small persisted state records rather than altering the existing `File` table:

- `RepoParserState`, keyed by repository, records whether parser provenance covers the complete indexed graph.
- `FileParserState`, keyed by repository and file identity, records the engine contract that created the file's canonical symbols.

`FileParserState` contains:

- `stateId`
- `repoId`
- `fileId`
- `engine`: `native` or `typescript`
- `engineContract`: an engine-supplied identity contract, not an application release number
- `adapterKey`: built-in language adapter identity or plugin name/version/adapter identity
- `language`

Both records relate to their owning repository using the existing manifest-state ownership pattern. A create-table migration adds the state nodes and relationships; no existing table is altered.

The native contract identifies the fingerprint, symbol-ID, range, and canonical field semantics implemented by the loaded addon. TypeScript built-ins use an explicit adapter contract constant. Plugin adapters use a stable key derived from plugin identity, plugin version, adapter identity, and adapter contract version; plugins without this metadata remain readable but cannot establish a live-mutable provenance state.

Full and incremental indexing write one `FileParserState` for every processed file. Native results record the native contract; TypeScript and plugin adapters record their adapter contract. After the final graph-integrity verification proves the persisted graph and provenance coverage, `RepoParserState.coverageState` becomes `complete`.

A repository with missing or incomplete provenance remains readable but no live mutation may begin. Existing indexes therefore have one deterministic behavior: rebuild once to establish complete coverage. Incremental indexing cannot make only a subset of a legacy graph live-mutable.

### File-state lifecycle

There is exactly one parser state per durable file identity.

- Content edit at the same normalized path retains the existing state and must use its recorded engine contract.
- New file selects native only when the language and in-memory native capability are available; otherwise it selects a contract-bearing TypeScript adapter.
- Delete removes the file parser state in the same graph-integrity revision as the file, symbols, edges, and manifest entry.
- Rename is delete-old plus add-new. Provenance is not transferred because normalized path contributes to file and symbol identity.
- Extension or language change is also delete-old plus add-new and selects a new engine contract.
- A plugin or engine contract change never rewrites provenance in place; it requires a rebuild.

### Live dispatch and canonical identity

Draft parsing is split into engine dispatch and common graph assembly:

1. Confirm graph integrity is verified and repository provenance coverage is complete.
2. Load the durable file and its parser state.
3. Select the recorded engine contract, or select a contract for a genuinely new file.
4. Parse the supplied candidate content with that engine.
5. Convert either parser result into the existing common symbol/import/call representation.
6. Build references, placeholders, edges, summaries, and the graph-integrity expectation through the existing live-index code.
7. Persist the file patch and provenance under the existing graph-integrity revision envelope.
8. Verify the persisted graph and provenance coverage before advancing the verified revision.

All paths are normalized with the existing path helpers before parser dispatch, durable matching, or identity generation.

For a same-file symbol with a unique durable match on kind, name, start line, and start column, the persisted symbol ID remains authoritative only when the recorded engine and engine contract match the selected parser. The selected engine remains authoritative for AST fingerprint, range, signature, language, test facet, and other canonical fields. New or unmatched symbols use the selected engine's generated ID. Ambiguous matches, duplicate remaps, or engine-contract mismatches reject the edit before persistence.

The graph-integrity expectation is built from the exact post-remap rows submitted for persistence. It must not independently regenerate identities through a different parser path.

### Transaction and failure behavior

LadybugDB live reconciliation uses multiple committed write phases, so the design does not claim cross-phase atomicity. Safety comes from the graph-integrity revision envelope:

1. Mark the next revision `verifying`.
2. Apply file, symbol, edge, provenance, and manifest phases in their existing safe order.
3. Capture and compare the persisted graph plus provenance coverage.
4. Mark both graph integrity and repository provenance coverage complete only after verification.
5. On any interruption or error, mark the revision failed; subsequent mutation remains blocked.

Full safe rebuilds establish provenance inside the replacement family before promotion. Ordinary incremental indexing follows the same verifying/verified boundary.

Stable typed errors cover:

- incomplete or missing repository provenance;
- missing file provenance;
- unavailable required engine;
- engine contract mismatch;
- unsupported or contract-less adapter;
- ambiguous durable-symbol remapping.

Errors identify the repository-relative file, required engine contract, and recovery action without exposing absolute machine paths in MCP responses. Native parse failure never falls back across engines.

## Compatibility and migration

The migration creates empty provenance storage but does not infer historical engine choices. Existing indexes require a full safe rebuild before live mutation. Read-only graph operations remain available under the existing integrity rules.

Engine contract versions change only when fingerprint, symbol-ID, range, or canonical identity semantics change. Ordinary application releases do not force rebuilds.

The separate state nodes are intentional: LadybugDB does not support the required in-place `File` table alteration across existing families, and provenance coverage has a repository-level completion state that does not belong on individual file rows.

## Verification

- Native unit test: in-memory and disk-backed native parsing produce identical graph-integrity canonical symbols for the same content.
- Capability tests: missing `parseContent`, native contract mismatch, and plugin contract changes fail before mutation.
- Provenance persistence tests: native, built-in TypeScript, plugin, missing-file-state, incomplete-repository-state, and contract-version cases.
- Lifecycle tests: new, edited, deleted, renamed, and extension-changed files produce the specified parser-state transitions.
- Durable-ID tests: unchanged matches retain IDs, moved symbols follow the defined unmatched behavior, and ambiguous or duplicate remaps fail closed.
- Integration regression: build a native-backed graph, live-edit an `.mjs` file, wait for background verification, and assert graph integrity and provenance coverage advance together with matching counts and digests.
- Recovery test: interrupt each committed live-write phase and assert the revision remains failed and further mutation is blocked.
- Existing TypeScript-only, native-disabled, and plugin-adapter live-index suites remain green.
- The native/TypeScript diagnostic harness reports every graph-integrity canonical field, including symbol ID and AST fingerprint; critical differences may be explicitly reported but are never silently excluded.

## Documentation

Update the live-index, graph-integrity, plugin-adapter, and native-addon architecture notes to describe engine affinity, provenance coverage, the in-memory native capability, failure behavior, and the rebuild requirement for indexes without parser provenance.
