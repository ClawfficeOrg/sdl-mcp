# Ordinary Test Context-Quality Exclusion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclude the pinned context-quality suite from ordinary `npm test`.

**Architecture:** Extend the generic runner's existing filename exclusion list. Keep direct and scheduled benchmark execution intact.

**Tech Stack:** Node.js, TypeScript, `node:test`.

---

## Chunk 1: Runner exclusion

### Task 1: Exclude the scheduled-only suite

**Files:**
- Modify: `tests/unit/run-tests-script.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] Add a unit assertion that the skip list contains `context-quality.test.ts`.
- [ ] Run the focused unit test and confirm it fails.
- [ ] Add the filename to `SKIP_PATTERNS`.
- [ ] Run the focused unit test and confirm it passes.
- [ ] Run the generic runner and confirm it does not select the context-quality suite.
- [ ] Run `tests/unit/context-quality-ci.test.ts` and confirm the dedicated workflow remains valid.
- [ ] Confirm `.github/workflows/ci.yml`, `tests/benchmark/context-quality-runner.mjs`, and `tests/benchmark/context-quality.test.ts` are unchanged.
