# Windows CI Variance Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Linux and runtime guardrails unchanged while accommodating measured Windows CI tail-latency variance and isolating the PowerShell test from host `cmd.exe` configuration.

**Architecture:** Select the benchmark threshold from the artifact operating system at the existing artifact-construction boundary. Disable `cmd.exe` AutoRun processing inside the single PowerShell integration test so host configuration cannot hang the nested command.

**Tech Stack:** TypeScript, Node.js `node:test`, GitHub Actions

---

## Chunk 1: Focused Windows CI repair

### Task 1: Select the Windows benchmark threshold

**Files:**
- Modify: `tests/benchmark/background-graph-integrity.test.ts:880`
- Modify: `scripts/background-graph-integrity-benchmark.ts:1065-1104`

- [ ] **Step 1: Write the failing test**

Change the existing deterministic artifact fixture to `os: "linux"` and assert that it records the unchanged default. Then build a second artifact with `os: "win32"` and candidate samples whose p95 is above 1,000 milliseconds and below 1,600 milliseconds:

```typescript
assert.equal(DEFAULT_THRESHOLDS.candidateForegroundP95Ms, 1_000);
assert.deepEqual(artifact.thresholds, DEFAULT_THRESHOLDS);
assert.deepEqual(windowsArtifact.thresholds, {
  ...DEFAULT_THRESHOLDS,
  candidateForegroundP95Ms: 1_600,
});
assert.ok(windowsArtifact.checks.every((check) => check.passed));
```

This preserves every non-Windows threshold and verifies that Windows changes only the candidate foreground p95 ceiling.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --experimental-strip-types --test --test-name-pattern="builds the complete deterministic artifact schema" tests/benchmark/background-graph-integrity.test.ts
```

Expected: FAIL because Windows still records the 1,000-millisecond default.

- [ ] **Step 3: Add the minimal platform selection**

Inside `buildBenchmarkArtifact`, select once:

```typescript
const thresholds =
  input.os === "win32"
    ? { ...DEFAULT_THRESHOLDS, candidateForegroundP95Ms: 1_600 }
    : DEFAULT_THRESHOLDS;
```

Pass `thresholds` to `evaluateBenchmarkChecks` and store the same object in the artifact.

- [ ] **Step 4: Run the focused benchmark test**

Run the command from Step 2.

Expected: PASS.

### Task 2: Isolate the PowerShell integration test from cmd AutoRun

**Files:**
- Modify: `tests/integration/mcp-runtime-tool.test.ts:318-334`

- [ ] **Step 1: Disable cmd AutoRun processing**

Invoke the nested command as `cmd.exe /d /c ...`. Keep the default runtime budget so a real hang still fails promptly.

- [ ] **Step 2: Run the targeted integration test**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
node --experimental-strip-types --test --test-name-pattern="persists nested native-command output from PowerShell" tests/integration/mcp-runtime-tool.test.ts
```

Expected: PASS with `status: "success"` and both persisted output matches. Repeat the focused file five times to detect recurrence before pushing.

### Task 3: Verify and publish

**Files:**
- Verify only: all modified files

- [ ] **Step 1: Run focused gates**

```powershell
npm run build:all
node --experimental-strip-types --test tests/benchmark/background-graph-integrity.test.ts
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
node --experimental-strip-types --test tests/integration/mcp-runtime-tool.test.ts
npm run typecheck
npm run lint
git diff --check
```

Expected: every command passes.

- [ ] **Step 2: Commit and push**

Commit the implementation and push `main` to `origin`.

- [ ] **Step 3: Monitor replacement CI**

Wait for the push-triggered run and confirm both `tests (windows-latest, 24.x)` and `background-integrity-benchmark (windows-latest)` complete successfully. Continue triage if another actionable failure appears.
