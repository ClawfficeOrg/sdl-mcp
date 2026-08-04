# Ignore-Aware Live Index Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `file.write` and `search.edit` from live-patching graph state for repository-ignored source paths, then replace the failed production graph through a fail-closed safe rebuild.

**Architecture:** Keep both mutation callers unchanged and add one eligibility guard inside their shared `syncLiveIndex()` boundary. Reuse the scanner's existing glob compiler and ignore predicate, parsing only the stored `ignore` field so legacy partial config rows remain valid while malformed JSON still returns the existing failed `indexUpdate`.

**Tech Stack:** TypeScript, Node.js built-in test runner, LadybugDB, Zod, SDL-MCP CLI.

---

## Chunk 1: Regression, repair, and recovery

### File map

- Modify `src/indexer/fileWalker.ts`: export the scanner's existing pure ignore helpers.
- Modify `src/mcp/tools/file-write-internals.ts`: load the stored repo ignore list and skip live sync for ignored source paths.
- Modify `tests/integration/file-write-tool.test.ts`: prove ignored `file.write` changes the file without changing graph state.
- Modify `tests/integration/search-edit-tool.test.ts`: prove eligible public preview/apply syncs and ignored public preview/apply does not.
- Modify `docs/mcp-tools-reference.md`: document when `file.write` omits `indexUpdate`.
- Modify `docs/search-edit-tool.md`: document ignored-path behavior and preserve the caller-specific live-sync failure contract.
- No new source files, dependencies, configuration options, or graph abstractions.

### Task 1: Add the failing `file.write` regression

**Files:**
- Test: `tests/integration/file-write-tool.test.ts`

- [ ] **Step 1: Add an ignored-source integration test**

Add a test beside the existing indexed TypeScript graph tests. Establish an empty verified manifest, change the stored repo config to `ignore: ["ignored/**"]`, and capture the graph boundary before the write:

```ts
const relPath = "ignored/file-write-target.ts";
const fileId = generateFileId(repoId, relPath);
const conn = await getLadybugConn();
const baseline = await capturePersistedGraphIntegrity(conn, repoId);

await ladybugDb.createVersion(conn, {
  versionId: "v-ignored-file-write",
  repoId,
  createdAt: "2026-08-04T00:00:00.000Z",
  reason: "ignored file.write baseline",
  prevVersionHash: null,
  versionHash: null,
});
await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
  files: [],
  fileless: [],
});
await markGraphIntegrityVerified(
  repoId,
  "v-ignored-file-write",
  baseline.digest,
);
```

Write valid TypeScript through `handleFileWrite()`, then assert all boundary state stays unchanged:

```ts
const beforeState = await getDerivedState(repoId);
const beforeFiles = await ladybugDb.listGraphIntegrityFileStates(conn, repoId);
const beforeFileless =
  await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId);
const beforeGraph = await capturePersistedGraphIntegrity(conn, repoId);

const response = await handleFileWrite({
  repoId,
  filePath: relPath,
  content: "export const ignoredWrite = 2;\n",
  createIfMissing: true,
  createBackup: false,
});

assert.equal(response.indexUpdate, undefined);
assert.equal(readFileSync(join(testDir, relPath), "utf-8"),
  "export const ignoredWrite = 2;\n");
assert.equal(await ladybugDb.getFileByRepoPath(conn, repoId, relPath), null);
assert.deepEqual(await ladybugDb.getSymbolsByFile(conn, fileId), []);
assert.deepEqual(
  await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
  beforeFiles,
);
assert.deepEqual(
  await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
  beforeFileless,
);
assert.equal(
  (await capturePersistedGraphIntegrity(conn, repoId)).digest,
  beforeGraph.digest,
);
assert.deepEqual(await getDerivedState(repoId), beforeState);
```

- [ ] **Step 2: Build current production code**

Run:

```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 3: Run the focused test and record RED**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON = "1"
node --experimental-strip-types --test-concurrency=1 --test tests/integration/file-write-tool.test.ts
```

Expected before the fix: FAIL because `response.indexUpdate` is present and graph revision/state advances.

### Task 2: Add the failing public `search.edit` regression

**Files:**
- Test: `tests/integration/search-edit-tool.test.ts`

- [ ] **Step 1: Extend imports and teardown**

Import `getDerivedState`, `generateFileId`, `capturePersistedGraphIntegrity`, and the background-verifier cancellation helper already used by the `file.write` integration test. Cancel the verifier for `REPO_ID` before closing the test database.

- [ ] **Step 2: Add one public eligible-then-ignored test**

Use `handleSearchEdit()` for both preview and apply. First edit `src/eligible-search-edit.ts` with a literal `filters.include: [eligibleRelPath]`; assert the written result has `indexUpdate.applied === true` and graph revision advances. Wait until the verified revision catches up.

Then store `{"ignore":["ignored/**"]}`, create `ignored/search-edit-target.ts`, capture revision, File/Symbol rows, manifest rows, and graph digest, preview it with literal `filters.include: [ignoredRelPath]`, apply that preview's `planHandle`, and assert:

```ts
const ignoredResult = ignoredApply.results.find(
  (entry) => entry.file === ignoredRelPath,
);
assert.equal(ignoredResult?.status, "written");
assert.equal(ignoredResult?.indexUpdate, undefined);
assert.equal(
  await readFile(join(repoRoot, ignoredRelPath), "utf-8"),
  "export const ignoredAfter = 2;\n",
);
assert.equal(
  await ladybugDb.getFileByRepoPath(conn, REPO_ID, ignoredRelPath),
  null,
);
assert.deepEqual(
  await ladybugDb.getSymbolsByFile(
    conn,
    generateFileId(REPO_ID, ignoredRelPath),
  ),
  [],
);
assert.equal((await getDerivedState(REPO_ID))?.graphIntegrityRevision,
  beforeIgnoredRevision);
assert.deepEqual(
  await ladybugDb.listGraphIntegrityFileStates(conn, REPO_ID),
  beforeIgnoredManifestFiles,
);
assert.deepEqual(
  await ladybugDb.listGraphIntegrityFilelessStates(conn, REPO_ID),
  beforeIgnoredManifestFileless,
);
assert.equal(
  (await capturePersistedGraphIntegrity(conn, REPO_ID)).digest,
  beforeIgnoredDigest,
);
```

Restore the stored config in `finally` so later tests keep their current fixture contract.

- [ ] **Step 3: Rebuild tests against unchanged production code**

Run:

```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 4: Run the focused test and record RED**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON = "1"
node --experimental-strip-types --test-concurrency=1 --test tests/integration/search-edit-tool.test.ts
```

Expected before the fix: FAIL in the ignored half because `indexUpdate.applied` is true and graph state advances. The eligible half must pass.

### Task 3: Implement the minimum shared-boundary repair

**Files:**
- Modify: `src/indexer/fileWalker.ts:29-52`
- Modify: `src/mcp/tools/file-write-internals.ts:1-20,533-565`
- Test: `tests/integration/file-write-tool.test.ts`
- Test: `tests/integration/search-edit-tool.test.ts`

- [ ] **Step 1: Export the scanner helpers without changing behavior**

```ts
export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => globToSafeRegex(pattern));
}

export function shouldIgnorePath(
  path: string,
  ignorePatterns: RegExp[],
  isDirectory: boolean,
): boolean {
  // existing body unchanged
}
```

- [ ] **Step 2: Add the guard inside `syncLiveIndex()`**

Import `RepoConfigSchema`, `compilePatterns`, and `shouldIgnorePath`. Keep the extension fast-path outside the `try`; inside the existing error boundary, add:

```ts
const conn = await getLadybugConn();
const repo = await ladybugDb.getRepo(conn, repoId);
if (!repo) {
  throw new NotFoundError(`Repository ${repoId} not found`);
}
const { ignore } = RepoConfigSchema.pick({ ignore: true }).parse(
  JSON.parse(repo.configJson),
);
if (shouldIgnorePath(relPath, compilePatterns(ignore), false)) {
  return undefined;
}
```

Do not change either caller. Do not parse the full `RepoConfigSchema`: stored partial rows such as `"{}"` are an existing supported test/runtime boundary, while malformed JSON must still be caught and surfaced as `{ applied: false }`.

- [ ] **Step 3: Run both focused tests and record GREEN**

Run:

```powershell
npm run build
$env:SDL_MCP_DISABLE_NATIVE_ADDON = "1"
node --experimental-strip-types --test-concurrency=1 --test tests/integration/file-write-tool.test.ts tests/integration/search-edit-tool.test.ts
```

Expected: both files pass, including existing eligible-source and malformed-config rollback tests.

- [ ] **Step 4: Commit the code and regression tests**

```powershell
git add -- src/indexer/fileWalker.ts src/mcp/tools/file-write-internals.ts tests/integration/file-write-tool.test.ts tests/integration/search-edit-tool.test.ts
git commit -m "fix(indexer): skip ignored live index writes"
```

### Task 4: Document and verify the mutation contract

**Files:**
- Modify: `docs/mcp-tools-reference.md:1144-1149`
- Modify: `docs/search-edit-tool.md:358-364`

- [ ] **Step 1: Update public documentation**

State that source files matching repository ignore patterns are still written but omit `indexUpdate` because no live graph patch is attempted.

Correct `search.edit` failure wording: a non-ignore live-sync failure remains best-effort and surfaces `indexUpdate.applied = false`; unlike `file.write`, it does not roll the batch back. Do not promise watcher/index-refresh reconciliation for ignored paths.

- [ ] **Step 2: Run static and focused verification**

Run:

```powershell
npm run typecheck
npm run lint
npm run docs:tools:check
git diff --check
$env:SDL_MCP_DISABLE_NATIVE_ADDON = "1"
node --experimental-strip-types --test-concurrency=1 --test tests/integration/file-write-tool.test.ts tests/integration/search-edit-tool.test.ts
```

Expected: every command exits 0.

- [ ] **Step 3: Commit documentation**

```powershell
git add -- docs/mcp-tools-reference.md docs/search-edit-tool.md
git commit -m "docs: clarify ignored mutation sync behavior"
```

### Task 5: Safe-rebuild and validate the production graph

**Files:**
- Preserve: current database family at `F:\Claude\sdl-mcp\sdl-mcp-graph.lbug*`
- Create: a new, previously nonexistent candidate database path under `F:\Claude\sdl-mcp\`
- Modify only after all gates pass: `F:\Claude\sdl-mcp\sdlmcp.config.json`

- [ ] **Step 1: Capture fixed-build identity and current failure evidence**

Record `git rev-parse HEAD`, `node dist/cli/index.js --version`, current config, current database family, and `repo.status`.

- [ ] **Step 2: Stop the server owning the active Ladybug database**

Confirm no SDL-MCP process retains the current database before rebuilding. Preserve the original database family.

- [ ] **Step 3: Run the freshly built CLI against a nonexistent candidate path**

Run the fixed CLI's safe-rebuild command equivalent to:

```powershell
node dist/cli/index.js --config F:\\Claude\\sdl-mcp\\sdlmcp.config.json index --force --safe-rebuild <absolute-new-path>
```

If it fails, stop. Do not edit the configured database path; preserve candidate files and logs.

- [ ] **Step 4: Reopen and validate the candidate before cutover**

Start the freshly built fixed server with `--config F:\\Claude\\sdl-mcp\\sdlmcp.config.json` and a temporary `SDL_GRAPH_DB_PATH=<absolute-new-path>` override. Verify `sdl.info` reports the candidate path, then require:

```text
graphIntegrityState = verified
graphIntegrityVerifiedRevision = graphIntegrityRevision
```

If reopen or validation fails, stop the candidate server and preserve both database families and evidence.

- [ ] **Step 5: Run live ignored-path acceptance for both mutation surfaces**

Use disposable ignored files covered by the configured `**/.worktrees/**` rule. For the public `search.edit` preview, use literal `filters.include: [ignoredRelPath]`, then apply that preview's `planHandle` so the live-sync boundary is exercised. After each public mutation, require unchanged graph revision, `graphIntegrityState = verified`, and verified revision equal to current revision. Remove only the disposable files created by this acceptance check.

- [ ] **Step 6: Cut over only after every gate passes**

Stop the candidate server, remove the temporary `SDL_GRAPH_DB_PATH` override, update only `graphDatabase.path` in the production config to the validated candidate, restart SDL-MCP with the production config, verify `sdl.info` still reports the candidate, and repeat `repo.status`. Never overwrite or delete the original failed database family during this task.

- [ ] **Step 7: Final evidence**

Run `git status --short --branch` and report the commits, focused/static verification, candidate path, original preserved path, and final integrity revisions.
