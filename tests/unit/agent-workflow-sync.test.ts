import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("agent workflow sync", () => {
  it("keeps generated agent workflow surfaces current", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-agent-workflows.mjs", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
  });

  it("requires current-turn approval across refresh guidance surfaces", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
      "templates/sdl-mcp-agent-workflow/SKILL.md",
      "docs/agent-workflows.md",
      "src/cli/commands/init.ts",
      ".codex/hooks/load-sdl-skill.mjs",
      ".codex/agents/explore-sdl.toml",
      ".claude/agents/explore-sdl.md",
    ];

    for (const relativePath of workflowSurfaces) {
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      assert.match(
        content,
        /explicit user approval in the current turn/,
        relativePath,
      );
    }
  });

  it("keeps fallback workflow readiness and provenance guidance current", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
    ];

    for (const relativePath of workflowSurfaces) {
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      assert.match(content, /derivedState\.structuralStale/, relativePath);
      assert.match(content, /derivedState\.semanticStale/, relativePath);
      assert.match(content, /continue with available retrieval lanes/i, relativePath);
      assert.match(
        content,
        /reindex only if AST\/provenance-dependent behavior is required; otherwise use an SDL file-based fallback/i,
        relativePath,
      );
    }
  });
});
