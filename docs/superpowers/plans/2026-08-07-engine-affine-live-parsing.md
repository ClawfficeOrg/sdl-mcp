# Engine-Affine Live Parsing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every live edit is parsed by the same parser identity contract that established its durable graph symbols, including native in-memory parsing and fail-closed provenance coverage.

**Architecture:** Add a content-based native parser capability, persist repository/file parser provenance beside the existing graph-integrity manifest, and dispatch live parsing by the recorded engine contract. Bind provenance coverage to the exact verified graph version/revision and reuse the existing fail-closed revision envelope instead of claiming cross-transaction atomicity.

**Tech Stack:** TypeScript/ESM, Node.js built-in test runner, Rust/napi-rs, tree-sitter, LadybugDB/Cypher.

**Approved design:** `docs/superpowers/specs/2026-08-07-engine-affine-live-parsing-design.md`

---

## File Structure

### New files

- src/db/ladybug-parser-provenance.ts — repository/file provenance records and exact coverage verification.
- src/db/migrations/m025-add-parser-provenance.ts — create-only provenance migration.
- src/indexer/parser-provenance.ts — engine and adapter identity contracts.
- src/live-index/draft-source-parser.ts — recorded-engine dispatch to the existing common graph shape.
- tests/unit/ladybug-parser-provenance.test.ts — DB ownership and exact coverage.
- tests/unit/parser-provenance.test.ts — built-in, plugin, and native contract selection.
- tests/unit/draft-source-parser.test.ts — dispatch and typed fail-closed errors.
- tests/native/parser-content-parity.test.ts — native disk/content canonical equality.
- tests/native/engine-affine-live-index.test.ts — non-skippable native .mjs integrity regression.

### Existing files modified

- Native parsing and declarations: native/src/types.rs, native/src/parse/mod.rs, native/src/lib.rs, native/index.d.ts.
- Native wrapper: src/indexer/rustIndexer.ts.
- Adapter contracts: src/indexer/adapter/registry.ts, src/indexer/adapter/plugin/types.ts, src/indexer/adapter/plugin/loader.ts.
- Errors: src/domain/errors.ts.
- Schema and lifecycle: src/db/ladybug-schema.ts, src/db/migrations/index.ts, src/db/ladybug-queries.ts, src/db/ladybug-derived-state.ts, src/db/ladybug-repos.ts, src/db/ladybug-shadow-finalization.ts.
- Pass 1 and verification: src/indexer/parser/types.ts, src/indexer/parser/batch-persist.ts, src/indexer/parser/process-file.ts, src/indexer/parser/rust-process-file.ts, src/indexer/provider-first/persisted-graph-integrity.ts.
- Live reconciliation: src/live-index/draft-parser.ts, src/live-index/file-patcher.ts.
- Diagnostics and scripts: tests/harness/engine-parity-runner.ts, tests/integration/engine-parity.test.ts, package.json.
- Focused unit/integration tests named in Tasks 1–8.
- Canonical documentation pages named in Task 9.

## Chunk 1: Native In-Memory Parser Contract

### Task 1: Add one safe content-based native parser

**Files:**
- Modify: native/src/types.rs
- Modify: native/src/parse/mod.rs
- Modify: native/src/lib.rs
- Modify: native/index.d.ts

- [ ] **Step 1: Write compiling failing Rust unit tests**

Inside native/src/parse/mod.rs, add a test-only disk helper that:
- builds a unique path under std::env::temp_dir() from the process ID and current UNIX-nanosecond timestamp;
- writes fixture.mjs with std::fs::write;
- calls the existing parse_single_file with a concrete NativeFileInput;
- removes the temporary file before returning.

Add a local canonical_native_file(&NativeParsedFile) -> serde_json::Value projection that explicitly includes contentHash, every symbol field, imports, calls, and parseError. This avoids adding PartialEq or serialization derives to production napi types only for a test.

The tests must cover:
- disk and planned parse_content_value produce equal canonical JSON for the same JavaScript;
- unsupported language produces the same parseError shape;
- oversized content is rejected at the shared boundary;
- parse_source_safe_with catches a supplied closure that panics and returns parseError.

- [ ] **Step 2: Prove the tests fail for the missing API**

Run:

    cargo test --manifest-path native/Cargo.toml parse_content

Expected: compile failure because NativeContentInput, parse_content_value, and parse_source_safe_with do not exist.

- [ ] **Step 3: Extract one shared safe parser**

Add NativeContentInput with repoId, relPath, language, and content. Refactor parse_single_file so only file reading remains disk-specific and both entry points call parse_source_safe.

Implement the panic seam as one internal generic helper:

    parse_source_safe_with(input, parse_impl)

Production parse_source_safe passes the existing unchecked tree-sitter/extraction function as parse_impl. The panic test passes a closure that panics. The helper owns catch_unwind and converts the panic to the same NativeParsedFile parseError contract; no test-only production flag is added.

The shared safe path must also own:
- content hash computation;
- MAX_PARSE_FILE_BYTES check;
- language/grammar lookup failure;
- tree-sitter parse failure;
- NativeParsedFile parseError construction.

Disk read errors stay in parse_single_file. parse_content_value and the napi parseContent export must not read absolutePath, create a temporary file, or call TypeScript.

Export PARSER_IDENTITY_CONTRACT_VERSION = 1 and parserIdentityContractVersion(). The contract number changes only when native symbol ID, AST fingerprint, range, or canonical identity semantics change.

- [ ] **Step 4: Regenerate and inspect declarations**

Run npm run build:native and confirm native/index.d.ts contains NativeContentInput, parseContent, and parserIdentityContractVersion. Do not hand-edit generated declarations unless the repository build intentionally requires that artifact to be checked in.

- [ ] **Step 5: Run native checks**

Run:

    cargo fmt --manifest-path native/Cargo.toml -- --check
    cargo test --manifest-path native/Cargo.toml parse_content
    npm run build:native

Expected: PASS.

- [ ] **Step 6: Commit**

    git add native/src/types.rs native/src/parse/mod.rs native/src/lib.rs native/index.d.ts
    git commit -m "feat(native): parse in-memory source content"

### Task 2: Expose a capability- and contract-checked TypeScript wrapper

**Files:**
- Modify: src/indexer/rustIndexer.ts
- Modify: tests/unit/rust-indexer.test.ts
- Create: tests/native/parser-content-parity.test.ts

- [ ] **Step 1: Write deterministic failing wrapper tests**

Use _resetNativeAddonLoaderForTests({ loadCandidate }) from src/native/addon-loader.ts plus the planned _resetRustIndexerForTests() before each case. Supply fake addons for:
- the current disk-only ABI;
- parseContent without parserIdentityContractVersion;
- parserIdentityContractVersion without parseContent;
- both functions with an older or newer contract number;
- both functions with the expected contract.

Assert every incomplete or mismatched addon reports content parsing unavailable while existing disk-backed parseFiles compatibility remains available.

- [ ] **Step 2: Build and prove focused tests fail**

Run:

    npm run build
    node --test tests/unit/rust-indexer.test.ts

Expected: FAIL because the content capability and rustIndexer reset APIs are absent.

- [ ] **Step 3: Add the smallest separate optional capability**

Leave isCompatibleNativeAddon and disk indexing requirements unchanged. Add optional NativeAddon members, EXPECTED_NATIVE_PARSER_IDENTITY_CONTRACT_VERSION, and a test-only _resetRustIndexerForTests() that clears the module's addon instance, loaded flag, source path, and reason so the existing loader seam can deterministically reload each fake addon.

Define the exact public unions:

    type NativeContentUnavailableReason =
      | "addon-unavailable"
      | "parse-content-missing"
      | "contract-version-missing"
      | "contract-version-mismatch";

    type NativeContentParserCapability =
      | { available: true; contract: "native:1" }
      | {
          available: false;
          reason: NativeContentUnavailableReason;
          expectedContract: "native:1";
          reportedContract?: number;
        };

    type NativeContentParseResult =
      | { available: true; contract: "native:1"; result: RustParseResult }
      | Extract<NativeContentParserCapability, { available: false }>;

getNativeContentParserCapability() and parseContentRust(input) return those shapes. Normalize relPath before invoking native code. A native parseError remains inside the available RustParseResult; it is not an availability failure. Never route a live candidate through parseFilesRust or a TypeScript fallback.

- [ ] **Step 4: Add an executable native parity test**

In tests/native/parser-content-parity.test.ts:
- create a temporary repository with mkdtempSync(join(tmpdir(), "sdl-native-content-"));
- write scripts/fixture.mjs with writeFileSync;
- import the built wrapper from ../../dist/indexer/rustIndexer.js;
- assert native disk and content capabilities are available;
- parse the same normalized relPath/content with parseFilesRust and parseContentRust;
- compare an explicit canonical projection containing content hash, symbol ID, AST fingerprint, range, signature, source-facing enrichment, imports, calls, and parse errors;
- remove the temporary directory in test cleanup.

This is a hard native-suite gate after npm run build:native; it must fail rather than skip when the addon or parseContent capability is unavailable.

- [ ] **Step 5: Run wrapper and native parity checks**

Run:

    npm run build:native
    npm run build
    node --test tests/unit/rust-indexer.test.ts
    node --test tests/native/parser-content-parity.test.ts
    npm run typecheck

Expected: PASS.

- [ ] **Step 6: Commit**

    git add src/indexer/rustIndexer.ts tests/unit/rust-indexer.test.ts tests/native/parser-content-parity.test.ts
    git commit -m "feat(indexer): expose native content parser capability"

## Chunk 2: Persisted Provenance and Verified Coverage

### Task 3: Define engine and adapter identity contracts

**Files:**
- Create: src/indexer/parser-provenance.ts
- Modify: src/domain/errors.ts
- Modify: src/indexer/adapter/registry.ts
- Modify: src/indexer/adapter/plugin/types.ts
- Modify: src/indexer/adapter/plugin/loader.ts
- Create: tests/unit/parser-provenance.test.ts
- Modify: tests/unit/plugin-registry.test.ts
- Modify: tests/unit/plugin-loader.test.ts

- [ ] **Step 1: Write failing provenance-selection tests**

Cover:
- .mjs selects native only when the expected in-memory native contract is available;
- a built-in TypeScript language records one explicit built-in adapter contract;
- a plugin adapter key changes when plugin identity, plugin package version, adapter identity, or adapter contract version changes;
- a contract-less legacy plugin still loads and performs full/index parsing;
- that same legacy plugin throws ParserAdapterContractError when asked to establish live-mutable provenance;
- changing any plugin identity component makes existing provenance incompatible.

- [ ] **Step 2: Build and prove focused tests fail**

Run:

    npm run build
    node --test tests/unit/parser-provenance.test.ts
    node --test tests/unit/plugin-registry.test.ts
    node --test tests/unit/plugin-loader.test.ts

Expected: FAIL because parser contracts and ParserAdapterContractError do not exist.

- [ ] **Step 3: Add the contract types and error at their first use**

Add ParserAdapterContractError to src/domain/errors.ts with a stable error code, repository-relative path support, required contract, and rebuild/recovery action.

In parser-provenance.ts define ParserEngine and ParserContract. The plugin adapterKey must be derived deterministically from:
- plugin identity;
- plugin package version;
- adapter identity;
- adapter contract version.

Use one explicit built-in TypeScript identity constant. Extend plugin metadata with optional contract fields so older plugins remain load/index compatible, but reject them only at live-mutable provenance selection.

- [ ] **Step 4: Reuse the existing registry**

Expose registration metadata beside the existing adapter instance/factory. Do not add a second registry, compatibility cache, or parallel adapter construction path.

- [ ] **Step 5: Run focused checks**

Run:

    npm run build
    node --test tests/unit/parser-provenance.test.ts
    node --test tests/unit/plugin-registry.test.ts
    node --test tests/unit/plugin-loader.test.ts
    npm run typecheck

Expected: PASS.

- [ ] **Step 6: Commit**

    git add src/indexer/parser-provenance.ts src/domain/errors.ts src/indexer/adapter/registry.ts src/indexer/adapter/plugin/types.ts src/indexer/adapter/plugin/loader.ts tests/unit/parser-provenance.test.ts tests/unit/plugin-registry.test.ts tests/unit/plugin-loader.test.ts
    git commit -m "feat(indexer): define parser identity contracts"

### Task 4: Add provenance schema and exact coverage verification

**Files:**
- Create: src/db/migrations/m025-add-parser-provenance.ts
- Create: src/db/ladybug-parser-provenance.ts
- Modify: src/db/migrations/index.ts
- Modify: src/db/ladybug-schema.ts
- Modify: src/db/ladybug-queries.ts
- Modify: src/db/ladybug-derived-state.ts
- Modify: src/db/ladybug-shadow-finalization.ts
- Modify: src/db/ladybug-repos.ts
- Create: tests/unit/ladybug-parser-provenance.test.ts
- Modify: tests/unit/ladybug-schema.test.ts
- Modify: tests/unit/migration-fresh-db.test.ts
- Modify: tests/unit/migration-graph-integrity.test.ts
- Modify: tests/unit/ladybug-repo-delete-exhaustive.test.ts

- [ ] **Step 1: Write failing schema and persistence tests**

Define FileParserStateRecord with stateId, repoId, fileId, engine, engineContract, adapterKey, and language. Define RepoParserStateRecord with coverageState, graphVersionId, graphRevision, and coverageDigest.

Tests must prove:
- upsert/get/delete is repository-owned and one-to-one by file;
- zero, duplicate, orphan, cross-repository, and wrong-file states fail exact coverage;
- equal counts with different file IDs fail;
- ordered membership yields a deterministic digest;
- fresh schema and migration 25 create the same objects and rerun idempotently;
- repository deletion removes all new nodes and relationships.

- [ ] **Step 2: Build and prove DB tests fail**

Run:

    npm run build
    node --test tests/unit/ladybug-parser-provenance.test.ts
    node --test tests/unit/ladybug-schema.test.ts
    node --test tests/unit/migration-fresh-db.test.ts
    node --test tests/unit/migration-graph-integrity.test.ts
    node --test tests/unit/ladybug-repo-delete-exhaustive.test.ts

Expected: FAIL because migration 25 and provenance queries do not exist.

- [ ] **Step 3: Add create-only schema objects**

Create RepoParserState, FileParserState, REPO_PARSER_STATE_IN_REPO, and FILE_PARSER_STATE_IN_REPO. Register m025 after m024 without renumbering older migrations. Follow the existing create-only and IDEMPOTENT_DDL_ERROR_RE patterns.

- [ ] **Step 4: Implement exact coverage in one ordered query path**

Verify the exact repository file/state membership, not counts. Reject:
- files with zero states;
- files with multiple logical states;
- states whose file is absent;
- state/file ownership mismatches.

Compute coverageDigest from ordered tuples of fileId, engine, engineContract, adapterKey, and language.

- [ ] **Step 5: Add an in-transaction integrity publication helper**

In ladybug-derived-state.ts, extract markGraphIntegrityVerifiedInTransactionIfVerifying(conn, repoId, versionId, revision, digest) from the existing markGraphIntegrityVerifiedIfVerifying implementation. Keep the public wrapper for existing callers.

The in-transaction helper must verify ownership is still the same verifying version/revision and return false without publication when ownership changed.

- [ ] **Step 6: Define shadow-family source of truth**

During safe rebuild:
- retain/copy the per-file FileParserState rows produced inside the shadow family;
- do not copy an active-family RepoParserState.complete row into the shadow family;
- run exact shadow graph plus parser-state coverage verification;
- create the shadow RepoParserState.complete row only for the shadow version/revision after that verification;
- promote only that verified shadow family.

Add a test where active coverage is complete but shadow coverage is missing one file; promotion must fail.

- [ ] **Step 7: Integrate deletion and cleanup**

Delete file provenance through the shared deleteFilesByIds path before deleting File rows. Include both state tables and relationships in exhaustive repository deletion and shadow validation.

- [ ] **Step 8: Run DB and rebuild tests**

Run:

    npm run build
    node --test tests/unit/ladybug-parser-provenance.test.ts
    node --test tests/unit/ladybug-schema.test.ts
    node --test tests/unit/migration-fresh-db.test.ts
    node --test tests/unit/migration-graph-integrity.test.ts
    node --test tests/unit/ladybug-repo-delete-exhaustive.test.ts
    node --test tests/unit/ladybug-safe-rebuild.test.ts
    npm run typecheck

Expected: PASS.

- [ ] **Step 9: Commit**

    git add src/db/migrations/m025-add-parser-provenance.ts src/db/ladybug-parser-provenance.ts src/db/migrations/index.ts src/db/ladybug-schema.ts src/db/ladybug-queries.ts src/db/ladybug-derived-state.ts src/db/ladybug-shadow-finalization.ts src/db/ladybug-repos.ts tests/unit/ladybug-parser-provenance.test.ts tests/unit/ladybug-schema.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/ladybug-repo-delete-exhaustive.test.ts tests/unit/ladybug-safe-rebuild.test.ts
    git commit -m "feat(db): persist parser provenance coverage"

### Task 5: Populate provenance and publish it atomically with integrity

**Files:**
- Modify: src/indexer/parser/types.ts
- Modify: src/indexer/parser/batch-persist.ts
- Modify: src/indexer/parser/process-file.ts
- Modify: src/indexer/parser/rust-process-file.ts
- Modify: src/indexer/provider-first/persisted-graph-integrity.ts
- Modify: tests/unit/batch-persist.test.ts
- Modify: tests/unit/persisted-graph-integrity.test.ts
- Modify: tests/unit/provider-first-indexing.test.ts
- Modify: tests/unit/plugin-registry.test.ts

- [ ] **Step 1: Write failing pass-1 coverage tests**

Assert:
- native and built-in TypeScript process-file results enqueue the correct FileParserState;
- a contract-bearing plugin records its complete adapterKey;
- a contract-less plugin can still load/index but cannot produce complete live-mutable provenance;
- skipped unchanged files retain the persisted state rather than selecting a new engine contract;
- every processed file row and its parser state use the existing accumulator transaction.

- [ ] **Step 2: Build and prove focused tests fail**

Run:

    npm run build
    node --test tests/unit/batch-persist.test.ts
    node --test tests/unit/provider-first-indexing.test.ts
    node --test tests/unit/plugin-registry.test.ts
    node --test tests/unit/persisted-graph-integrity.test.ts

Expected: FAIL because pass 1 does not persist provenance or publish coverage.

- [ ] **Step 3: Extend the existing accumulator only**

Add parser state to the existing per-file batch unit and its transaction. Do not add a second queue, drain loop, or background worker.

For an unchanged file, validate and reuse its durable parser state. A missing or incompatible state keeps repository coverage incomplete and requires rebuild; it must not be inferred from current addon availability.

- [ ] **Step 4: Publish coverage and graph verification in one transaction**

After the persisted graph digest and exact parser coverage both match, completeGraphIntegrityVerification must open one write transaction that:
1. rechecks the owned verifying version/revision;
2. upserts RepoParserState.complete with that exact version, revision, and coverage digest;
3. calls markGraphIntegrityVerifiedInTransactionIfVerifying on the same connection.

If any write fails, or ownership changes, roll back both publications. If coverage verification fails, record the graph-integrity failure through the existing failure path and leave repository coverage incomplete.

- [ ] **Step 5: Add publication failure injection**

Inject failures:
- before RepoParserState upsert;
- after RepoParserState upsert but before graph publication;
- during graph publication;
- after verification ownership changes.

Assert no transaction leaves graph verified without matching complete parser coverage, or complete coverage without matching graph verified.

- [ ] **Step 6: Run focused checks**

Run:

    npm run build
    node --test tests/unit/batch-persist.test.ts
    node --test tests/unit/persisted-graph-integrity.test.ts
    node --test tests/unit/provider-first-indexing.test.ts
    node --test tests/unit/plugin-registry.test.ts
    npm run typecheck

Expected: PASS.

- [ ] **Step 7: Commit**

    git add src/indexer/parser/types.ts src/indexer/parser/batch-persist.ts src/indexer/parser/process-file.ts src/indexer/parser/rust-process-file.ts src/indexer/provider-first/persisted-graph-integrity.ts tests/unit/batch-persist.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/plugin-registry.test.ts
    git commit -m "feat(indexer): bind parser provenance to graph verification"

## Chunk 3: Engine-Affine Live Reconciliation

### Task 6: Add typed preflight errors and engine dispatch

**Files:**
- Modify: src/domain/errors.ts
- Create: src/live-index/draft-source-parser.ts
- Create: tests/unit/draft-source-parser.test.ts

- [ ] **Step 1: Write failing dispatch and error-contract tests**

Cover:
- unavailable recorded native engine;
- native contract mismatch;
- built-in TypeScript dispatch;
- contract-bearing plugin dispatch;
- native parse failure without TypeScript fallback.

For every typed failure, assert:
- a stable error code;
- the normalized repository-relative path;
- the required engine/adapter contract;
- a rebuild or recovery action;
- no absolute workspace path in message or serialized details.

- [ ] **Step 2: Build and prove the test fails**

Run:

    npm run build
    node --test tests/unit/draft-source-parser.test.ts

Expected: FAIL because the dispatch boundary and remaining typed errors do not exist.

- [ ] **Step 3: Add only the remaining typed errors**

ParserAdapterContractError already exists from Task 3. Add ParserProvenanceIncompleteError, ParserFileStateMissingError, ParserEngineUnavailableError, ParserContractMismatchError, and ParserSymbolRemapError as IndexError subclasses.

- [ ] **Step 4: Implement one dispatch boundary**

Create DraftSourceExtraction containing the selected ParserContract plus the existing symbols, imports, calls, and optional TypeScript tree.

Native output must retain native symbolId and astFingerprint. TypeScript/plugin output uses the recorded adapter. Do not regenerate native fingerprints through resolveSymbolNodeForFingerprint and do not fall back across engines.

- [ ] **Step 5: Run exact focused checks**

Run:

    npm run build
    node --test tests/unit/draft-source-parser.test.ts
    npm run typecheck

Expected: PASS.

- [ ] **Step 6: Commit**

    git add src/domain/errors.ts src/live-index/draft-source-parser.ts tests/unit/draft-source-parser.test.ts
    git commit -m "feat(live-index): dispatch by parser identity contract"

### Task 7: Integrate provenance with draft parsing and saved-file patching

**Files:**
- Modify: src/live-index/draft-parser.ts
- Modify: src/live-index/file-patcher.ts
- Modify: tests/unit/draft-parser.test.ts
- Modify: tests/unit/file-patcher.test.ts
- Modify: tests/integration/saved-file-graph-patch.test.ts

- [ ] **Step 1: Write failing preflight tests**

Before parsing or beginning a graph-integrity revision, require all of:
- graphIntegrityState is verified;
- graphIntegrityRevision equals graphIntegrityVerifiedRevision;
- RepoParserState.coverageState is complete;
- RepoParserState.graphVersionId equals graphIntegrityVersionId;
- RepoParserState.graphRevision equals graphIntegrityVerifiedRevision;
- an existing file has exactly one FileParserState owned by the same repository;
- that file state matches the available engine/adapter contract.

Use parse and write spies to prove every failure rejects before parseDraftSource, beginGraphIntegrityRevision, or any DB write.

A genuinely new file may select a contract only after repository preflight passes.

- [ ] **Step 2: Write failing lifecycle and remap tests**

Cover:
- existing native file stays native;
- existing TypeScript file stays TypeScript even when native is available;
- new native-supported file selects and persists native;
- new plugin file selects its declared contract;
- unique same-position symbol match retains the durable ID;
- moved symbol is unmatched, receives the selected engine ID, and removes the old symbol;
- ambiguous and duplicate remaps reject before persistence;
- delete removes the file state;
- rename is delete-old plus add-new;
- extension/language change deletes old state and creates newly selected state;
- no rename or extension path transfers or leaves an orphan state;
- Windows backslash and slash forms normalize to one lifecycle identity.

- [ ] **Step 3: Build and prove focused tests fail**

Run:

    npm run build
    node --test tests/unit/draft-parser.test.ts
    node --test tests/unit/file-patcher.test.ts
    node --test tests/integration/saved-file-graph-patch.test.ts

Expected: FAIL on missing provenance preflight and lifecycle behavior.

- [ ] **Step 4: Route live parsing through recorded provenance**

Load the verified integrity baseline and RepoParserState once, enforce the Step 1 predicates, normalize the candidate path, then:
- load exactly one durable FileParserState for an existing file;
- select a new contract for a genuinely new file;
- call draft-source-parser with that contract;
- preserve an old ID only for a unique kind:name:startLine:startCol match under the same engine contract.

The selected engine remains authoritative for fingerprint, range, signature, language, test facet, and every canonical field. Detect one-to-many and many-to-one remaps before mutation.

- [ ] **Step 5: Persist provenance in the owned revision**

Build the integrity expectation from the exact post-remap SymbolRow values passed to upsertSymbolBatch. Persist FileParserState in the existing owned revision phases. Delete old provenance before deleting a renamed, language-changed, or removed File.

Do not advance RepoParserState coverage during mutation; the background verifier publishes it together with graph verified.

- [ ] **Step 6: Add complete phase-failure coverage**

Inject failure in each committed phase:
- file;
- symbol;
- edge;
- provenance;
- manifest;
- verification;
- final publication.

For every case, wait for cleanup and assert:
- graphIntegrityState is failed, never left verifying;
- verified revision did not advance;
- RepoParserState remains bound to the prior verified revision;
- no false complete coverage was published;
- the next mutation is refused.

- [ ] **Step 7: Run focused checks**

Run:

    npm run build
    node --test tests/unit/draft-parser.test.ts
    node --test tests/unit/file-patcher.test.ts
    node --test tests/integration/saved-file-graph-patch.test.ts
    npm run typecheck

Expected: PASS.

- [ ] **Step 8: Commit**

    git add src/live-index/draft-parser.ts src/live-index/file-patcher.ts tests/unit/draft-parser.test.ts tests/unit/file-patcher.test.ts tests/integration/saved-file-graph-patch.test.ts
    git commit -m "fix(live-index): keep parser identity engine-affine"

### Task 8: Add a non-skippable native-backed integrity regression

**Files:**
- Create: tests/native/engine-affine-live-index.test.ts
- Modify: tests/harness/engine-parity-runner.ts
- Modify: tests/integration/engine-parity.test.ts
- Modify: package.json

- [ ] **Step 1: Write the failing native .mjs regression**

The test must:
- fail immediately if the native addon or expected parseContent contract is unavailable;
- create a temporary repository containing scripts/run-tests.mjs;
- build the graph through the native pass;
- assert FileParserState.engine is native and engineContract is the expected native contract;
- apply a saved-file live edit;
- wait for the background verifier;
- assert graphIntegrityState is verified and current revision equals verified revision;
- assert RepoParserState version/revision equals the verified graph;
- assert expected and persisted file digests and symbol counts match.

No skip or TypeScript fallback is allowed.

- [ ] **Step 2: Add an explicit native test script and prove failure**

Add test:native-live-index to package.json. Include it in test:native after build:native and build output are ready.

Run:

    npm run build:native
    npm run build
    npm run test:native-live-index

Expected: FAIL before live engine affinity is implemented.

- [ ] **Step 3: Make cross-engine differences visible, not equal**

In the diagnostic parity harness, report symbolId and astFingerprint differences explicitly instead of silently excluding them. Keep cross-engine comparison diagnostic; do not require Rust and TypeScript equality. Native disk-versus-content parity remains the hard equality gate.

- [ ] **Step 4: Run native and diagnostic checks**

Run:

    npm run build:native
    npm run build
    npm run test:native-live-index
    npm run test:parity

Expected: PASS.

- [ ] **Step 5: Commit**

    git add tests/native/engine-affine-live-index.test.ts tests/harness/engine-parity-runner.ts tests/integration/engine-parity.test.ts package.json
    git commit -m "test(live-index): cover native mjs integrity"

## Chunk 4: Documentation and Release Verification

### Task 9: Update the canonical documentation

**Files:**
- Modify: docs/feature-deep-dives/live-indexing.md
- Modify: docs/feature-deep-dives/indexing-languages.md
- Modify: docs/feature-deep-dives/provider-first-indexing.md
- Modify: docs/architecture.md
- Modify: docs/symbol-edit-tool.md
- Modify: docs/canonical-extractor-contract.md
- Modify: docs/plugin-sdk-author-guide.md
- Modify: docs/plugin-sdk-quick-reference.md
- Modify: docs/plugin-sdk-security.md
- Modify: CHANGELOG.md

- [ ] **Step 1: Update existing architecture pages**

Document:
- engine-affine live parsing and why cross-engine fallback is forbidden;
- the native in-memory parseContent capability and parser contract;
- repository/file provenance coverage;
- graph verification and provenance publication advancing together;
- saved-file reconciliation as a multi-phase revision envelope, correcting any atomic-foreground-transaction wording;
- the canonical extractor contract fields and diagnostic cross-engine parity behavior;
- the one-time safe rebuild required for pre-provenance indexes;
- fail-closed errors and recovery;
- plugin identity, package version, adapter identity, and adapter contract requirements.

Do not create duplicate architecture pages and do not claim an already-failed graph is repaired automatically.

- [ ] **Step 2: Add the Unreleased changelog entry**

Classify the change as a graph-integrity correctness fix with a migration and rebuild note.

- [ ] **Step 3: Run exact documentation checks**

Run:

    npm run check:schema-sync
    npm run docs:language-support:check
    npm run docs:tools:check

Expected: PASS.

- [ ] **Step 4: Commit**

    git add docs/feature-deep-dives/live-indexing.md docs/feature-deep-dives/indexing-languages.md docs/feature-deep-dives/provider-first-indexing.md docs/architecture.md docs/symbol-edit-tool.md docs/canonical-extractor-contract.md docs/plugin-sdk-author-guide.md docs/plugin-sdk-quick-reference.md docs/plugin-sdk-security.md CHANGELOG.md
    git commit -m "docs: explain engine-affine live parsing"

### Task 10: Run proportionate final verification

**Files:**
- No source changes unless a verification failure proves a defect in this implementation.

- [ ] **Step 1: Run Rust, build, type, and lint gates**

Run:

    cargo fmt --manifest-path native/Cargo.toml -- --check
    npm run build
    npm run typecheck
    npm run lint

Expected: PASS.

- [ ] **Step 2: Run provenance and live-index suites**

Run:

    node --test tests/unit/parser-provenance.test.ts
    node --test tests/unit/ladybug-parser-provenance.test.ts
    node --test tests/unit/migration-fresh-db.test.ts
    node --test tests/unit/migration-graph-integrity.test.ts
    node --test tests/unit/persisted-graph-integrity.test.ts
    node --test tests/unit/draft-source-parser.test.ts
    node --test tests/unit/draft-parser.test.ts
    node --test tests/unit/file-patcher.test.ts
    node --test tests/integration/saved-file-graph-patch.test.ts

Expected: PASS.

- [ ] **Step 3: Run non-skippable native verification**

Run:

    npm run build:native
    cargo test --manifest-path native/Cargo.toml parse_content_matches_disk_parse
    npm run build
    node --test tests/native/parser-content-parity.test.ts
    npm run test:native-live-index
    npm run test:native

Expected: PASS on the supported Windows native environment. The two engine-affinity native tests must fail, not skip, if the required addon contract is absent.

- [ ] **Step 4: Run the repository release gate**

Run:

    npm run prepare-release

Expected: PASS. If the gate cannot be completed, report it as unrun or failed with preserved output; do not claim completion.

- [ ] **Step 5: Verify Git state**

Run:

    git status --short --branch
    git log --oneline --decorate -10

Expected: clean codex/engine-affine-live-parsing worktree with only the planned commits.
