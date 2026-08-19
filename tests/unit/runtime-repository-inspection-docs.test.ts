import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readDoc(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function assertRuntimeRoute(content: string, relativePath: string): void {
  assert.match(
    content,
    /runtime(?:Execute|\.execute| execution)[`]? executes repository tooling/i,
    relativePath,
  );
  assert.match(
    content,
    /Do not use (?:it|runtime(?:Execute|\.execute| execution))\s+to inspect,\s*search,\s*or\s+print repository files/i,
    relativePath,
  );
  assert.match(
    content,
    /sdl\.context[\s\S]*?sdl\.retrieve[\s\S]*?indexed source/i,
    relativePath,
  );
  assert.match(
    content,
    /sdl\.file[\s\S]*?op\s*=\s*["`]?read["`]?[\s\S]*?other files/i,
    relativePath,
  );
}

function assertFlatModeRecovery(content: string, relativePath: string): void {
  assert.match(content, /Code Mode is unavailable/i, relativePath);
  assert.match(
    content,
    /(?:sdl\.file\.read[\s\S]*?non-indexed files|non-indexed files[\s\S]*?sdl\.file\.read)/i,
    relativePath,
  );
  for (const toolName of [
    "sdl.repo.overview",
    "sdl.symbol.search",
    "sdl.symbol.getCard",
    "sdl.slice.build",
    "sdl.code.getSkeleton",
    "sdl.code.getHotPath",
    "sdl.code.needWindow",
  ]) {
    assert.match(content, new RegExp(toolName.replaceAll(".", "\\.")), relativePath);
  }
}

describe("runtime repository inspection documentation", () => {
  it("keeps every public runtime guide on the SDL retrieval route", () => {
    for (const relativePath of [
      "docs/feature-deep-dives/runtime-execution.md",
      "docs/agent-workflows.md",
      "docs/tool-enforcement.md",
      "docs/tool-enforcement-for-claude.md",
      "docs/mcp-tools-reference.md",
    ]) {
      assertRuntimeRoute(readDoc(relativePath), relativePath);
    }
  });

  it("keeps a flat SDL recovery route when Code Mode is unavailable", () => {
    for (const relativePath of [
      "docs/feature-deep-dives/runtime-execution.md",
      "docs/agent-workflows.md",
      "docs/tool-enforcement.md",
      "docs/tool-enforcement-for-claude.md",
      "docs/mcp-tools-reference.md",
    ]) {
      assertFlatModeRecovery(readDoc(relativePath), relativePath);
    }
  });

  it("documents the deterministic policy response and workflow propagation", () => {
    const runtimeGuide = readDoc("docs/feature-deep-dives/runtime-execution.md");
    const workflows = readDoc("docs/agent-workflows.md");

    assert.match(
      runtimeGuide,
      /RUNTIME_REPOSITORY_INSPECTION_DISALLOWED: runtimeExecute executes repository tooling and cannot inspect repository files\. Use sdl\.context or sdl\.retrieve for indexed source; use sdl\.file with op="read" for non-indexed files\./,
    );
    assert.match(workflows, /POLICY_ERROR/);
    assert.match(workflows, /policy_denied/);
    assert.match(workflows, /retryable:\s*false/);
    assert.match(workflows, /onError:\s*"continue"/);
    assert.match(workflows, /top-level MCP response sets `isError: true`/);
  });

  it("explains the cooperative guard without implying a bypass", () => {
    for (const relativePath of [
      "docs/feature-deep-dives/runtime-execution.md",
      "docs/agent-workflows.md",
      "docs/tool-enforcement.md",
      "docs/tool-enforcement-for-claude.md",
      "docs/mcp-tools-reference.md",
    ]) {
      const content = readDoc(relativePath);
      assert.match(content, /no per-call bypass/i, relativePath);
      assert.match(content, /high-confidence/i, relativePath);
      assert.match(content, /precision-first/i, relativePath);
      assert.doesNotMatch(
        content,
        /(?:named|executable) scripts?[^.\n]*opaque|opaque[^.\n]*(?:named|executable) scripts?/i,
        relativePath,
      );
      assert.doesNotMatch(content, /readFileSync\("package\.json"/, relativePath);
    }
  });

  it("includes an accessible recovery flowchart in the runtime deep dive", () => {
    const runtimeGuide = readDoc("docs/feature-deep-dives/runtime-execution.md");

    assert.match(runtimeGuide, /flowchart TD/);
    assert.match(runtimeGuide, /Runtime request/);
    assert.match(runtimeGuide, /Policy classifier/);
    assert.match(runtimeGuide, /Allowed execution/);
    assert.match(runtimeGuide, /Typed POLICY_ERROR rejection/);
    assert.match(runtimeGuide, /Code Mode recovery/);
    assert.match(runtimeGuide, /Flat recovery/);
    assert.match(runtimeGuide, /cooperative guard, not a security sandbox/i);
  });
});
