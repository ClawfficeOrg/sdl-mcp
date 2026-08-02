import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadRunner() {
  return import("../../scripts/run-isolated-mutating-qa.mjs");
}

describe("isolated mutating QA runner", () => {
  it("rejects any QA database path in an active database family", async () => {
    const { assertDistinctDatabaseFamilies } = await loadRunner();
    const root = mkdtempSync(join(tmpdir(), "sdl-qa-family-"));
    tempRoots.push(root);
    const activePath = join(root, "active.lbug");

    assert.throws(
      () =>
        assertDistinctDatabaseFamilies(
          `${activePath}.wal.checkpoint`,
          [activePath],
        ),
      /database family/i,
    );
    assert.doesNotThrow(() =>
      assertDistinctDatabaseFamilies(join(root, "qa.lbug"), [activePath]),
    );
  });

  it("retains the QA fixture when any database-family sidecar remains", async () => {
    const { assertNoDatabaseSidecars } = await loadRunner();
    const root = mkdtempSync(join(tmpdir(), "sdl-qa-sidecar-"));
    tempRoots.push(root);
    const qaPath = join(root, "qa.lbug");
    writeFileSync(qaPath, "database");
    writeFileSync(`${qaPath}.wal.quarantine-1`, "unexpected-sidecar");

    assert.throws(() => assertNoDatabaseSidecars(qaPath), /retained sidecars/i);
  });

  it("passes only one LadybugDB path override to the owned child", async () => {
    const { buildIsolatedChildEnv } = await loadRunner();
    const qaPath = resolve("qa.lbug");

    const env = buildIsolatedChildEnv(
      {
        PATH: "kept",
        SDL_GRAPH_DB_PATH: "active",
        SDL_GRAPH_DB_DIR: "active-dir",
        SDL_DB_PATH: "legacy-active",
      },
      qaPath,
    );

    assert.equal(env.PATH, "kept");
    assert.equal(env.SDL_GRAPH_DB_PATH, qaPath);
    assert.equal("SDL_GRAPH_DB_DIR" in env, false);
    assert.equal("SDL_DB_PATH" in env, false);
  });

  it("requires every configured or scenario repository root to stay in the fixture", async () => {
    const { assertQaInputsContained } = await loadRunner();
    const root = mkdtempSync(join(tmpdir(), "sdl-qa-contained-"));
    tempRoots.push(root);
    const fixtureRoot = join(root, "fixture");
    const repoRoot = join(fixtureRoot, "repo");
    const outsideRoot = join(root, "outside");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    assert.doesNotThrow(() =>
      assertQaInputsContained(
        { repos: [{ repoId: "qa", rootPath: repoRoot }] },
        [
          {
            tool: "sdl.repo.register",
            arguments: { repoId: "qa", rootPath: repoRoot },
          },
        ],
        fixtureRoot,
      ),
    );
    assert.throws(
      () =>
        assertQaInputsContained(
          { repos: [{ repoId: "outside", rootPath: outsideRoot }] },
          [],
          fixtureRoot,
        ),
      /fixture root/i,
    );
  });

  it("rejects arbitrary runtime execution and external endpoints", async () => {
    const { validateScenario } = await loadRunner();

    assert.throws(
      () =>
        validateScenario([
          {
            tool: "sdl.workflow",
            arguments: {
              repoId: "qa",
              steps: [{ fn: "runtimeExecute", args: { runtime: "node" } }],
            },
          },
        ]),
      /runtime/i,
    );
    assert.throws(
      () =>
        validateScenario([
          {
            tool: "sdl.file",
            arguments: { endpoint: "https://example.test" },
          },
        ]),
      /endpoint/i,
    );
    assert.deepEqual(
      validateScenario([
        {
          tool: "sdl.repo.register",
          arguments: { repoId: "qa", rootPath: resolve("fixture") },
        },
        {
          tool: "sdl.index.refresh",
          arguments: { repoId: "qa", mode: "full" },
        },
      ]),
      [
        {
          tool: "sdl.repo.register",
          arguments: { repoId: "qa", rootPath: resolve("fixture") },
        },
        {
          tool: "sdl.index.refresh",
          arguments: { repoId: "qa", mode: "full" },
        },
      ],
    );
  });
  it("exposes the isolated QA command through npm", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    assert.equal(
      pkg.scripts?.["qa:isolated"],
      "npm run build && node scripts/run-isolated-mutating-qa.mjs",
    );
  });
});
