# Windows Semantic Embedding Native Loader Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep SDL tests native-disabled by default while allowing the single Windows semantic-embedding integration file to use SDL's verified OpenSSL loader.

**Architecture:** Change only the test-runner environment construction. Compare the normalized repository-relative test path to one exact constant on Windows, delete the disable flag only for that file, and lock both the default and exception contracts in the existing runner source-contract test.

**Tech Stack:** Node.js 24, ESM, `node:test`, PowerShell/Windows, LadybugDB 0.19.0.

---

## Chunk 1: Exact runner contract

### Task 1: Add the failing source-contract assertion

**Files:**
- Modify: `tests/unit/run-tests-script.test.ts`
- Reference: `docs/superpowers/specs/2026-08-06-windows-semantic-embedding-native-loader-design.md`

- [ ] Assert that the runner still assigns `SDL_MCP_DISABLE_NATIVE_ADDON: "1"` by default.
- [ ] Assert that the exception requires `process.platform === "win32"`.
- [ ] Assert that the exception compares a normalized repository-relative path exactly to `tests/integration/semantic-embedding.test.ts`; reject `endsWith("semantic-embedding.test.ts")`.
- [ ] Run `node --experimental-strip-types --test tests/unit/run-tests-script.test.ts`.
- [ ] Verify RED: the new exact-path assertion fails against the broad suffix implementation.

### Task 2: Implement the minimum exact-path exception

**Files:**
- Modify: `scripts/run-tests.mjs`
- Test: `tests/unit/run-tests-script.test.ts`

- [ ] Normalize the current test file to forward-slash repository-relative form using existing Node path helpers.
- [ ] On Windows only, delete `env.SDL_MCP_DISABLE_NATIVE_ADDON` when and only when the normalized path equals `tests/integration/semantic-embedding.test.ts`.
- [ ] Keep the default native-disable assignment unchanged for every other test.
- [ ] Run `node --experimental-strip-types --test tests/unit/run-tests-script.test.ts`.
- [ ] Verify GREEN: all runner contract tests pass.

- [ ] Run `npm run test:integration` to exercise the actual runner branch and verify the semantic-embedding file passes with the exact Windows exception.

## Chunk 2: Release verification

### Task 3: Run the authoritative gate and publish

**Files:**
- Verify all release files and the two fix files above.

- [ ] Add a `0.13.2` Fixed entry documenting the Windows semantic-embedding runner's exact native-loader exception.
- [ ] Run `npm run prepare-release` with persisted output and an explicit exit-code marker; require exit 0.
- [ ] Review `git diff --check`, the exact diff, release version synchronization, and changelog.
- [ ] Commit the approved release and fix, create annotated tag `v0.13.2`, and push `main` plus the tag.
- [ ] Create the GitHub Release using the valid Windows keyring token injected only into the release process.
- [ ] Monitor CI and release-publish workflows to successful completion.
- [ ] Verify all 12 release-coupled npm packages expose version `0.13.2`.
- [ ] Verify local `main`, `origin/main`, tag, release commit, and clean worktree agree.
