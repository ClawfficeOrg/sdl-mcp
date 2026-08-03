#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
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
import { resolveGraphDbPath } from "../dist/db/graph-db-path.js";
import {
  isWindowsFtsRuntimeUnavailable,
  withWindowsFtsRuntime,
} from "../dist/db/ladybug-windows-fts-runtime.js";
import { isNativeAddonGloballyEnabled } from "../dist/native/addon-loader.js";
import { normalizePath } from "../dist/util/paths.js";

const TOTAL_ROWS = 24_500;
const FIRST_BATCH_ROWS = 8_192;
const INSERT_BATCH_ROWS = 1_024;
const DELETE_START = 8_192;
const DELETE_END = 10_240;
const VECTOR_DIMENSIONS = 128;
const HNSW_PROBE_INDEX = 37;
const HNSW_INDEX_NAME = "driver_qualification_embedding_hnsw";
const FTS_INDEX_NAME = "driver_qualification_search_text_fts";
const FTS_PROBE_ID = "driver-qualification-fts-probe";
const FTS_PROBE_TEXT = "qualificationknown durable full text probe";
const PROJECTION_MATERIALIZATIONS = 5;
const NODE_STRING_ROWS = 10_000;
const NODE_STRING_BATCH_ROWS = 2_500;
const NODE_STRING_DELETE_START = 3_000;
const NODE_STRING_DELETE_END = 3_200;
const NODE_STRING_SURVIVING_ROWS =
  NODE_STRING_ROWS - (NODE_STRING_DELETE_END - NODE_STRING_DELETE_START);
const NODE_STRING_POINT_LOOKUPS = 64;
const QUALIFICATION_PHASES = [
  { phase: "seed-first-batch", rowCount: FIRST_BATCH_ROWS },
  { phase: "seed-remaining-batches", rowCount: TOTAL_ROWS },
  {
    phase: "create-hnsw",
    rowCount: TOTAL_ROWS,
    hnswState: "created",
  },
  {
    phase: "verify-hnsw-reopen",
    rowCount: TOTAL_ROWS,
    hnswState: "reopened-dropped",
  },
  {
    phase: "verify-hnsw-dropped",
    rowCount: TOTAL_ROWS,
    hnswState: "absent",
  },
  { phase: "create-fts", rowCount: TOTAL_ROWS, ftsState: "created" },
  {
    phase: "verify-fts-reopen",
    rowCount: TOTAL_ROWS,
    ftsState: "reopened-dropped",
  },
  {
    phase: "verify-fts-dropped",
    rowCount: TOTAL_ROWS,
    ftsState: "absent",
  },
  {
    phase: "validate-full-delete-range",
    rowCount: TOTAL_ROWS,
    afterRowCount: TOTAL_ROWS - (DELETE_END - DELETE_START),
    scan: true,
  },
  {
    phase: "validate-deleted-reinsert-range",
    rowCount: TOTAL_ROWS - (DELETE_END - DELETE_START),
    afterRowCount: TOTAL_ROWS,
    scan: true,
  },
  {
    phase: "validate-restored-delete-all",
    rowCount: TOTAL_ROWS,
    afterRowCount: 0,
    scan: true,
  },
  { phase: "validate-empty", rowCount: 0, scan: true },
  {
    phase: "validate-upstream-projection",
    rowCount: 0,
    projectedRead: true,
  },
  {
    phase: "seed-node-string-segments",
    rowCount: 0,
    nodeStringRowCount: NODE_STRING_SURVIVING_ROWS,
  },
  {
    phase: "validate-node-string-segment-scan",
    rowCount: 0,
    nodeStringRowCount: NODE_STRING_SURVIVING_ROWS,
    nodeStringScan: true,
  },
];
const CHILD_RESULT_PREFIX = "LADYBUG_QUALIFICATION_RESULT ";
const QUALIFICATION_AUTHORITY_FILENAME = ".qualification-authority.json";
const QUALIFICATION_AUTHORITY_NONCE_ENV =
  "SDL_LADYBUG_QUALIFICATION_AUTHORITY_NONCE";
const QUALIFICATION_AUTHORITY_PATH_ENV =
  "SDL_LADYBUG_QUALIFICATION_AUTHORITY_PATH";
const QUALIFICATION_AUTHORITY_VERSION = 1;
const MAX_QUALIFICATION_AUTHORITY_BYTES = 16 * 1024;
const QUALIFICATION_ROOT_PREFIX = "sdl-ladybug-qualification-";
const NO_QUALIFICATION_PHASE_FAILURE = Symbol("no phase failure");
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

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readBoundedQualificationAuthority(path) {
  const pathStat = lstatSync(path, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    invalidQualificationAuthority("marker must be a regular non-symlink file");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStat = fstatSync(descriptor, { bigint: true });
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      invalidQualificationAuthority("marker changed while being opened");
    }
    if (openedStat.size > BigInt(MAX_QUALIFICATION_AUTHORITY_BYTES)) {
      invalidQualificationAuthority(
        "marker exceeds " + MAX_QUALIFICATION_AUTHORITY_BYTES + " bytes",
      );
    }
    const bytes = Buffer.allocUnsafe(MAX_QUALIFICATION_AUTHORITY_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_QUALIFICATION_AUTHORITY_BYTES) {
      invalidQualificationAuthority(
        "marker exceeds " + MAX_QUALIFICATION_AUTHORITY_BYTES + " bytes",
      );
    }
    const finalStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = lstatSync(path, { bigint: true });
    if (
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino ||
      finalStat.size !== openedStat.size ||
      finalPathStat.dev !== openedStat.dev ||
      finalPathStat.ino !== openedStat.ino
    ) {
      invalidQualificationAuthority("marker changed while being read");
    }
    return bytes.subarray(0, total);
  } finally {
    closeSync(descriptor);
  }
}

function writeVerifiedQualificationConfigCopy(configPath, bytes) {
  const copyPath = join(
    dirname(resolve(configPath)),
    "." +
      basename(configPath) +
      ".qualification-" +
      randomBytes(16).toString("hex") +
      ".json",
  );
  const descriptor = openSync(copyPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return copyPath;
}

function databaseFamilyAuthority(role, primaryPath) {
  return {
    role,
    primaryPath: canonicalizePath(primaryPath),
    members: collectExistingFamily(primaryPath)
      .map((path) => {
        const stat = statSync(path, { bigint: true });
        return {
          path: canonicalizePath(path),
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path)),
    fingerprint: fingerprintDbFamily(primaryPath),
  };
}

export function createQualificationChildAuthority({
  mode,
  clonePath,
  configPath,
  sourcePath,
  activePaths = [],
}) {
  const forbiddenPaths = [sourcePath, ...activePaths];
  assertOfflineSourceDistinct(clonePath, forbiddenPaths);
  const cloneRootPath = dirname(resolve(clonePath));
  const authorityPath = join(cloneRootPath, QUALIFICATION_AUTHORITY_FILENAME);
  const nonce = randomBytes(32).toString("hex");
  writeFileSync(
    authorityPath,
    JSON.stringify({
      version: QUALIFICATION_AUTHORITY_VERSION,
      nonce,
      phase: mode,
      cloneRootPath: canonicalizePath(cloneRootPath),
      clonePath: canonicalizePath(clonePath),
      configPath: canonicalizePath(configPath),
      configSha256: fileSha256(configPath),
      cloneFamily: databaseFamilyAuthority("clone", clonePath),
      forbiddenFamilies: [
        databaseFamilyAuthority("source", sourcePath),
        ...activePaths.map((path) =>
          databaseFamilyAuthority("active", path),
        ),
      ],
    }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return { authorityPath, nonce };
}

function invalidQualificationAuthority(message) {
  throw new Error(`Invalid qualification authority: ${message}`);
}

export function consumeQualificationChildAuthority(
  options,
  env = process.env,
) {
  const authorityPath = env[QUALIFICATION_AUTHORITY_PATH_ENV];
  const nonce = env[QUALIFICATION_AUTHORITY_NONCE_ENV];
  if (!authorityPath || !nonce || !existsSync(authorityPath)) {
    throw new Error("Qualification authority is required for child mode");
  }

  const cloneRootPath = canonicalizePath(dirname(resolve(options.clonePath)));
  const clonePath = canonicalizePath(options.clonePath);
  if (
    canonicalizePath(dirname(cloneRootPath)) !== canonicalizePath(tmpdir()) ||
    !basename(cloneRootPath).startsWith(QUALIFICATION_ROOT_PREFIX) ||
    dirname(clonePath) !== cloneRootPath ||
    basename(resolve(options.clonePath)) !== "candidate.lbug" ||
    canonicalizePath(dirname(resolve(authorityPath))) !== cloneRootPath ||
    basename(resolve(authorityPath)) !== QUALIFICATION_AUTHORITY_FILENAME
  ) {
    invalidQualificationAuthority(
      "clone and marker must be contained in the parent qualification root",
    );
  }
  const markerStat = lstatSync(authorityPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    invalidQualificationAuthority("marker must be a regular file");
  }

  let authority;
  try {
    authority = JSON.parse(
      readBoundedQualificationAuthority(authorityPath).toString("utf8"),
    );
  } catch (cause) {
    invalidQualificationAuthority(
      `marker is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (
    !authority ||
    typeof authority !== "object" ||
    !/^[0-9a-f]{64}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(authority.nonce) ||
    !timingSafeEqual(
      Buffer.from(nonce, "hex"),
      Buffer.from(authority.nonce, "hex"),
    )
  ) {
    invalidQualificationAuthority("authority nonce does not match");
  }
  if (
    authority.version !== QUALIFICATION_AUTHORITY_VERSION ||
    authority.phase !== options.mode ||
    !QUALIFICATION_PHASES.some(({ phase }) => phase === authority.phase) ||
    authority.cloneRootPath !== cloneRootPath ||
    authority.clonePath !== clonePath ||
    authority.configPath !== canonicalizePath(options.configPath)
  ) {
    invalidQualificationAuthority("phase or canonical paths do not match");
  }
  const verifiedConfigBytes = readFileSync(options.configPath);
  if (
    authority.configSha256 !==
    createHash("sha256").update(verifiedConfigBytes).digest("hex")
  ) {
    invalidQualificationAuthority("config digest does not match");
  }
  if (
    env.SDL_CONFIG !== resolve(options.configPath) ||
    env.SDL_GRAPH_DB_PATH !== resolve(options.clonePath) ||
    env.SDL_CONFIG_PATH !== undefined ||
    env.SDL_GRAPH_DB_DIR !== undefined ||
    env.SDL_DB_PATH !== undefined
  ) {
    invalidQualificationAuthority("pinned SDL environment does not match");
  }

  if (
    !Array.isArray(authority.forbiddenFamilies) ||
    authority.forbiddenFamilies.length < 1 ||
    authority.forbiddenFamilies[0]?.role !== "source" ||
    authority.forbiddenFamilies
      .slice(1)
      .some((family) => family?.role !== "active")
  ) {
    invalidQualificationAuthority("forbidden database families are invalid");
  }
  const forbiddenPaths = new Set();
  const forbiddenIdentities = new Set();
  for (const family of authority.forbiddenFamilies) {
    if (
      typeof family.primaryPath !== "string" ||
      !Array.isArray(family.members) ||
      JSON.stringify(databaseFamilyAuthority(family.role, family.primaryPath)) !==
        JSON.stringify(family)
    ) {
      invalidQualificationAuthority(
        "forbidden database family identity changed",
      );
    }
    forbiddenPaths.add(family.primaryPath);
    for (const member of family.members) {
      forbiddenPaths.add(member.path);
      forbiddenIdentities.add(`${member.device}:${member.inode}`);
    }
  }
  const cloneFamily = databaseFamilyAuthority("clone", options.clonePath);
  if (
    JSON.stringify(cloneFamily) !== JSON.stringify(authority.cloneFamily) ||
    cloneFamily.members.length < 1 ||
    forbiddenPaths.has(cloneFamily.primaryPath) ||
    cloneFamily.members.some(
      (member) =>
        forbiddenPaths.has(member.path) ||
        forbiddenIdentities.has(`${member.device}:${member.inode}`),
    )
  ) {
    invalidQualificationAuthority(
      "clone aliases a forbidden database family",
    );
  }

  // Consume the capability before any LadybugDB module is imported or opened.
  rmSync(authorityPath);
  return {
    version: QUALIFICATION_AUTHORITY_VERSION,
    phase: authority.phase,
    clonePath,
    cloneFamily,
    forbiddenFamilies: authority.forbiddenFamilies,
    verifiedConfigBytes,
  };
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

export function buildQualificationChildEnv(
  baseEnv,
  clonePath,
  configPath,
  authority,
) {
  const childEnv = {
    ...baseEnv,
    SDL_CONFIG: resolve(configPath),
    SDL_GRAPH_DB_PATH: resolve(clonePath),
  };
  delete childEnv.SDL_CONFIG_PATH;
  delete childEnv.SDL_GRAPH_DB_DIR;
  delete childEnv.SDL_DB_PATH;
  delete childEnv[QUALIFICATION_AUTHORITY_NONCE_ENV];
  delete childEnv[QUALIFICATION_AUTHORITY_PATH_ENV];
  if (authority) {
    childEnv[QUALIFICATION_AUTHORITY_NONCE_ENV] = authority.nonce;
    childEnv[QUALIFICATION_AUTHORITY_PATH_ENV] = authority.authorityPath;
  }
  return childEnv;
}

export function resolveActiveDatabasePaths(config, configPath) {
  return [resolveGraphDbPath(config, resolve(configPath))];
}

function assertFingerprintEqual(expected, actual, message) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(message);
  }
}

function canonicalValue(value) {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value, canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalRowsIdentity(rows) {
  const canonicalRows = rows
    .map((row) => JSON.stringify(canonicalValue(row)))
    .sort();
  const digest = createHash("sha256");
  for (const row of canonicalRows) digest.update(`${row}\n`);
  return digest.digest("hex");
}

function rawIndexName(row) {
  return String(row.index_name ?? row.name ?? "");
}

function isQualificationIndex(row) {
  const tableName = String(row.table_name ?? row.tableName ?? "");
  return (
    tableName.startsWith("DriverQualification") ||
    [HNSW_INDEX_NAME, FTS_INDEX_NAME].includes(rawIndexName(row))
  );
}

async function rawIndexInventory(conn) {
  const { queryStoredProcAll } = await import(
    "../dist/db/ladybug-core.js"
  );
  return queryStoredProcAll(conn, "CALL SHOW_INDEXES() RETURN *");
}

function originalCatalogIdentity(rows) {
  return canonicalRowsIdentity(rows.filter((row) => !isQualificationIndex(row)));
}

function findQualificationIndex(rows, indexName) {
  return rows.find((row) => rawIndexName(row) === indexName);
}

function assertQualificationIndex(
  rows,
  { indexName, tableName, propertyName, type },
) {
  const row = findQualificationIndex(rows, indexName);
  if (!row) {
    throw new Error(`Qualification ${type} index ${indexName} is missing`);
  }
  const rawType = String(row.index_type ?? row.type ?? "").toLowerCase();
  const typeMatches =
    type === "vector"
      ? rawType.includes("vector") || rawType.includes("hnsw")
      : rawType.includes("fts") || rawType.includes("full");
  const actualTableName = String(row.table_name ?? row.tableName ?? "");
  const properties = Array.isArray(row.property_names)
    ? row.property_names.map(String)
    : [String(row.property_name ?? row.property ?? "")];
  if (
    !typeMatches ||
    actualTableName !== tableName ||
    !properties.includes(propertyName)
  ) {
    throw new Error(
      `Qualification ${type} index ${indexName} catalog identity is invalid`,
    );
  }
  return canonicalValue(row);
}

function assertQualificationIndexAbsent(rows, indexName, type) {
  if (findQualificationIndex(rows, indexName)) {
    throw new Error(`Qualification ${type} index ${indexName} is still present`);
  }
}

async function repositoryManifestIdentity(conn, config) {
  const {
    listGraphIntegrityFileStates,
    listGraphIntegrityFilelessStates,
  } = await import("../dist/db/ladybug-graph-integrity.js");
  const rows = [];
  for (const repo of [...config.repos].sort((left, right) =>
    left.repoId.localeCompare(right.repoId),
  )) {
    for (const row of await listGraphIntegrityFileStates(conn, repo.repoId)) {
      rows.push({ kind: "file", ...row });
    }
    for (const row of await listGraphIntegrityFilelessStates(
      conn,
      repo.repoId,
    )) {
      rows.push({ kind: "fileless", ...row });
    }
  }
  return canonicalRowsIdentity(rows);
}

export function assertNoCloneSidecars(clonePath) {
  const directory = dirname(clonePath);
  const databaseName = basename(clonePath);
  const dangling = readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith(`${databaseName}.`) &&
        name !== `${databaseName}.sdl-lineage.json`,
    )
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
  projectRoot,
  sourcePath,
  activePaths,
}) {
  const authority = createQualificationChildAuthority({
    mode,
    clonePath,
    configPath,
    sourcePath,
    activePaths,
  });
  try {
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
      ],
      {
        cwd: projectRoot,
        env: buildQualificationChildEnv(
          process.env,
          clonePath,
          configPath,
          authority,
        ),
        encoding: "utf8",
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
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
  } finally {
    // A failed or never-started child must not leave a reusable capability.
    rmSync(authority.authorityPath, { force: true });
  }
}

function graphIdentity(result) {
  return JSON.stringify({
    validation: result.validation,
    graphs: result.graphs,
    manifestIdentity: result.manifestIdentity,
    catalogIdentity: result.catalogIdentity,
  });
}

function assertPhaseReceipt(result, expected) {
  if (
    result.phase !== expected.phase ||
    result.rowCount !== expected.rowCount ||
    typeof result.manifestIdentity !== "string" ||
    typeof result.catalogIdentity !== "string" ||
    result.projectionRowCount !==
      (expected.phase === "seed-first-batch" ? FIRST_BATCH_ROWS : TOTAL_ROWS) ||
    (expected.afterRowCount !== undefined &&
      result.afterRowCount !== expected.afterRowCount)
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid receipt`,
    );
  }
  if (
    expected.scan &&
    result.scanDigest !== expectedDigestForPhase(expected.phase)
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned a scan digest mismatch`,
    );
  }
  if (
    expected.hnswState === "created" &&
    (!result.hnsw ||
      result.hnsw.created !== true ||
      result.hnsw.resultCount < 1 ||
      result.hnsw.matchedProbeId !== true ||
      result.hnsw.catalogPresent !== true)
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid HNSW receipt`,
    );
  }
  if (
    expected.hnswState === "reopened-dropped" &&
    (!result.hnsw ||
      result.hnsw.resultCount < 1 ||
      result.hnsw.matchedProbeId !== true ||
      result.hnsw.catalogPresent !== true ||
      result.hnsw.dropStatus !== "dropped")
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid reopened HNSW receipt`,
    );
  }
  if (
    expected.hnswState === "absent" &&
    result.hnsw?.catalogAbsent !== true
  ) {
    throw new Error(
      `Qualification child ${expected.phase} did not confirm the HNSW index was absent`,
    );
  }
  if (
    expected.ftsState === "created" &&
    (!result.fts ||
      result.fts.created !== true ||
      result.fts.catalogPresent !== true)
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid FTS receipt`,
    );
  }
  if (
    expected.ftsState === "reopened-dropped" &&
    (!result.fts ||
      result.fts.resultCount < 1 ||
      result.fts.matchedProbeId !== true ||
      result.fts.catalogPresent !== true ||
      result.fts.dropStatus !== "dropped")
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid reopened FTS receipt`,
    );
  }
  if (
    expected.ftsState === "absent" &&
    result.fts?.catalogAbsent !== true
  ) {
    throw new Error(
      `Qualification child ${expected.phase} did not confirm the FTS index was absent`,
    );
  }
  if (
    expected.projectedRead &&
    (result.projectionMaterializationCount !== PROJECTION_MATERIALIZATIONS ||
      result.projectionDigests?.length !== PROJECTION_MATERIALIZATIONS ||
      result.projectionDigests.some(
        (digest) => digest !== result.expectedProjectionDigest,
      ))
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned a projected-read digest mismatch`,
    );
  }
  if (
    expected.nodeStringRowCount !== undefined &&
    result.nodeStringRowCount !== expected.nodeStringRowCount
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid node-string row count`,
    );
  }
  if (
    expected.nodeStringScan &&
    (result.nodeStringScanRows !== NODE_STRING_SURVIVING_ROWS ||
      result.nodeStringPointLookups !== NODE_STRING_POINT_LOOKUPS)
  ) {
    throw new Error(
      `Qualification child ${expected.phase} returned an invalid node-string scan receipt`,
    );
  }
}

export async function qualifyLadybugDriver(options) {
  const actualVersion = installedLadybugVersion();
  if (actualVersion !== options.expectVersion) {
    throw new Error(
      `Expected Ladybug driver version ${options.expectVersion}, found ${actualVersion}`,
    );
  }
  if (process.platform === "win32" && !isNativeAddonGloballyEnabled()) {
    throw new Error(
      "Ladybug qualification requires SDL's verified OpenSSL preloader on Windows. " +
        "The caller must intentionally unset SDL_MCP_DISABLE_NATIVE_ADDON before running qualification.",
    );
  }

  const projectRoot = resolve(
    options.projectRoot ?? join(dirname(scriptPath), ".."),
  );
  const sourcePath = resolve(options.sourcePath);
  const configPath = resolve(options.configPath);
  const config = loadConfig(configPath);
  const activePaths = resolveActiveDatabasePaths(config, configPath);
  assertOfflineSourceDistinct(sourcePath, activePaths);

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
    assertOfflineSourceDistinct(clonePath, [sourcePath, ...activePaths]);

    let expectedGraphIdentity;
    const phases = [];
    for (const phase of QUALIFICATION_PHASES) {
      console.error(`[ladybug qualification] starting ${phase.phase}`);
      const result = runQualificationChild({
        mode: phase.phase,
        clonePath,
        configPath,
        projectRoot,
        sourcePath,
        activePaths,
      });
      assertFingerprintEqual(
        sourceBefore,
        fingerprintDbFamily(sourcePath),
        `Offline source changed during qualification phase ${phase.phase}`,
      );
      assertPhaseReceipt(result, phase);
      const identity = graphIdentity(result);
      if (expectedGraphIdentity === undefined) {
        expectedGraphIdentity = identity;
      } else if (identity !== expectedGraphIdentity) {
        throw new Error(
          `Graph counts or digest changed during qualification phase ${phase.phase}`,
        );
      }
      phases.push(result);
      console.error(`[ladybug qualification] completed ${phase.phase}`);
    }

    const fullScan = phases.find(
      ({ phase }) => phase === "validate-full-delete-range",
    );
    const deletedScan = phases.find(
      ({ phase }) => phase === "validate-deleted-reinsert-range",
    );
    const restoredScan = phases.find(
      ({ phase }) => phase === "validate-restored-delete-all",
    );
    if (
      fullScan.scanDigest !== restoredScan.scanDigest ||
      fullScan.scanDigest === deletedScan.scanDigest
    ) {
      throw new Error("Qualification phase digest lifecycle is inconsistent");
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
      totalRows: TOTAL_ROWS,
      phases,
      graphIdentity: JSON.parse(expectedGraphIdentity),
      cleaned: true,
    };
    await rm(cloneRootPath, { recursive: true });
    return receipt;
  } catch (cause) {
    let error = cause instanceof Error ? cause : new Error(String(cause));
    try {
      assertFingerprintEqual(
        sourceBefore,
        fingerprintDbFamily(sourcePath),
        "Offline source changed during failed Ladybug qualification",
      );
    } catch (fingerprintError) {
      error = new Error(
        `${error.message}; ${fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError)}`,
        { cause: error },
      );
    }
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

function* probeEmbeddingValues(index, seed = 1) {
  let state = Math.imul(index + seed, 0x9e3779b1) >>> 0;
  for (let dimension = 0; dimension < VECTOR_DIMENSIONS; dimension += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    yield ((state & 0xffff) + 1) / 65_536;
  }
}

function probeEmbedding(index, seed = 1) {
  return Array.from(probeEmbeddingValues(index, seed));
}

function probeId(index) {
  const hex = index.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Preserve the observed upstream string payloads byte-for-byte; their allocation shape is part of the reproducer.
const UPSTREAM_NAMES = [
  "RenÃ© Tremblay",
  "BenoÃ®t Lefebvre",
  "NoÃ«l GagnÃ©",
  "AimÃ©e CÃ´tÃ©",
  "JÃ©rÃ´me BÃ©langer",
  "ZoÃ© Bergeron",
  "FranÃ§ois LÃ©vesque",
  "Ã‰lise Boucher",
];

function projectedProbeRow(index) {
  const ordinal = String(index).padStart(6, "0");
  return {
    id: probeId(index),
    shortText: index % 19 === 0 ? null : `short-${ordinal}`,
    longText:
      index % 23 === 0
        ? null
        : `${UPSTREAM_NAMES[index % UPSTREAM_NAMES.length]}-${ordinal}-${"x".repeat(48 + (index % 48))}`,
    unicodeText:
      index % 29 === 0 ? null : `Î»-${ordinal}-MontrÃ©al-æ±äº¬-ðŸ™‚`,
    optionalText:
      index % 31 === 0 ? null : `HAIFA_INFERRED-${index % 97}`,
    sortKey: index,
  };
}

function probeInsertRow(index) {
  return {
    ...projectedProbeRow(index),
    embedding: probeEmbedding(index),
  };
}

function seededUnit(index, salt) {
  let state = Math.imul(index + 42, 0x9e3779b1 + salt) >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4_294_967_296;
}

function upstreamProjectedRow(index) {
  const sparse = index % 260 === 0;
  return {
    clusterId: probeId(index),
    candidateName: sparse
      ? UPSTREAM_NAMES[index % UPSTREAM_NAMES.length]
      : null,
    haifaConfidence: sparse ? "HAIFA_INFERRED" : null,
    memberCount: 1 + Math.floor(seededUnit(index, 1) * 170),
    cohesionScore: seededUnit(index, 2),
  };
}

function upstreamInsertRow(index) {
  return {
    ...upstreamProjectedRow(index),
    embedding: probeEmbedding(index, 42),
    enabled: seededUnit(index, 3) >= 0.5,
    optionalText:
      index % 3 === 0 ? null : `projection-${String(index).padStart(6, "0")}`,
  };
}

function phaseIncludesIndex(phase, index) {
  if (phase === "seed-first-batch") return index < FIRST_BATCH_ROWS;
  if (
    phase === "validate-deleted-reinsert-range" &&
    index >= DELETE_START &&
    index < DELETE_END
  ) {
    return false;
  }
  return ![
    "validate-empty",
    "validate-upstream-projection",
    "seed-node-string-segments",
    "validate-node-string-segment-scan",
  ].includes(phase);
}

function serializedProbeRow(row) {
  return JSON.stringify([
    row.id,
    row.shortText,
    row.longText,
    row.unicodeText,
    row.optionalText,
    row.sortKey,
  ]);
}

function expectedDigestForPhase(phase) {
  const digest = createHash("sha256");
  for (let index = TOTAL_ROWS - 1; index >= 0; index -= 1) {
    if (phaseIncludesIndex(phase, index)) {
      digest.update(serializedProbeRow(projectedProbeRow(index)));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

async function countProbeRows(conn) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const rows = await queryAll(
    conn,
    "MATCH (p:DriverQualificationProbe) RETURN count(p) AS total",
  );
  return Number(rows[0]?.total);
}

async function countUpstreamProjectionRows(conn) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const rows = await queryAll(
    conn,
    "MATCH (p:DriverQualificationProjection) RETURN count(p) AS total",
  );
  return Number(rows[0]?.total);
}

async function countNodeStringRows(conn) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const rows = await queryAll(
    conn,
    "MATCH (n:DriverQualificationNodeString) RETURN count(n) AS total",
  );
  return Number(rows[0]?.total);
}

async function insertProbeRange(conn, start, end) {
  const { exec } = await import("../dist/db/ladybug-core.js");
  for (let batchStart = start; batchStart < end; batchStart += INSERT_BATCH_ROWS) {
    const batchEnd = Math.min(end, batchStart + INSERT_BATCH_ROWS);
    const rows = Array.from(
      { length: batchEnd - batchStart },
      (_, offset) => probeInsertRow(batchStart + offset),
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MERGE (p:DriverQualificationProbe {id: row.id})
       SET p.shortText = row.shortText,
           p.longText = row.longText,
           p.unicodeText = row.unicodeText,
           p.optionalText = row.optionalText,
           p.sortKey = row.sortKey,
           p.embedding = row.embedding`,
      { rows },
    );
  }
}

async function insertUpstreamProjectionRange(conn, start, end) {
  const prepared = await conn.prepare(
    `MERGE (p:DriverQualificationProjection {cluster_id: $clusterId})
     SET p.embedding = $embedding,
         p.cohesion_score = $cohesionScore,
         p.candidate_name = $candidateName,
         p.haifa_confidence = $haifaConfidence,
         p.member_count = $memberCount,
         p.enabled = $enabled,
         p.optional_text = $optionalText,
         p.created_at = timestamp('2026-01-01 00:00:00'),
         p.updated_at = timestamp('2026-01-02 00:00:00')`,
  );
  if (!prepared.isSuccess()) {
    throw new Error(
      `Qualification upstream projection prepare failed: ${prepared.getErrorMessage()}`,
    );
  }
  for (let index = start; index < end; index += 1) {
    const result = await conn.execute(prepared, upstreamInsertRow(index));
    result.close();
  }
}

function normalizeProjectedRow(row) {
  return {
    id: row.id,
    shortText: row.shortText,
    longText: row.longText,
    unicodeText: row.unicodeText,
    optionalText: row.optionalText,
    sortKey: Number(row.sortKey),
    embedding: Array.from(row.embedding ?? [], Number),
  };
}

function mismatchValue(value) {
  if (typeof value === "string" && value.length > 80) {
    return `${JSON.stringify(value.slice(0, 80))}...(length=${value.length})`;
  }
  if (Array.isArray(value)) {
    return `[length=${value.length}, first=${value.slice(0, 4).join(",")}]`;
  }
  return JSON.stringify(value);
}

function assertProjectedRow(actualValue, expected, ordinal, context) {
  const actual = normalizeProjectedRow(actualValue);
  for (const field of [
    "id",
    "shortText",
    "longText",
    "unicodeText",
    "optionalText",
    "sortKey",
  ]) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `Qualification probe ${context} mismatch at ordered row ${ordinal} field ${field}: expected ${mismatchValue(expected[field])}, received ${mismatchValue(actual[field])}`,
      );
    }
  }
  return actual;
}

function assertProbeEmbedding(actual, index, context) {
  if (actual.length !== VECTOR_DIMENSIONS) {
    throw new Error(
      `Qualification probe ${context} mismatch at ordered row ${index} field embedding: expected length ${VECTOR_DIMENSIONS}, received ${actual.length}`,
    );
  }
  let dimension = 0;
  for (const expected of probeEmbeddingValues(index)) {
    if (actual[dimension] !== expected) {
      throw new Error(
        `Qualification probe ${context} mismatch at ordered row ${index} field embedding[${dimension}]: expected ${expected}, received ${actual[dimension]}`,
      );
    }
    dimension += 1;
  }
}

async function validatePointLookups(conn, phase) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const sampleIndexes =
    phase === "validate-empty"
      ? [0]
      : [0, HNSW_PROBE_INDEX, 8_191, 10_240, 16_384, TOTAL_ROWS - 1];
  let validated = 0;
  for (const index of sampleIndexes) {
    const expected = projectedProbeRow(index);
    const rows = await queryAll(
      conn,
      `MATCH (p:DriverQualificationProbe {id: $id})
       RETURN p.id AS id,
              p.shortText AS shortText,
              p.longText AS longText,
              p.unicodeText AS unicodeText,
              p.optionalText AS optionalText,
              p.sortKey AS sortKey,
              p.embedding AS embedding`,
      { id: expected.id },
    );
    const included = phaseIncludesIndex(phase, index);
    if (!included) {
      if (rows.length !== 0) {
        throw new Error(
          `Qualification probe point lookup mismatch for deleted id ${expected.id}`,
        );
      }
      validated += 1;
      continue;
    }
    if (rows.length !== 1) {
      throw new Error(
        `Qualification probe point lookup mismatch for ${expected.id}: expected one row, received ${rows.length}`,
      );
    }
    const actual = assertProjectedRow(rows[0], expected, index, "point lookup");
    assertProbeEmbedding(actual.embedding, index, "point lookup");
    validated += 1;
  }
  if (phase === "validate-deleted-reinsert-range") {
    const deleted = projectedProbeRow(DELETE_START + 7);
    const rows = await queryAll(
      conn,
      "MATCH (p:DriverQualificationProbe {id: $id}) RETURN p.id AS id",
      { id: deleted.id },
    );
    if (rows.length !== 0) {
      throw new Error(
        `Qualification probe point lookup mismatch for deleted id ${deleted.id}`,
      );
    }
    validated += 1;
  }
  return validated;
}

async function validateProjectedScan(conn, phase) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const scanQuery = `MATCH (p:DriverQualificationProbe)
     RETURN p.id AS id,
            p.shortText AS shortText,
            p.longText AS longText,
            p.unicodeText AS unicodeText,
            p.optionalText AS optionalText,
            p.sortKey AS sortKey
     ORDER BY p.id DESC`;
  const rows = await queryAll(conn, scanQuery);
  const expectedCount = QUALIFICATION_PHASES.find(
    (candidate) => candidate.phase === phase,
  ).rowCount;
  if (rows.length !== expectedCount) {
    throw new Error(
      `Qualification probe scan mismatch: expected ${expectedCount} rows, received ${rows.length}`,
    );
  }

  // Keep the first result live across allocator churn; 0.18.1 otherwise passes
  // intermittently when its prematurely freed string buffers are not reused.
  const materializations =
    rows.length === 0 ? [rows] : [rows, await queryAll(conn, scanQuery)];
  const digest = createHash("sha256");
  for (
    let materialization = 0;
    materialization < materializations.length;
    materialization += 1
  ) {
    const scanRows = materializations[materialization];
    if (scanRows.length !== expectedCount) {
      throw new Error(
        `Qualification probe scan replay mismatch: expected ${expectedCount} rows, received ${scanRows.length}`,
      );
    }
    let expectedIndex = TOTAL_ROWS - 1;
    for (let ordinal = 0; ordinal < scanRows.length; ordinal += 1) {
      while (expectedIndex >= 0 && !phaseIncludesIndex(phase, expectedIndex)) {
        expectedIndex -= 1;
      }
      if (expectedIndex < 0) {
        throw new Error(
          `Qualification probe scan mismatch: unexpected ordered row ${ordinal}`,
        );
      }
      const actual = assertProjectedRow(
        scanRows[ordinal],
        projectedProbeRow(expectedIndex),
        ordinal,
        materialization === 0 ? "scan" : "scan replay",
      );
      if (materialization === 0) {
        digest.update(serializedProbeRow(actual));
        digest.update("\n");
      }
      expectedIndex -= 1;
    }
  }
  return { rowCount: rows.length, scanDigest: digest.digest("hex") };
}

function serializedUpstreamProjectedRow(row) {
  return JSON.stringify([
    row.clusterId,
    row.candidateName,
    row.haifaConfidence,
    row.memberCount,
    row.cohesionScore,
  ]);
}

function normalizeUpstreamProjectedRow(row) {
  return {
    clusterId: row.clusterId,
    candidateName: row.candidateName,
    haifaConfidence: row.haifaConfidence,
    memberCount: Number(row.memberCount),
    cohesionScore: Number(row.cohesionScore),
  };
}

function assertUpstreamProjectedRow(actual, expected, ordinal) {
  for (const field of [
    "clusterId",
    "candidateName",
    "haifaConfidence",
    "memberCount",
    "cohesionScore",
  ]) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `value mismatch at ordered row ${ordinal} field ${field}: expected ${mismatchValue(expected[field])}, received ${mismatchValue(actual[field])}`,
      );
    }
  }
}

async function validateUpstreamProjection(conn) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const expectedRows = Array.from({ length: TOTAL_ROWS }, (_, index) =>
    upstreamProjectedRow(index),
  );
  const expectedById = new Map(
    expectedRows.map((row) => [row.clusterId, row]),
  );
  const projection = `MATCH (p:DriverQualificationProjection)
     RETURN p.cluster_id AS clusterId,
            p.candidate_name AS candidateName,
            p.haifa_confidence AS haifaConfidence,
            p.member_count AS memberCount,
            p.cohesion_score AS cohesionScore
     ORDER BY p.member_count DESC`;

  const aggregates = await queryAll(
    conn,
    `MATCH (p:DriverQualificationProjection)
     RETURN count(p) AS total, sum(p.member_count) AS memberTotal`,
  );
  if (Number(aggregates[0]?.total) !== TOTAL_ROWS) {
    throw new Error("Qualification projected read aggregate control failed");
  }

  const singleColumn = await queryAll(
    conn,
    `MATCH (p:DriverQualificationProjection)
     RETURN p.cluster_id AS clusterId
     ORDER BY p.member_count DESC`,
  );
  if (
    singleColumn.length !== TOTAL_ROWS ||
    new Set(singleColumn.map(({ clusterId }) => clusterId)).size !== TOTAL_ROWS
  ) {
    throw new Error("Qualification projected read single-column control failed");
  }

  const smallRead = await queryAll(conn, `${projection}\n     LIMIT 16`);
  for (let ordinal = 0; ordinal < smallRead.length; ordinal += 1) {
    const actual = normalizeUpstreamProjectedRow(smallRead[ordinal]);
    const expected = expectedById.get(actual.clusterId);
    if (!expected) {
      throw new Error(
        `Qualification projected read small-read mismatch at ordered row ${ordinal}`,
      );
    }
    assertUpstreamProjectedRow(actual, expected, ordinal);
  }

  const materializations = [];
  for (let index = 0; index < PROJECTION_MATERIALIZATIONS; index += 1) {
    try {
      // Keep every complete result live so repeated materialization exercises #725.
      materializations.push(await queryAll(conn, projection));
    } catch (cause) {
      throw new Error(
        `Qualification projected read delivery failed at materialization ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  try {
    const canonicalOrder = (left, right) =>
      right.memberCount - left.memberCount ||
      String(left.clusterId).localeCompare(String(right.clusterId));
    expectedRows.sort(canonicalOrder);
    const expectedDigest = createHash("sha256");
    for (const row of expectedRows) {
      expectedDigest.update(`${serializedUpstreamProjectedRow(row)}\n`);
    }
    const expectedProjectionDigest = expectedDigest.digest("hex");
    const projectionDigests = [];

    for (
      let materialization = 0;
      materialization < materializations.length;
      materialization += 1
    ) {
      const rows = materializations[materialization];
      if (rows.length !== TOTAL_ROWS) {
        throw new Error(
          `materialization ${materialization + 1} row-count mismatch: expected ${TOTAL_ROWS}, received ${rows.length}`,
        );
      }
      let previousMemberCount = Number.POSITIVE_INFINITY;
      const normalized = rows.map((row, ordinal) => {
        const actual = normalizeUpstreamProjectedRow(row);
        if (actual.memberCount > previousMemberCount) {
          throw new Error(
            `materialization ${materialization + 1} ordering mismatch at ordered row ${ordinal}: ${actual.memberCount} follows ${previousMemberCount}`,
          );
        }
        previousMemberCount = actual.memberCount;
        const expected = expectedById.get(actual.clusterId);
        if (!expected) {
          throw new Error(
            `materialization ${materialization + 1} value mismatch at ordered row ${ordinal} field clusterId: received ${mismatchValue(actual.clusterId)}`,
          );
        }
        assertUpstreamProjectedRow(actual, expected, ordinal);
        return actual;
      });
      normalized.sort(canonicalOrder);
      const digest = createHash("sha256");
      for (const row of normalized) {
        digest.update(`${serializedUpstreamProjectedRow(row)}\n`);
      }
      const projectionDigest = digest.digest("hex");
      if (projectionDigest !== expectedProjectionDigest) {
        throw new Error(
          `materialization ${materialization + 1} digest mismatch: expected ${expectedProjectionDigest}, received ${projectionDigest}`,
        );
      }
      projectionDigests.push(projectionDigest);
    }

    return {
      projectionMaterializationCount: materializations.length,
      projectionDigests,
      expectedProjectionDigest,
    };
  } catch (cause) {
    throw new Error(
      `Qualification projected read comparison failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}


function nodeStringValue(id) {
  return `text_payload_${String(id).padStart(8, "0")}_lorem_ipsum_dolor`;
}

function expectedNodeStringId(ordinal) {
  return ordinal < NODE_STRING_DELETE_START
    ? ordinal
    : ordinal + (NODE_STRING_DELETE_END - NODE_STRING_DELETE_START);
}

async function validateNodeStringSegmentScan(conn) {
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  let sizeRows;
  let textRows;
  try {
    // Keep the upstream queries unordered so Ladybug uses its sequential-scan path.
    sizeRows = await queryAll(
      conn,
      `MATCH (n:DriverQualificationNodeString)
       RETURN n.id AS id, size(n.txt) AS textSize`,
    );
    textRows = await queryAll(
      conn,
      `MATCH (n:DriverQualificationNodeString)
       RETURN n.id AS id, n.txt AS txt`,
    );
  } catch (cause) {
    throw new Error(
      `Qualification node-string projected scan delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  try {
    if (
      sizeRows.length !== NODE_STRING_SURVIVING_ROWS ||
      textRows.length !== NODE_STRING_SURVIVING_ROWS
    ) {
      throw new Error(
        `row-count mismatch: expected ${NODE_STRING_SURVIVING_ROWS}, received size=${sizeRows.length}, text=${textRows.length}`,
      );
    }
    sizeRows.sort((left, right) => Number(left.id) - Number(right.id));
    textRows.sort((left, right) => Number(left.id) - Number(right.id));

    for (
      let ordinal = 0;
      ordinal < NODE_STRING_SURVIVING_ROWS;
      ordinal += 1
    ) {
      const expectedId = expectedNodeStringId(ordinal);
      const expectedText = nodeStringValue(expectedId);
      const sizeRow = sizeRows[ordinal];
      const textRow = textRows[ordinal];
      const scanId = Number(sizeRow.id);
      const textScanId = Number(textRow.id);
      const scanSize = Number(sizeRow.textSize);
      const scanText = textRow.txt;
      if (
        scanId !== expectedId ||
        textScanId !== expectedId ||
        scanSize !== expectedText.length ||
        scanText !== expectedText
      ) {
        throw new Error(
          `value mismatch at surviving id ${expectedId}: scan ids=${scanId}/${textScanId}, scan size=${scanSize}, scan text=${mismatchValue(scanText)}`,
        );
      }
    }

    const pointLookup = await conn.prepare(
      `MATCH (n:DriverQualificationNodeString {id: $id})
       RETURN size(n.txt) AS textSize, n.txt AS txt`,
    );
    if (!pointLookup.isSuccess()) {
      throw new Error(
        `point lookup prepare failed: ${pointLookup.getErrorMessage()}`,
      );
    }

    // ponytail: Bound PK verification to 64 deterministic boundary-heavy reads; expand only if sampled point-read coverage proves insufficient.
    const pointLookupIds = new Set([
      0,
      1,
      NODE_STRING_BATCH_ROWS - 2,
      NODE_STRING_BATCH_ROWS - 1,
      NODE_STRING_BATCH_ROWS,
      NODE_STRING_BATCH_ROWS + 1,
      NODE_STRING_DELETE_START - 2,
      NODE_STRING_DELETE_START - 1,
      NODE_STRING_DELETE_START,
      NODE_STRING_DELETE_START + 1,
      NODE_STRING_DELETE_END - 2,
      NODE_STRING_DELETE_END - 1,
      NODE_STRING_DELETE_END,
      NODE_STRING_DELETE_END + 1,
      NODE_STRING_BATCH_ROWS * 2 - 1,
      NODE_STRING_BATCH_ROWS * 2,
      NODE_STRING_BATCH_ROWS * 2 + 1,
      NODE_STRING_BATCH_ROWS * 3 - 1,
      NODE_STRING_BATCH_ROWS * 3,
      NODE_STRING_BATCH_ROWS * 3 + 1,
      NODE_STRING_ROWS - 2,
      NODE_STRING_ROWS - 1,
    ]);
    for (
      let candidate = 0;
      pointLookupIds.size < NODE_STRING_POINT_LOOKUPS;
      candidate = (candidate + 1_543) % NODE_STRING_ROWS
    ) {
      pointLookupIds.add(candidate);
    }

    let pointLookups = 0;
    for (const expectedId of [...pointLookupIds].sort(
      (left, right) => left - right,
    )) {
      const expectedText = nodeStringValue(expectedId);
      let result;
      let pointRows;
      try {
        result = await conn.execute(pointLookup, { id: expectedId });
        pointRows = await result.getAll();
      } finally {
        result?.close();
      }
      const expectedRows =
        expectedId >= NODE_STRING_DELETE_START &&
        expectedId < NODE_STRING_DELETE_END
          ? 0
          : 1;
      if (pointRows.length !== expectedRows) {
        throw new Error(
          `point lookup control mismatch at id ${expectedId}: expected ${expectedRows} rows, received ${pointRows.length}`,
        );
      }
      pointLookups += 1;
      if (expectedRows === 0) continue;

      const pointSize = Number(pointRows[0].textSize);
      const pointText = pointRows[0].txt;
      if (pointSize !== expectedText.length || pointText !== expectedText) {
        throw new Error(
          `point lookup control mismatch at id ${expectedId}: size=${pointSize}, text=${mismatchValue(pointText)}`,
        );
      }
    }

    return {
      nodeStringScanRows: sizeRows.length,
      nodeStringPointLookups: pointLookups,
    };
  } catch (cause) {
    throw new Error(
      `Qualification node-string projected scan comparison failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function hnswNodeId(row) {
  return (
    row.id ??
    row.node?.id ??
    row.node?.properties?.id ??
    row.node?._properties?.id ??
    row._node?.id ??
    row._node?.properties?.id ??
    row._node?._properties?.id ??
    ""
  );
}

async function queryQualificationHnsw(conn) {
  const { queryStoredProcAll } = await import("../dist/db/ladybug-core.js");
  const probeEmbeddingVector = probeEmbedding(HNSW_PROBE_INDEX);
  const rows = await queryStoredProcAll(
    conn,
    `CALL QUERY_VECTOR_INDEX('DriverQualificationProbe', '${HNSW_INDEX_NAME}', [${probeEmbeddingVector.join(",")}], 16) RETURN node, distance`,
  );
  const ids = rows.map(hnswNodeId);
  return {
    resultCount: rows.length,
    matchedProbeId: ids.includes(probeId(HNSW_PROBE_INDEX)),
    firstId: ids[0] ?? "",
  };
}

async function queryQualificationFts(conn) {
  const { queryStoredProcAll } = await import(
    "../dist/db/ladybug-core.js"
  );
  const rows = await queryStoredProcAll(
    conn,
    `CALL QUERY_FTS_INDEX('DriverQualificationFts', '${FTS_INDEX_NAME}', 'qualificationknown') RETURN node.id AS id`,
  );
  const ids = rows.map(({ id }) => String(id)).sort();
  return {
    resultCount: rows.length,
    matchedProbeId: ids.includes(FTS_PROBE_ID),
    firstId: ids[0] ?? "",
  };
}

async function validateOriginalGraph(conn, config) {
  const { validateSafeRebuildCandidate } = await import(
    "../dist/cli/commands/index-safe-rebuild.js"
  );
  const indexes = await rawIndexInventory(conn);
  return {
    validation: await validateSafeRebuildCandidate(config),
    graphs: await graphSnapshots(conn, config),
    manifestIdentity: await repositoryManifestIdentity(conn, config),
    catalogIdentity: originalCatalogIdentity(indexes),
  };
}

export async function closeQualificationPhaseStrictly(
  close,
  phaseFailure = NO_QUALIFICATION_PHASE_FAILURE,
) {
  try {
    await close();
  } catch (closeFailure) {
    if (phaseFailure !== NO_QUALIFICATION_PHASE_FAILURE) {
      throw new AggregateError(
        [phaseFailure, closeFailure],
        "Ladybug qualification phase and database close both failed",
      );
    }
    throw closeFailure;
  }
}

async function runChildMode(options) {
  const qualificationAuthority = consumeQualificationChildAuthority(options);
  const verifiedConfigPath = writeVerifiedQualificationConfigCopy(
    options.configPath,
    qualificationAuthority.verifiedConfigBytes,
  );
  const previousConfigPath = process.env.SDL_CONFIG;
  process.env.SDL_CONFIG = verifiedConfigPath;
  try {
  const {
    closeLadybugDb,
    getLadybugConn,
    getLadybugDbPath,
    initQualificationLadybugClone,
  } = await import("../dist/db/ladybug.js");
  const { exec, execCheckpoint, execDdl } = await import(
    "../dist/db/ladybug-core.js"
  );
  const {
    createFtsIndex,
    createVectorIndex,
    dropFtsIndex,
    dropVectorIndex,
  } = await import("../dist/retrieval/index-lifecycle.js");
  const config = loadConfig(verifiedConfigPath);
  // Cleanup ownership precedes init so a partial native/schema open is always
  // subjected to the strict close path.
  let opened = true;
  let phaseFailure = NO_QUALIFICATION_PHASE_FAILURE;

  try {
    await initQualificationLadybugClone(
      options.clonePath,
      qualificationAuthority,
    );
    if (
      canonicalizePath(getLadybugDbPath()) !==
      canonicalizePath(options.clonePath)
    ) {
      throw new Error("Initialized LadybugDB path does not equal clone path");
    }

    const conn = await getLadybugConn();
    if (["create-hnsw", "verify-hnsw-reopen"].includes(options.mode)) {
      // Both explicit extension loads need the verified Windows OpenSSL scope.
      const loadResult = await withWindowsFtsRuntime(() =>
        execDdl(conn, "LOAD EXTENSION vector"),
      );
      if (isWindowsFtsRuntimeUnavailable(loadResult)) {
        throw new Error(loadResult.recovery);
      }
    }
    if (["create-fts", "verify-fts-reopen"].includes(options.mode)) {
      const loadResult = await withWindowsFtsRuntime(() =>
        execDdl(conn, "LOAD EXTENSION fts"),
      );
      if (isWindowsFtsRuntimeUnavailable(loadResult)) {
        throw new Error(loadResult.recovery);
      }
    }
    const before = await validateOriginalGraph(conn, config);
    let phaseResult;
    let checkpointComplete = false;

    if (options.mode === "seed-first-batch") {
      await execDdl(
        conn,
        `CREATE NODE TABLE IF NOT EXISTS DriverQualificationProbe (
          id STRING,
          shortText STRING,
          longText STRING,
          unicodeText STRING,
          optionalText STRING,
          sortKey INT64,
          embedding FLOAT[128],
          PRIMARY KEY(id)
        )`,
      );
      await execDdl(
        conn,
        `CREATE NODE TABLE IF NOT EXISTS DriverQualificationProjection (
          cluster_id STRING,
          embedding FLOAT[128],
          cohesion_score DOUBLE,
          candidate_name STRING,
          haifa_confidence STRING,
          member_count INT64,
          enabled BOOL,
          optional_text STRING,
          created_at TIMESTAMP,
          updated_at TIMESTAMP,
          PRIMARY KEY(cluster_id)
        )`,
      );
      await execDdl(
        conn,
        `CREATE NODE TABLE IF NOT EXISTS DriverQualificationFts (
          id STRING,
          searchText STRING,
          PRIMARY KEY(id)
        )`,
      );
      await exec(
        conn,
        `MERGE (probe:DriverQualificationFts {id: $id})
         SET probe.searchText = $searchText`,
        { id: FTS_PROBE_ID, searchText: FTS_PROBE_TEXT },
      );
      await insertProbeRange(conn, 0, FIRST_BATCH_ROWS);
      await insertUpstreamProjectionRange(conn, 0, FIRST_BATCH_ROWS);
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
      };
    } else if (options.mode === "seed-remaining-batches") {
      await insertProbeRange(conn, FIRST_BATCH_ROWS, TOTAL_ROWS);
      await insertUpstreamProjectionRange(conn, FIRST_BATCH_ROWS, TOTAL_ROWS);
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
      };
    } else if (options.mode === "create-hnsw") {
      const created = await createVectorIndex(
        conn,
        "DriverQualificationProbe",
        "embedding",
        HNSW_INDEX_NAME,
        VECTOR_DIMENSIONS,
      );
      if (!created) {
        throw new Error("Qualification HNSW index creation failed");
      }
      const hnsw = await queryQualificationHnsw(conn);
      if (hnsw.resultCount < 1 || !hnsw.matchedProbeId) {
        throw new Error("Qualification HNSW query did not return the probe row");
      }
      const catalogEntry = assertQualificationIndex(
        await rawIndexInventory(conn),
        {
          indexName: HNSW_INDEX_NAME,
          tableName: "DriverQualificationProbe",
          propertyName: "embedding",
          type: "vector",
        },
      );
      await execCheckpoint(conn);
      checkpointComplete = true;
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        hnsw: {
          created,
          ...hnsw,
          catalogPresent: true,
          catalogEntry,
        },
      };
    } else if (options.mode === "verify-hnsw-reopen") {
      const catalogEntry = assertQualificationIndex(
        await rawIndexInventory(conn),
        {
          indexName: HNSW_INDEX_NAME,
          tableName: "DriverQualificationProbe",
          propertyName: "embedding",
          type: "vector",
        },
      );
      const hnsw = await queryQualificationHnsw(conn);
      if (hnsw.resultCount < 1 || !hnsw.matchedProbeId) {
        throw new Error(
          "Qualification reopened HNSW query did not return the probe row",
        );
      }
      const dropped = await dropVectorIndex(
        conn,
        "DriverQualificationProbe",
        HNSW_INDEX_NAME,
      );
      if (dropped.status !== "dropped") {
        throw new Error(
          `Qualification HNSW index drop failed: ${dropped.error ?? dropped.status}`,
        );
      }
      await execCheckpoint(conn);
      checkpointComplete = true;
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        hnsw: {
          ...hnsw,
          catalogPresent: true,
          catalogEntry,
          dropStatus: dropped.status,
        },
      };
    } else if (options.mode === "verify-hnsw-dropped") {
      assertQualificationIndexAbsent(
        await rawIndexInventory(conn),
        HNSW_INDEX_NAME,
        "vector",
      );
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        hnsw: { catalogAbsent: true },
      };
    } else if (options.mode === "create-fts") {
      const created = await createFtsIndex(
        conn,
        "DriverQualificationFts",
        FTS_INDEX_NAME,
      );
      if (!created) {
        throw new Error(
          "Qualification FTS index creation failed: CREATE_FTS_INDEX is unavailable",
        );
      }
      const catalogEntry = assertQualificationIndex(
        await rawIndexInventory(conn),
        {
          indexName: FTS_INDEX_NAME,
          tableName: "DriverQualificationFts",
          propertyName: "searchText",
          type: "fts",
        },
      );
      await execCheckpoint(conn);
      checkpointComplete = true;
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        fts: { created, catalogPresent: true, catalogEntry },
      };
    } else if (options.mode === "verify-fts-reopen") {
      const catalogEntry = assertQualificationIndex(
        await rawIndexInventory(conn),
        {
          indexName: FTS_INDEX_NAME,
          tableName: "DriverQualificationFts",
          propertyName: "searchText",
          type: "fts",
        },
      );
      const fts = await queryQualificationFts(conn);
      if (fts.resultCount < 1 || !fts.matchedProbeId) {
        throw new Error(
          "Qualification reopened FTS query did not return the known-token probe row",
        );
      }
      const dropped = await dropFtsIndex(
        conn,
        "DriverQualificationFts",
        FTS_INDEX_NAME,
      );
      if (dropped.status !== "dropped") {
        throw new Error(
          `Qualification FTS index drop failed: ${dropped.error ?? dropped.status}`,
        );
      }
      await execCheckpoint(conn);
      checkpointComplete = true;
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        fts: {
          ...fts,
          catalogPresent: true,
          catalogEntry,
          dropStatus: dropped.status,
        },
      };
    } else if (options.mode === "verify-fts-dropped") {
      assertQualificationIndexAbsent(
        await rawIndexInventory(conn),
        FTS_INDEX_NAME,
        "fts",
      );
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        fts: { catalogAbsent: true },
      };
    } else if (options.mode === "validate-full-delete-range") {
      const pointLookups = await validatePointLookups(conn, options.mode);
      const scan = await validateProjectedScan(conn, options.mode);
      await exec(
        conn,
        `MATCH (p:DriverQualificationProbe)
         WHERE p.sortKey >= $start AND p.sortKey < $rangeEnd
         DELETE p`,
        { start: DELETE_START, rangeEnd: DELETE_END },
      );
      phaseResult = {
        phase: options.mode,
        ...scan,
        afterRowCount: await countProbeRows(conn),
        pointLookups,
      };
    } else if (options.mode === "validate-deleted-reinsert-range") {
      const pointLookups = await validatePointLookups(conn, options.mode);
      const scan = await validateProjectedScan(conn, options.mode);
      await insertProbeRange(conn, DELETE_START, DELETE_END);
      phaseResult = {
        phase: options.mode,
        ...scan,
        afterRowCount: await countProbeRows(conn),
        pointLookups,
      };
    } else if (options.mode === "validate-restored-delete-all") {
      const pointLookups = await validatePointLookups(conn, options.mode);
      const scan = await validateProjectedScan(conn, options.mode);
      await exec(conn, "MATCH (p:DriverQualificationProbe) DELETE p");
      phaseResult = {
        phase: options.mode,
        ...scan,
        afterRowCount: await countProbeRows(conn),
        pointLookups,
      };
    } else if (options.mode === "validate-empty") {
      const pointLookups = await validatePointLookups(conn, options.mode);
      const scan = await validateProjectedScan(conn, options.mode);
      phaseResult = {
        phase: options.mode,
        ...scan,
        pointLookups,
      };
    } else if (options.mode === "validate-upstream-projection") {
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        ...(await validateUpstreamProjection(conn)),
      };
    } else if (options.mode === "seed-node-string-segments") {
      await execDdl(
        conn,
        `CREATE NODE TABLE IF NOT EXISTS DriverQualificationNodeString (
          id INT64,
          txt STRING,
          PRIMARY KEY(id)
        )`,
      );
      for (let batch = 0; batch < 4; batch += 1) {
        const batchStart = batch * NODE_STRING_BATCH_ROWS;
        const csvPath = join(
          dirname(options.clonePath),
          `node-string-segment-${batch}.csv`,
        );
        const csv = Array.from(
          { length: NODE_STRING_BATCH_ROWS },
          (_, offset) => {
            const id = batchStart + offset;
            return `${id},${nodeStringValue(id)}`;
          },
        ).join("\n");
        writeFileSync(csvPath, `${csv}\n`, "utf8");
        await execDdl(
          conn,
          `COPY DriverQualificationNodeString FROM '${normalizePath(csvPath).replaceAll("'", "''")}' (HEADER=false)`,
        );
        await execCheckpoint(conn);
      }
      await exec(
        conn,
        `MATCH (n:DriverQualificationNodeString)
         WHERE n.id >= $start AND n.id < $rangeEnd
         DETACH DELETE n`,
        {
          start: NODE_STRING_DELETE_START,
          rangeEnd: NODE_STRING_DELETE_END,
        },
      );
      await execCheckpoint(conn);
      checkpointComplete = true;
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        nodeStringRowCount: await countNodeStringRows(conn),
      };
    } else if (options.mode === "validate-node-string-segment-scan") {
      phaseResult = {
        phase: options.mode,
        rowCount: await countProbeRows(conn),
        nodeStringRowCount: await countNodeStringRows(conn),
        ...(await validateNodeStringSegmentScan(conn)),
      };
    } else {
      throw new Error(`Unknown qualification child mode: ${options.mode}`);
    }

    if (!checkpointComplete) await execCheckpoint(conn);
    const after = await validateOriginalGraph(conn, config);
    if (graphIdentity(before) !== graphIdentity(after)) {
      throw new Error(
        "Original graph manifest or index catalog changed across qualification probe mutation",
      );
    }
    return {
      ...phaseResult,
      projectionRowCount: await countUpstreamProjectionRows(conn),
      ...after,
    };
  } catch (cause) {
    phaseFailure = cause;
    throw cause;
  } finally {
    if (opened) {
      await closeQualificationPhaseStrictly(
        () => closeLadybugDb({ strict: true }),
        phaseFailure,
      );
    }
  }
  } finally {
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfigPath;
    rmSync(verifiedConfigPath, { force: true });
  }
}

function formatQualificationFailure(error) {
  const primary = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AggregateError)) return primary;
  const components = error.errors.map(
    (component, index) =>
      "[component " +
      (index + 1) +
      "] " +
      (component instanceof Error ? component.message : String(component)),
  );
  return [primary, ...components].join("\n");
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
    })
      .then((receipt) => {
        process.stdout.write(
          `${CHILD_RESULT_PREFIX}${JSON.stringify(receipt)}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `[sdl-mcp] Ladybug qualification child failed: ${formatQualificationFailure(error)}\n`,
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
