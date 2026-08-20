import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

describe("real-world benchmark script", () => {
  it("keeps nightly matrix indexing on the compatibility pipeline", () => {
    const matrix = readFileSync(
      resolve(repoRoot, "scripts/real-world-benchmark-matrix.ts"),
      "utf8",
    );
    const benchmark = readFileSync(
      resolve(repoRoot, "scripts/real-world-benchmark.ts"),
      "utf8",
    );
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

    assert.match(matrix, /getFlag\(args, "force-legacy-index"\)/u);
    assert.match(matrix, /\$\{forceLegacyArg\}/u);
    assert.match(benchmark, /forceLegacyPipeline:\s*forceLegacyIndex/u);
    assert.match(workflow, /benchmark:matrix -- --force-legacy-index/u);
  });

  it("runs the matrix smoke entrypoint without parse or helper reference errors", () => {
    const outDir = mkdtempSync(resolve(tmpdir(), "sdl-mcp-benchmark-smoke-"));
    const result = spawnSync(process.execPath, [
      "scripts/real-world-benchmark-matrix.ts",
      "--",
      "--matrix",
      "benchmarks/real-world/matrix.json",
      "--config",
      "benchmarks/real-world/benchmark.config.json",
      "--out-dir",
      outDir,
      "--limit-runs",
      "1",
      "--skip-index",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.doesNotMatch(output, /ERR_INVALID_TYPESCRIPT_SYNTAX/);
    assert.doesNotMatch(output, /Expected ',', got ';'/);
    assert.doesNotMatch(output, /ReferenceError: ignore is not defined/);
  });
});
