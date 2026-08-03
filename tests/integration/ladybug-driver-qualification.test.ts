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

const TARGET_LADYBUG_VERSION = "0.19.0";
const PINNED_LADYBUG_VERSION = "0.18.1";
const EXPECTED_QUALIFICATION_PHASES = [
  "seed-first-batch",
  "seed-remaining-batches",
  "create-hnsw",
  "verify-hnsw-reopen",
  "verify-hnsw-dropped",
  "create-fts",
  "verify-fts-reopen",
  "verify-fts-dropped",
  "validate-full-delete-range",
  "validate-deleted-reinsert-range",
  "validate-restored-delete-all",
  "validate-empty",
  "validate-upstream-projection",
  "seed-node-string-segments",
  "validate-node-string-segment-scan",
];

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

  it("keeps #678 as a deterministic pinned-version rejection before cloning", async () => {
    const { installedLadybugVersion, qualifyLadybugDriver } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-version-gate-"));
    cleanupRoots.push(root);
    const sourcePath = join(root, "offline.lbug");
    const configPath = join(root, "config.json");
    writeFileSync(sourcePath, "offline-source-bytes");
    writeFileSync(configPath, JSON.stringify({ repos: [], policy: {} }));
    const sourceBytes = readFileSync(sourcePath);
    const installedVersion = installedLadybugVersion();
    const rejectedVersion =
      installedVersion === TARGET_LADYBUG_VERSION
        ? PINNED_LADYBUG_VERSION
        : TARGET_LADYBUG_VERSION;

    await assert.rejects(
      qualifyLadybugDriver({
        sourcePath,
        configPath,
        expectVersion: rejectedVersion,
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

  it("rejects default, configured-directory, and environment-directory active paths", async () => {
    const {
      assertOfflineSourceDistinct,
      resolveActiveDatabasePaths,
    } = await import("../../scripts/qualify-ladybug-driver.mjs");
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-path-gate-"));
    cleanupRoots.push(root);
    delete process.env.SDL_GRAPH_DB_PATH;
    delete process.env.SDL_GRAPH_DB_DIR;
    delete process.env.SDL_DB_PATH;

    const defaultConfigPath = join(root, "default-config.json");
    writeFileSync(
      defaultConfigPath,
      JSON.stringify({ repos: [], policy: {} }),
    );
    const defaultPath = join(root, "sdl-mcp-graph.lbug");
    writeFileSync(defaultPath, "default-active");
    const defaultConfig = loadConfig(defaultConfigPath);
    assert.deepEqual(
      resolveActiveDatabasePaths(defaultConfig, defaultConfigPath),
      [defaultPath],
    );
    assert.throws(
      () =>
        assertOfflineSourceDistinct(
          defaultPath,
          resolveActiveDatabasePaths(defaultConfig, defaultConfigPath),
        ),
      /active database family/i,
    );

    const configuredDirectory = join(root, "configured-db");
    mkdirSync(configuredDirectory);
    const configuredConfigPath = join(root, "configured-config.json");
    writeFileSync(
      configuredConfigPath,
      JSON.stringify({
        repos: [],
        graphDatabase: { path: configuredDirectory },
        policy: {},
      }),
    );
    const configuredPath = join(configuredDirectory, "sdl-mcp-graph.lbug");
    writeFileSync(configuredPath, "configured-active");
    const configuredConfig = loadConfig(configuredConfigPath);
    assert.deepEqual(
      resolveActiveDatabasePaths(configuredConfig, configuredConfigPath),
      [configuredPath],
    );
    assert.throws(
      () =>
        assertOfflineSourceDistinct(
          configuredPath,
          resolveActiveDatabasePaths(configuredConfig, configuredConfigPath),
        ),
      /active database family/i,
    );

    const environmentDirectory = join(root, "environment-db");
    mkdirSync(environmentDirectory);
    process.env.SDL_GRAPH_DB_DIR = environmentDirectory;
    const environmentPath = join(environmentDirectory, "sdl-mcp-graph.lbug");
    writeFileSync(environmentPath, "environment-active");
    assert.deepEqual(
      resolveActiveDatabasePaths(defaultConfig, defaultConfigPath),
      [environmentPath],
    );
    assert.throws(
      () =>
        assertOfflineSourceDistinct(
          environmentPath,
          resolveActiveDatabasePaths(defaultConfig, defaultConfigPath),
        ),
      /active database family/i,
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

  it("hashes canonical manifest and raw catalog rows without collapsing index types", async () => {
    const { canonicalRowsIdentity } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const vectorRows = [
      {
        index_type: "HNSW",
        index_name: "probe_vector",
        property_names: ["embedding"],
        table_name: "Probe",
        row_count: 2n,
      },
      {
        digest: "manifest-b",
        symbol_count: 1n,
      },
    ];
    const reorderedRows = [
      { symbol_count: 1n, digest: "manifest-b" },
      {
        row_count: 2n,
        table_name: "Probe",
        property_names: ["embedding"],
        index_name: "probe_vector",
        index_type: "HNSW",
      },
    ];
    assert.equal(
      canonicalRowsIdentity(vectorRows),
      canonicalRowsIdentity(reorderedRows),
    );
    assert.notEqual(
      canonicalRowsIdentity(vectorRows),
      canonicalRowsIdentity([
        { ...vectorRows[0], index_type: "FTS" },
        vectorRows[1],
      ]),
    );
  });

  it("clears alternate child database variables and exposes the npm gate", async () => {
    const { buildQualificationChildEnv } = await import(
      "../../scripts/qualify-ladybug-driver.mjs"
    );
    const childConfigPath = join(process.cwd(), "qualification-config.json");
    const env = buildQualificationChildEnv(
      {
        PATH: "kept",
        SDL_CONFIG: "wrong-config",
        SDL_CONFIG_PATH: "alternate-config",
        SDL_GRAPH_DB_PATH: "active",
        SDL_GRAPH_DB_DIR: "active-dir",
        SDL_DB_PATH: "legacy-active",
      },
      join(process.cwd(), "clone.lbug"),
      childConfigPath,
    );
    assert.equal(env.PATH, "kept");
    assert.equal(env.SDL_CONFIG, childConfigPath);
    assert.equal("SDL_CONFIG_PATH" in env, false);
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
    "keeps #725 open on pinned 0.18 and asserts the complete 0.19 receipt",
    { timeout: 600_000 },
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
      const installedVersion = installedLadybugVersion();
      const qualificationOptions = {
        sourcePath,
        configPath,
        expectVersion: installedVersion,
        projectRoot: process.cwd(),
      };

      if (installedVersion === TARGET_LADYBUG_VERSION) {
        const receipt = await qualifyLadybugDriver(qualificationOptions);
        assert.equal(receipt.driverVersion, TARGET_LADYBUG_VERSION);
        assert.equal(receipt.cleaned, true);
        assert.deepEqual(
          receipt.phases.map(({ phase }: { phase: string }) => phase),
          EXPECTED_QUALIFICATION_PHASES,
        );
        for (const phase of receipt.phases) {
          assert.equal(
            phase.manifestIdentity,
            receipt.graphIdentity.manifestIdentity,
          );
          assert.equal(
            phase.catalogIdentity,
            receipt.graphIdentity.catalogIdentity,
          );
        }
        const phaseByName = new Map(
          receipt.phases.map((phase: { phase: string }) => [phase.phase, phase]),
        );
        assert.equal(phaseByName.get("create-hnsw")?.hnsw?.created, true);
        assert.equal(
          phaseByName.get("verify-hnsw-reopen")?.hnsw?.matchedProbeId,
          true,
        );
        assert.equal(
          phaseByName.get("verify-hnsw-reopen")?.hnsw?.dropStatus,
          "dropped",
        );
        assert.equal(
          phaseByName.get("verify-hnsw-dropped")?.hnsw?.catalogAbsent,
          true,
        );
        assert.equal(phaseByName.get("create-fts")?.fts?.created, true);
        assert.equal(
          phaseByName.get("verify-fts-reopen")?.fts?.matchedProbeId,
          true,
        );
        assert.equal(
          phaseByName.get("verify-fts-reopen")?.fts?.dropStatus,
          "dropped",
        );
        assert.equal(
          phaseByName.get("verify-fts-dropped")?.fts?.catalogAbsent,
          true,
        );
        const projection = phaseByName.get("validate-upstream-projection");
        assert.equal(projection?.projectionMaterializationCount, 5);
        assert.equal(projection?.projectionDigests?.length, 5);
        assert.equal(
          new Set(projection?.projectionDigests).size,
          1,
        );
        assert.equal(existsSync(receipt.clonePath), false);
      } else {
        assert.equal(installedVersion, PINNED_LADYBUG_VERSION);
        let retainedCloneRoot: string | undefined;
        await assert.rejects(
          qualifyLadybugDriver(qualificationOptions),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            const qualificationError = error as Error & {
              clonePath?: string;
              cloneRootPath?: string;
            };
            assert.match(
              error.message,
              /validate-node-string-segment-scan[\s\S]*node-string projected scan (delivery|comparison) failed/i,
            );
            assert.equal(typeof qualificationError.clonePath, "string");
            assert.equal(typeof qualificationError.cloneRootPath, "string");
            assert.equal(existsSync(qualificationError.clonePath!), true);
            assert.equal(existsSync(qualificationError.cloneRootPath!), true);
            retainedCloneRoot = qualificationError.cloneRootPath;
            return true;
          },
        );
        cleanupRoots.push(retainedCloneRoot!);
      }

      assert.deepEqual(fingerprintDbFamily(sourcePath), sourceBefore);
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
      let mismatchCloneRoot: string | undefined;
      await assert.rejects(
        qualifyLadybugDriver({
          sourcePath,
          configPath: mismatchConfigPath,
          expectVersion: installedVersion,
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
          mismatchCloneRoot = qualificationError.cloneRootPath;
          return true;
        },
      );
      cleanupRoots.push(mismatchCloneRoot!);

      assert.deepEqual(fingerprintDbFamily(sourcePath), sourceBefore);
      assert.deepEqual(readFileSync(activePath), activeBytes);
    },
  );
});
