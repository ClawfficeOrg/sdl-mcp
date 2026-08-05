# Seed Resolution V2 Artifact Relocation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the active seed-resolution v2 corpus and evaluation report into `docs/benchmarks/` and refresh the stale evaluation fingerprint so CI passes.

**Architecture:** Keep the existing generator and test contract unchanged except for one canonical public artifact directory. Move the two tracked JSON files, replace every active v2 path reference, regenerate the derived evaluation, and retain the legacy v1 files under `devdocs/benchmarks/`.

**Tech Stack:** TypeScript, Node.js built-in test runner, npm scripts, Git

---

## Chunk 1: Relocate and Verify the V2 Artifacts

### Task 1: Move the canonical v2 artifacts and regenerate the evaluation

**Required skills:** `@test-driven-development`, `@verification-before-completion`

**Files:**

- Move: `devdocs/benchmarks/seed-resolution-corpus-v2.json` to `docs/benchmarks/seed-resolution-corpus-v2.json`
- Move: `devdocs/benchmarks/seed-resolution-evaluation-v2.json` to `docs/benchmarks/seed-resolution-evaluation-v2.json`
- Modify: `scripts/evaluate-seed-resolution.ts:33-40`
- Modify: `tests/unit/seed-resolution-evaluation.test.ts:7-15`
- Modify: `tests/benchmark/context-quality.test.ts:1841`
- Verify unchanged: `devdocs/benchmarks/seed-resolution-corpus-v1.json`
- Verify unchanged: `devdocs/benchmarks/seed-resolution-evaluation-v1.json`

- [ ] **Step 1: Prepare independent worktree dependencies**

The worktree currently has a `node_modules` junction to the main checkout, whose command shims are incomplete. Verify the exact junction, remove only that link, then install the locked dependencies locally:

```powershell
$nodeModulesPath = Join-Path (Get-Location) "node_modules"
$nodeModulesItem = Get-Item -LiteralPath $nodeModulesPath -Force
if ($nodeModulesItem.LinkType -ne "Junction") {
  throw "Expected node_modules to be a Junction before replacement."
}
[System.IO.Directory]::Delete($nodeModulesPath, $false)
npm ci --ignore-scripts --legacy-peer-deps
```

Expected: `npm ci` exits 0 and `node_modules/.bin/tsc.cmd` exists in the worktree. Do not modify the main worktree's dependency directory.

- [ ] **Step 2: Write the failing new-path expectation**

In `tests/unit/seed-resolution-evaluation.test.ts`, change only the two path literals:

```typescript
const artifactPath = join(
  process.cwd(),
  "docs/benchmarks/seed-resolution-evaluation-v2.json",
);
const corpusPath = join(
  process.cwd(),
  "docs/benchmarks/seed-resolution-corpus-v2.json",
);
```

Do not move the JSON files yet.

- [ ] **Step 3: Run the focused test to verify RED**

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/seed-resolution-evaluation.test.ts
```

Expected: the build passes, then the test fails because `docs/benchmarks/seed-resolution-corpus-v2.json` or `docs/benchmarks/seed-resolution-evaluation-v2.json` does not exist. A build or dependency failure is not an acceptable RED result.

- [ ] **Step 4: Move the two tracked v2 artifacts**

```powershell
New-Item -ItemType Directory -Path docs/benchmarks -Force | Out-Null
git mv -- devdocs/benchmarks/seed-resolution-corpus-v2.json docs/benchmarks/seed-resolution-corpus-v2.json
git mv -- devdocs/benchmarks/seed-resolution-evaluation-v2.json docs/benchmarks/seed-resolution-evaluation-v2.json
```

Do not copy the files and do not move the v1 artifacts.

- [ ] **Step 5: Point every active consumer at the canonical public paths**

Make these literal replacements only:

```text
devdocs/benchmarks/seed-resolution-corpus-v2.json
-> docs/benchmarks/seed-resolution-corpus-v2.json

devdocs/benchmarks/seed-resolution-evaluation-v2.json
-> docs/benchmarks/seed-resolution-evaluation-v2.json
```

Apply them in:

- `scripts/evaluate-seed-resolution.ts` for `CORPUS_PATH` and `OUTPUT_PATH`
- `tests/benchmark/context-quality.test.ts` for the benchmark artifact reference

The unit-test replacements were completed in Step 2. Do not add fallback paths, configuration, redirects, or compatibility copies.

- [ ] **Step 6: Regenerate the derived evaluation report**

```powershell
npm run benchmark:seed-resolution
```

Expected: exit 0 and `docs/benchmarks/seed-resolution-evaluation-v2.json` is rewritten. Its `baseline.sourceHashes["src/context/engine.ts"]` value must equal the current source hash.

- [ ] **Step 7: Verify the generator and focused contract are GREEN**

```powershell
npm run benchmark:seed-resolution -- --check
node --experimental-strip-types --test tests/unit/seed-resolution-evaluation.test.ts
```

Expected: both commands exit 0; the focused test reports two passing tests and no failures.

- [ ] **Step 8: Verify the complete change**

```powershell
npm run build:all
npm run typecheck
npm test
git diff --check
if (Test-Path -LiteralPath devdocs/benchmarks/seed-resolution-corpus-v2.json) { throw "Old corpus v2 path remains." }
if (Test-Path -LiteralPath devdocs/benchmarks/seed-resolution-evaluation-v2.json) { throw "Old evaluation v2 path remains." }
if (-not (Test-Path -LiteralPath devdocs/benchmarks/seed-resolution-corpus-v1.json)) { throw "Legacy corpus v1 moved." }
if (-not (Test-Path -LiteralPath devdocs/benchmarks/seed-resolution-evaluation-v1.json)) { throw "Legacy evaluation v1 moved." }
git diff --exit-code (git merge-base HEAD main) -- devdocs/benchmarks/seed-resolution-corpus-v1.json devdocs/benchmarks/seed-resolution-evaluation-v1.json
git status --short
```

Expected: build, typecheck, full tests, and diff checks pass; only the approved v2 moves, path-reference edits, regenerated evaluation content, design, and plan are present.

- [ ] **Step 9: Commit the implementation**

```powershell
git add -- scripts/evaluate-seed-resolution.ts tests/unit/seed-resolution-evaluation.test.ts tests/benchmark/context-quality.test.ts docs/benchmarks/seed-resolution-corpus-v2.json docs/benchmarks/seed-resolution-evaluation-v2.json devdocs/benchmarks/seed-resolution-corpus-v2.json devdocs/benchmarks/seed-resolution-evaluation-v2.json
git commit -m "fix: relocate seed-resolution v2 artifacts"
```

Expected: one implementation commit containing only the approved relocation and regenerated artifact changes.
