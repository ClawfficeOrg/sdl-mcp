# Search Edit CI Canonical Path Repair Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the cross-platform search-edit test matrix without weakening canonical identity or path-containment checks.

**Architecture:** Keep production planner preconditions authoritative. Make preflight resolve both repository roots and targets through the same native canonicalizer, and make direct `applyBatch` test fixtures construct the complete `PlanPrecondition` contract that the real planner already emits.

**Tech Stack:** TypeScript, Node.js `node:test`, Windows/Linux filesystem canonicalization.

---

## Chunk 1: Canonical preconditions and focused verification

### Task 1: Repair canonical path consistency and stale fixtures

**Files:**
- Modify: `src/mcp/tools/search-edit/batch-executor.ts`
- Modify: `tests/property/search-edit-properties.test.ts`
- Modify: `tests/unit/search-edit-batch-executor.test.ts`
- Verify: `tests/integration/search-edit-tool.test.ts`

- [x] **Step 1: Confirm the red tests**

Run the property and batch-executor files against commit `2002e431`; expect `filesWritten` to be zero because direct fixtures omit `canonicalAbsPath`.

- [x] **Step 2: Complete direct-test preconditions**

Update each test file's shared `makePlan` helper to accept fixture preconditions without `canonicalAbsPath` and map them to complete `PlanPrecondition` values. Existing files use `realpathSync.native(absPath)`; missing/new files retain `absPath` because no filesystem identity exists yet.

- [x] **Step 3: Use one canonical resolver in preflight**

Change the target-side preflight call from `realpathSync(...)` to `realpathSync.native(...)`, matching the repository root, planner, and write-time resolver.

- [x] **Step 4: Verify focused behavior**

Run build, typecheck, and the integration/property/unit search-edit files. Expected: every focused test passes on the current platform and the Windows in-root identity-swap check remains fail-closed without a false path-escape classification.

- [ ] **Step 5: Verify repository regression scope**

Run the full test suite and inspect the final file counts and failures. Do not weaken canonical identity, rollback, or ignore-aware live-index behavior.
