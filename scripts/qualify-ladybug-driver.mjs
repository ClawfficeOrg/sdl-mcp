#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectDbFamilyFiles,
  copyDbFamilyVerified,
  fingerprintDbFamily,
} from "../dist/benchmark/external-runner.js";
import { loadConfig } from "../dist/config/loadConfig.js";
import { DEFAULT_GRAPH_DB_FILENAME } from "../dist/db/graph-db-path.js";

const QUALIFICATION_CYCLES = 2;
const CHILD_RESULT_PREFIX = "LADYBUG_QUALIFICATION_RESULT ";
const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

function canonicalizePath(value) {
  const absolutePath = resolve(value);
  const canonicalPath = existsSync(absolutePath)
    ? realpathSync.native(absolutePath)
    : absolutePath;
  return process.platform === "win32"
    ? canonicalPath.toLowerCase()
    : canonicalPath;
}

function packageJsonFor(modulePath) {
  let directory = dirname(modulePath);
  while (directory !== dirname(directory)) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`Unable to locate package.json for ${modulePath}`);
}

export function installedLadybugVersion() {
  const packagePath = packageJsonFor(require.resolve("kuzu"));
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function sameFilesystemIdentity(left, right) {
  const leftStat = statSync(left, { bigint: true });
  const rightStat = statSync(right, { bigint: true });
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function collectExistingFamily(primaryPath) {
  return existsSync(dirname(resolve(primaryPath)))
    ? collectDbFamilyFiles(primaryPath)
    : [];
}

export function assertOfflineSourceDistinct(sourcePath, activePaths) {
  const sourcePrimary = canonicalizePath(sourcePath);
  const sourceMembers = collectExistingFamily(sourcePath);
  for (const activePath of activePaths.filter(Boolean)) {
    if (sourcePrimary === canonicalizePath(activePath)) {
      throw new Error(
        `Offline source must not be an active database family: ${activePath}`,
      );
    }
    for (const sourceMember of sourceMembers) {
      for (const activeMember of collectExistingFamily(activePath)) {
        if (canonicalizePath(sourceMember) === canonicalizePath(activeMember)) {
          throw new Error(
            `Offline source aliases an active database family: ${activeMember}`,
          );
        }
        if (sameFilesystemIdentity(sourceMember, activeMember)) {
          throw new Error(
            `Offline source shares filesystem identity with active database family: ${activeMember}`,
          );
        }
      }
    }
  }
}

export function buildQualificationChildEnv(baseEnv, clonePath) {
  const childEnv = {
    ...baseEnv,
    SDL_GRAPH_DB_PATH: resolve(clonePath),
  };
  delete childEnv.SDL_GRAPH_DB_DIR;
  delete childEnv.SDL_DB_PATH;
  return childEnv;
}

function activeDatabasePaths(config, projectRoot) {
  const configuredPath =
    typeof config.graphDatabase?.path === "string"
      ? resolve(projectRoot, config.graphDatabase.path)
      : null;
  const directoryPath = process.env.SDL_GRAPH_DB_DIR
    ? join(resolve(process.env.SDL_GRAPH_DB_DIR), DEFAULT_GRAPH_DB_FILENAME)
    : null;
  return [
    configuredPath,
    process.env.SDL_GRAPH_DB_PATH,
    directoryPath,
    process.env.SDL_DB_PATH,
  ].filter(Boolean);
}

function assertFingerprintEqual(expected, actual, message) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(message);
  }
}

export function assertNoCloneSidecars(clonePath) {
  const directory = dirname(clonePath);
  const databaseName = basename(clonePath);
  const dangling = readdirSync(directory)
    .filter((name) => name.startsWith(`${databaseName}.`))
    .map((name) => join(directory, name));
  if (dangling.length > 0) {
    throw new Error(
      `Qualification child did not close cleanly: ${dangling.join(", ")}`,
    );
  }
}

function runQualificationChild({
  mode,
  clonePath,
  configPath,
  cycle,
  projectRoot,
}) {
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--child",
      mode,
      "--clone",
      clonePath,
      "--config",
      configPath,
      "--cycle",
      String(cycle),
    ],
    {
      cwd: projectRoot,
      env: buildQualificationChildEnv(process.env, clonePath),
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Qualification child ${mode} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(CHILD_RESULT_PREFIX));
  if (!line) {
    throw new Error(`Qualification child ${mode} returned no receipt`);
  }
  assertNoCloneSidecars(clonePath);
  return JSON.parse(line.slice(CHILD_RESULT_PREFIX.length));
}

function graphIdentity(result) {
  return JSON.stringify({
    validation: result.validation,
    graphs: result.graphs,
  });
}

export async function qualifyLadybugDriver(options) {
  const actualVersion = installedLadybugVersion();
  if (actualVersion !== options.expectVersion) {
    throw new Error(
      `Expected Ladybug driver version ${options.expectVersion}, found ${actualVersion}`,
    );
  }

  const projectRoot = resolve(
    options.projectRoot ?? join(dirname(scriptPath), ".."),
  );
  const sourcePath = resolve(options.sourcePath);
  const configPath = resolve(options.configPath);
  const config = loadConfig(configPath);
  assertOfflineSourceDistinct(
    sourcePath,
    activeDatabasePaths(config, projectRoot),
  );

  const sourceBefore = fingerprintDbFamily(sourcePath);
  const cloneRootPath = await mkdtemp(
    join(tmpdir(), "sdl-ladybug-qualification-"),
  );
  const clonePath = join(cloneRootPath, "candidate.lbug");

  try {
    copyDbFamilyVerified(sourcePath, clonePath);
    assertFingerprintEqual(
      sourceBefore,
      fingerprintDbFamily(sourcePath),
      "Offline source changed while copying the database family",
    );

    let expectedGraphIdentity;
    for (let cycle = 1; cycle <= QUALIFICATION_CYCLES; cycle += 1) {
      const writeResult = runQualificationChild({
        mode: "write",
        clonePath,
        configPath,
        cycle,
        projectRoot,
      });
      const verifyResult = runQualificationChild({
        mode: "verify-remove",
        clonePath,
        configPath,
        cycle,
        projectRoot,
      });
      for (const result of [writeResult, verifyResult]) {
        const identity = graphIdentity(result);
        if (expectedGraphIdentity === undefined) {
          expectedGraphIdentity = identity;
        } else if (identity !== expectedGraphIdentity) {
          throw new Error(
            "Graph counts or digest changed during Ladybug qualification",
          );
        }
      }
    }

    const sourceAfter = fingerprintDbFamily(sourcePath);
    assertFingerprintEqual(
      sourceBefore,
      sourceAfter,
      "Offline source changed during Ladybug qualification",
    );
    const receipt = {
      driverVersion: actualVersion,
      sourcePath,
      sourceFingerprint: sourceAfter,
      clonePath,
      cycles: QUALIFICATION_CYCLES,
      graphIdentity: JSON.parse(expectedGraphIdentity),
      cleaned: true,
    };
    await rm(cloneRootPath, { recursive: true });
    return receipt;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.clonePath = clonePath;
    error.cloneRootPath = cloneRootPath;
    throw error;
  }
}

async function graphSnapshots(conn, config) {
  const { capturePersistedGraphIntegrity } = await import(
    "../dist/indexer/provider-first/persisted-graph-integrity.js"
  );
  const snapshots = [];
  for (const repo of config.repos) {
    const captured = await capturePersistedGraphIntegrity(conn, repo.repoId);
    snapshots.push({
      repoId: repo.repoId,
      symbolCount: captured.symbolCount,
      digest: captured.digest,
    });
  }
  return snapshots;
}

async function validateProbeQueries(conn, cycle) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const counts = await queryAll(
    conn,
    `MATCH (p:DriverQualificationProbe)
     RETURN count(p) AS physicalTotal, count(DISTINCT p.id) AS distinctTotal`,
  );
  if (
    Number(counts[0]?.physicalTotal) !== 1 ||
    Number(counts[0]?.distinctTotal) !== 1
  ) {
    throw new Error("Qualification probe count/distinct scan failed");
  }

  const duplicates = await queryAll(
    conn,
    `MATCH (p:DriverQualificationProbe)
     WITH p.id AS id, count(*) AS copies
     WHERE copies > 1
     RETURN id, copies
     LIMIT 1`,
  );
  if (duplicates.length !== 0) {
    throw new Error("Qualification probe duplicate-group scan failed");
  }

  const projection = await queryAll(
    conn,
    `MATCH (p:DriverQualificationProbe)
     RETURN p.id AS id, p.payload AS payload, p.cycle AS cycle
     ORDER BY p.id
     LIMIT 16`,
  );
  const point = await queryAll(
    conn,
    `MATCH (p:DriverQualificationProbe {id: $id})
     RETURN p.id AS id, p.payload AS payload, p.cycle AS cycle`,
    { id: "qualification-probe" },
  );
  for (const row of [...projection, ...point]) {
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      typeof row.payload !== "string" ||
      row.payload.length === 0 ||
      Number(row.cycle) !== cycle
    ) {
      throw new Error("Qualification probe canonical-string scan failed");
    }
  }
  if (projection.length !== 1 || point.length !== 1) {
    throw new Error("Qualification probe projection/point lookup failed");
  }
}

async function runChildMode(options) {
  const {
    closeLadybugDb,
    getLadybugConn,
    getLadybugDbPath,
    initLadybugDb,
  } = await import("../dist/db/ladybug.js");
  const { exec, execDdl, queryAll } = await import(
    "../dist/db/ladybug-core.js"
  );
  const { validateSafeRebuildCandidate } = await import(
    "../dist/cli/commands/index-safe-rebuild.js"
  );
  const config = loadConfig(options.configPath);
  let opened = false;

  try {
    await initLadybugDb(options.clonePath);
    opened = true;
    if (
      canonicalizePath(getLadybugDbPath()) !==
      canonicalizePath(options.clonePath)
    ) {
      throw new Error("Initialized LadybugDB path does not equal clone path");
    }

    const conn = await getLadybugConn();
    const validationBefore = await validateSafeRebuildCandidate(config);
    const graphsBefore = await graphSnapshots(conn, config);

    if (options.mode === "write") {
      await execDdl(
        conn,
        `CREATE NODE TABLE IF NOT EXISTS DriverQualificationProbe (
          id STRING,
          payload STRING,
          cycle INT64,
          PRIMARY KEY(id)
        )`,
      );
      await exec(
        conn,
        `MERGE (p:DriverQualificationProbe {id: $id})
         SET p.payload = $payload, p.cycle = $cycle`,
        {
          id: "qualification-probe",
          payload: `cycle-${options.cycle}`,
          cycle: options.cycle,
        },
      );
      await validateProbeQueries(conn, options.cycle);
    } else if (options.mode === "verify-remove") {
      await validateProbeQueries(conn, options.cycle);
      await exec(
        conn,
        `MATCH (p:DriverQualificationProbe {id: $id})
         DELETE p`,
        { id: "qualification-probe" },
      );
      const remaining = await queryAll(
        conn,
        "MATCH (p:DriverQualificationProbe) RETURN count(p) AS total",
      );
      if (Number(remaining[0]?.total) !== 0) {
        throw new Error("Qualification probe removal failed");
      }
    } else {
      throw new Error(`Unknown qualification child mode: ${options.mode}`);
    }

    const validationAfter = await validateSafeRebuildCandidate(config);
    const graphsAfter = await graphSnapshots(conn, config);
    if (
      JSON.stringify(validationBefore) !== JSON.stringify(validationAfter) ||
      JSON.stringify(graphsBefore) !== JSON.stringify(graphsAfter)
    ) {
      throw new Error(
        "Original Symbol validation changed across qualification probe mutation",
      );
    }
    await execDdl(conn, "CHECKPOINT");
    return {
      mode: options.mode,
      cycle: options.cycle,
      validation: validationAfter,
      graphs: graphsAfter,
    };
  } finally {
    if (opened) await closeLadybugDb();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--child") parsed.childMode = argv[++index];
    else if (flag === "--clone") parsed.clonePath = argv[++index];
    else if (flag === "--source") parsed.sourcePath = argv[++index];
    else if (flag === "--config") parsed.configPath = argv[++index];
    else if (flag === "--expect-version") parsed.expectVersion = argv[++index];
    else if (flag === "--cycle") parsed.cycle = Number(argv[++index]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return parsed;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath);

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options.childMode) {
    runChildMode({
      mode: options.childMode,
      clonePath: resolve(options.clonePath),
      configPath: resolve(options.configPath),
      cycle: options.cycle,
    })
      .then((receipt) => {
        process.stdout.write(
          `${CHILD_RESULT_PREFIX}${JSON.stringify(receipt)}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `[sdl-mcp] Ladybug qualification child failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      });
  } else {
    qualifyLadybugDriver({
      sourcePath: options.sourcePath,
      configPath: options.configPath,
      expectVersion: options.expectVersion,
    })
      .then((receipt) => {
        process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      })
      .catch((error) => {
        const retained = error?.cloneRootPath
          ? ` Retained clone: ${error.cloneRootPath}`
          : "";
        process.stderr.write(
          `[sdl-mcp] Ladybug qualification failed: ${error instanceof Error ? error.message : String(error)}.${retained}\n`,
        );
        process.exitCode = 1;
      });
  }
}
