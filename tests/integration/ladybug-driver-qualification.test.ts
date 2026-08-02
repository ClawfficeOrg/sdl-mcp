import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  invalidateConfigCache,
  loadConfig,
} from "../../dist/config/loadConfig.js";
import { closeLadybugDb } from "../../dist/db/ladybug.js";
import { runSafeRebuild } from "../../dist/cli/commands/index-safe-rebuild.js";
import { fingerprintDbFamily } from "../../dist/benchmark/external-runner.js";

describe("Ladybug driver qualification", { concurrency: 1 }, () => {
  const previousEnv = {
    SDL_CONFIG: process.env.SDL_CONFIG,
    SDL_CONFIG_PATH: process.env.SDL_CONFIG_PATH,
    SDL_GRAPH_DB_DIR: process.env.SDL_GRAPH_DB_DIR,
    SDL_GRAPH_DB_PATH: process.env.SDL_GRAPH_DB_PATH,
    SDL_DB_PATH: process.env.SDL_DB_PATH,
  };
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    invalidateConfigCache();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const root of cleanupRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a version mismatch before touching the source or creating a clone", async () => {
    const { qualifyLadybugDriver } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-version-gate-"));
    cleanupRoots.push(root);
    const sourcePath = join(root, "offline.lbug");
    const configPath = join(root, "config.json");
    writeFileSync(sourcePath, "offline-source-bytes");
    writeFileSync(configPath, JSON.stringify({ repos: [], policy: {} }));
    const sourceBytes = readFileSync(sourcePath);

    await assert.rejects(
      qualifyLadybugDriver({
        sourcePath,
        configPath,
        expectVersion: "0.0.0-version-mismatch",
        projectRoot: process.cwd(),
      }),
      /expected Ladybug driver version/i,
    );

    assert.deepEqual(readFileSync(sourcePath), sourceBytes);
  });

  it("rejects canonical aliases and hardlinks to active database families", async () => {
    const { assertOfflineSourceDistinct } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-alias-gate-"));
    cleanupRoots.push(root);
    const sourcePath = join(root, "offline.lbug");
    const activeHardlink = join(root, "active.lbug");
    writeFileSync(sourcePath, "same-file-identity");
    linkSync(sourcePath, activeHardlink);

    assert.throws(
      () => assertOfflineSourceDistinct(sourcePath, [sourcePath]),
      /active database family/i,
    );
    assert.throws(
      () => assertOfflineSourceDistinct(sourcePath, [activeHardlink]),
      /filesystem identity/i,
    );
  });

  it("retains a qualification clone when any database-family sidecar remains", async () => {
    const { assertNoCloneSidecars } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-sidecar-gate-"));
    cleanupRoots.push(root);
    const clonePath = join(root, "candidate.lbug");
    writeFileSync(clonePath, "database");
    writeFileSync(`${clonePath}.unexpected`, "unexpected-sidecar");

    assert.throws(() => assertNoCloneSidecars(clonePath), /close cleanly/i);
  });

  it("clears alternate child database variables and exposes the npm gate", async () => {
    const { buildQualificationChildEnv } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const env = buildQualificationChildEnv(
      {
        PATH: "kept",
        SDL_GRAPH_DB_PATH: "active",
        SDL_GRAPH_DB_DIR: "active-dir",
        SDL_DB_PATH: "legacy-active",
      },
      join(process.cwd(), "clone.lbug"),
    );
    assert.equal(env.PATH, "kept");
    assert.equal(env.SDL_GRAPH_DB_PATH, join(process.cwd(), "clone.lbug"));
    assert.equal("SDL_GRAPH_DB_DIR" in env, false);
    assert.equal("SDL_DB_PATH" in env, false);

    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    assert.equal(
      pkg.scripts?.["qualify:ladybug"],
      "npm run build && node scripts/qualify-ladybug-driver.mjs",
    );
  });

  it(
    "qualifies only a verified clone for two fresh-process cycles and retains failures",
    { timeout: 240_000 },
    async () => {
      const {
        installedLadybugVersion,
        qualifyLadybugDriver,
      } = await import("../../scripts/qualify-ladybug-driver.mjs");
      const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-qualification-"));
      cleanupRoots.push(root);
      const repoRoot = join(root, "repo");
      const activePath = join(root, "production-active.lbug");
      const sourcePath = join(root, "offline-snapshot.lbug");
      const configPath = join(root, "config.json");
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "index.ts"),
        "export function qualificationValue(): number { return 42; }\n",
      );
      writeFileSync(activePath, "production-sentinel-bytes");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [
            {
              repoId: "qualification-fixture",
              rootPath: repoRoot,
              ignore: [],
              languages: ["ts"],
            },
          ],
          graphDatabase: { path: activePath },
          policy: {},
          indexing: {
            pipeline: "legacy",
            engine: "typescript",
            enableFileWatching: false,
          },
          semantic: { enabled: false },
          semanticEnrichment: { enabled: false },
          scip: { enabled: false },
        }),
      );

      process.env.SDL_CONFIG = configPath;
      delete process.env.SDL_CONFIG_PATH;
      process.env.SDL_GRAPH_DB_PATH = activePath;
      delete process.env.SDL_GRAPH_DB_DIR;
      delete process.env.SDL_DB_PATH;
      invalidateConfigCache();
      const config = loadConfig(configPath);
      await runSafeRebuild({
        options: {
          config: configPath,
          force: true,
          safeRebuildPath: sourcePath,
        },
        config,
        configPath,
        activeGraphDbPath: activePath,
      });

      const activeBytes = readFileSync(activePath);
      const sourceBefore = fingerprintDbFamily(sourcePath);
      const receipt = await qualifyLadybugDriver({
        sourcePath,
        configPath,
        expectVersion: installedLadybugVersion(),
        projectRoot: process.cwd(),
      });

      assert.equal(receipt.cycles, 2);
      assert.equal(receipt.cleaned, true);
      assert.equal(receipt.sourceFingerprint.sha256, sourceBefore.sha256);
      assert.equal(existsSync(receipt.clonePath), false);
      assert.deepEqual(
        fingerprintDbFamily(sourcePath),
        sourceBefore,
      );
      assert.deepEqual(readFileSync(activePath), activeBytes);

      const mismatchConfigPath = join(root, "mismatch-config.json");
      writeFileSync(
        mismatchConfigPath,
        JSON.stringify({
          repos: [],
          graphDatabase: { path: activePath },
          policy: {},
        }),
      );
      let retainedCloneRoot: string | undefined;
      await assert.rejects(
        qualifyLadybugDriver({
          sourcePath,
          configPath: mismatchConfigPath,
          expectVersion: installedLadybugVersion(),
          projectRoot: process.cwd(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const qualificationError = error as Error & {
            clonePath?: string;
            cloneRootPath?: string;
          };
          assert.match(error.message, /candidate|repository|repo/i);
          assert.equal(typeof qualificationError.clonePath, "string");
          assert.equal(typeof qualificationError.cloneRootPath, "string");
          assert.equal(existsSync(qualificationError.cloneRootPath!), true);
          retainedCloneRoot = qualificationError.cloneRootPath;
          return true;
        },
      );
      if (retainedCloneRoot) cleanupRoots.push(retainedCloneRoot);

      assert.deepEqual(fingerprintDbFamily(sourcePath), sourceBefore);
      assert.deepEqual(readFileSync(activePath), activeBytes);
    },
  );
});
