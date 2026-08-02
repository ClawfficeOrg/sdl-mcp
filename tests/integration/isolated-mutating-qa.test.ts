import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeQaInputs(scenario: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "sdl-isolated-qa-integration-"));
  cleanupRoots.push(root);
  const fixtureRoot = join(root, "fixture");
  const repoRoot = join(fixtureRoot, "repo");
  const activeDbPath = join(root, "production.lbug");
  const configPath = join(root, "qa-config.json");
  const scenarioPath = join(root, "scenario.json");
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "index.ts"), "export const qaValue = 1;\n");
  writeFileSync(activeDbPath, "production-sentinel-bytes");
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: [],
      policy: {},
      indexing: {
        engine: "typescript",
        enableFileWatching: false,
        algorithmRefresh: { enabled: false },
      },
      semantic: { enabled: false },
      semanticEnrichment: { enabled: false },
      liveIndex: { enabled: false },
      prefetch: { enabled: false },
      memory: { enabled: false },
    }),
  );
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  return {
    root,
    fixtureRoot,
    repoRoot,
    activeDbPath,
    configPath,
    scenarioPath,
  };
}

describe("isolated mutating QA process", () => {
  it(
    "registers and mutates only through its owned server, then removes the QA database family",
    { timeout: 120_000 },
    async () => {
      const { runIsolatedMutatingQa } = await import(
        "../../scripts/run-isolated-mutating-qa.mjs"
      );
      const inputs = makeQaInputs([]);
      writeFileSync(
        inputs.scenarioPath,
        JSON.stringify([
          {
            tool: "sdl.repo.register",
            arguments: {
              repoId: "qa-fixture",
              rootPath: inputs.repoRoot,
            },
          },
          {
            tool: "sdl.index.refresh",
            arguments: { repoId: "qa-fixture", mode: "full" },
          },
        ]),
      );
      const activeBytes = readFileSync(inputs.activeDbPath);

      const receipt = await runIsolatedMutatingQa({
        activeDbPath: inputs.activeDbPath,
        fixtureRoot: inputs.fixtureRoot,
        configPath: inputs.configPath,
        scenarioPath: inputs.scenarioPath,
        projectRoot: process.cwd(),
      });

      assert.deepEqual(receipt.completedTools, [
        "sdl.repo.register",
        "sdl.index.refresh",
      ]);
      assert.equal(receipt.closed, true);
      assert.equal(receipt.sidecarsClean, true);
      assert.equal(receipt.cleaned, true);
      assert.equal(existsSync(receipt.qaDbPath), false);
      assert.equal(existsSync(`${receipt.qaDbPath}.wal`), false);
      assert.deepEqual(readFileSync(inputs.activeDbPath), activeBytes);
    },
  );

  it(
    "retains the QA fixture and reports its path when a tool call fails",
    { timeout: 120_000 },
    async () => {
      const { runIsolatedMutatingQa } = await import(
        "../../scripts/run-isolated-mutating-qa.mjs"
      );
      const inputs = makeQaInputs([
        {
          tool: "sdl.not-a-tool",
          arguments: {},
        },
      ]);
      const activeBytes = readFileSync(inputs.activeDbPath);
      let retainedRoot: string | undefined;

      await assert.rejects(
        runIsolatedMutatingQa({
          activeDbPath: inputs.activeDbPath,
          fixtureRoot: inputs.fixtureRoot,
          configPath: inputs.configPath,
          scenarioPath: inputs.scenarioPath,
          projectRoot: process.cwd(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const qaError = error as Error & {
            qaDbPath?: string;
            qaRootPath?: string;
          };
          assert.match(error.message, /tool|method|not found/i);
          assert.equal(typeof qaError.qaDbPath, "string");
          assert.equal(typeof qaError.qaRootPath, "string");
          assert.equal(existsSync(qaError.qaRootPath!), true);
          retainedRoot = qaError.qaRootPath;
          return true;
        },
      );

      assert.deepEqual(readFileSync(inputs.activeDbPath), activeBytes);
      if (retainedRoot) {
        cleanupRoots.push(retainedRoot);
      }
    },
  );
});
