import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { normalizePath } from "../util/paths.js";
import {
  fingerprintLadybugFamily,
  inventoryLadybugFamilyIdentities,
  readBoundedLadybugConfigFile,
  readBoundedLadybugControlFile,
  type LadybugFamilyFingerprint,
} from "./ladybug-family-files.js";
import {
  createOpaqueLadybugAuthorityIssuer,
  type OpaqueLadybugAuthority,
} from "./ladybug-opaque-authority.js";

export const QUALIFICATION_AUTHORITY_FILENAME =
  ".qualification-authority.json";
export const QUALIFICATION_AUTHORITY_NONCE_ENV =
  "SDL_LADYBUG_QUALIFICATION_AUTHORITY_NONCE";
export const QUALIFICATION_AUTHORITY_PATH_ENV =
  "SDL_LADYBUG_QUALIFICATION_AUTHORITY_PATH";
export const QUALIFICATION_AUTHORITY_VERSION = 1;
const QUALIFICATION_ROOT_PREFIX = "sdl-ladybug-qualification-";
export const QUALIFICATION_PHASE_NAMES = [
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
] as const;
const QUALIFICATION_PHASES = new Set<string>(QUALIFICATION_PHASE_NAMES);

export interface QualificationFamilyMemberAuthority {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface QualificationFamilyAuthority {
  readonly role: string;
  readonly primaryPath: string;
  readonly members: readonly QualificationFamilyMemberAuthority[];
  readonly fingerprint?: LadybugFamilyFingerprint;
}

export interface QualificationLadybugCloneAuthority {
  readonly version: 1;
  readonly phase: string;
  readonly clonePath: string;
  readonly cloneFamily: QualificationFamilyAuthority;
  readonly forbiddenFamilies: readonly QualificationFamilyAuthority[];
}

export type QualificationLadybugCloneCapability =
  OpaqueLadybugAuthority<"qualification-clone">;

export interface QualificationChildAuthorityOptions {
  readonly mode: string;
  readonly clonePath: string;
  readonly configPath: string;
}

export interface QualificationChildAuthorization {
  readonly dbCapability: QualificationLadybugCloneCapability;
  readonly verifiedConfigBytes: Buffer;
}

const qualificationLadybugCloneAuthorities =
  createOpaqueLadybugAuthorityIssuer<
    QualificationLadybugCloneAuthority,
    "qualification-clone"
  >("Qualification authority is invalid or already consumed");

function invalidQualificationAuthority(message: string): never {
  throw new Error("Invalid qualification authority: " + message);
}

function canonicalizePath(value: string): string {
  const absolutePath = resolve(value);
  const canonicalPath = existsSync(absolutePath)
    ? realpathSync.native(absolutePath)
    : absolutePath;
  return normalizePath(
    process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath,
  );
}

export function buildQualificationFamilyAuthority(
  role: string,
  primaryPath: string,
): QualificationFamilyAuthority {
  const primary = canonicalizePath(primaryPath);
  const identities = inventoryLadybugFamilyIdentities(primaryPath);
  if (role === "active") {
    const primaryIdentity = identities.find(
      (member) => member.path === primary,
    );
    if (!primaryIdentity) {
      throw new Error(
        "Active database family primary file is missing: " + primaryPath,
      );
    }
    return {
      role,
      primaryPath: primary,
      members: [
        {
          path: primaryIdentity.path,
          device: primaryIdentity.dev,
          inode: primaryIdentity.ino,
        },
      ],
    };
  }
  return {
    role,
    primaryPath: primary,
    members: identities.map(({ path, dev, ino }) => ({
      path,
      device: dev,
      inode: ino,
    })),
    fingerprint: fingerprintLadybugFamily(primaryPath),
  };
}

function isFamilyAuthority(
  value: unknown,
): value is QualificationFamilyAuthority {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Partial<QualificationFamilyAuthority>).role === "string" &&
    typeof (value as Partial<QualificationFamilyAuthority>).primaryPath ===
      "string" &&
    Array.isArray(
      (value as Partial<QualificationFamilyAuthority>).members,
    )
  );
}

function readQualificationMarker(path: string): Record<string, unknown> {
  let bytes: Buffer;
  try {
    bytes = readBoundedLadybugControlFile(path, "qualification authority");
  } catch (error) {
    invalidQualificationAuthority(
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("marker must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    invalidQualificationAuthority(
      "marker is not valid JSON: " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

export function consumeQualificationChildAuthority(
  options: QualificationChildAuthorityOptions,
  env: NodeJS.ProcessEnv = process.env,
): QualificationChildAuthorization {
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

  const marker = readQualificationMarker(authorityPath);
  const markerNonce = marker.nonce;
  if (
    !/^[0-9a-f]{64}$/u.test(nonce) ||
    typeof markerNonce !== "string" ||
    !/^[0-9a-f]{64}$/u.test(markerNonce) ||
    !timingSafeEqual(
      Buffer.from(nonce, "hex"),
      Buffer.from(markerNonce, "hex"),
    )
  ) {
    invalidQualificationAuthority("authority nonce does not match");
  }

  const phase = marker.phase;
  if (
    marker.version !== QUALIFICATION_AUTHORITY_VERSION ||
    typeof phase !== "string" ||
    phase !== options.mode ||
    !QUALIFICATION_PHASES.has(phase) ||
    marker.cloneRootPath !== cloneRootPath ||
    marker.clonePath !== clonePath ||
    marker.configPath !== canonicalizePath(options.configPath)
  ) {
    invalidQualificationAuthority("phase or canonical paths do not match");
  }

  const verifiedConfigBytes = readBoundedLadybugConfigFile(
    options.configPath,
    "qualification config",
  );
  if (
    marker.configSha256 !==
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

  const markerCloneFamily = marker.cloneFamily;
  const markerForbiddenFamilies = marker.forbiddenFamilies;
  if (
    !isFamilyAuthority(markerCloneFamily) ||
    !Array.isArray(markerForbiddenFamilies) ||
    markerForbiddenFamilies.length < 1 ||
    markerForbiddenFamilies[0] === null ||
    typeof markerForbiddenFamilies[0] !== "object" ||
    (markerForbiddenFamilies[0] as { role?: unknown }).role !== "source" ||
    markerForbiddenFamilies
      .slice(1)
      .some(
        (family) =>
          family === null ||
          typeof family !== "object" ||
          (family as { role?: unknown }).role !== "active",
      )
  ) {
    invalidQualificationAuthority("forbidden database families are invalid");
  }

  const forbiddenPaths = new Set<string>();
  const forbiddenIdentities = new Set<string>();
  const forbiddenFamilies: QualificationFamilyAuthority[] = [];
  for (const family of markerForbiddenFamilies) {
    if (!isFamilyAuthority(family)) {
      invalidQualificationAuthority(
        "forbidden database family is malformed",
      );
    }
    const current = buildQualificationFamilyAuthority(
      family.role === "active" ? "active" : "source",
      family.primaryPath,
    );
    if (JSON.stringify(current) !== JSON.stringify(family)) {
      invalidQualificationAuthority(
        "forbidden database family path or identity changed",
      );
    }
    forbiddenFamilies.push(current);
    forbiddenPaths.add(current.primaryPath);
    const currentMembers = inventoryLadybugFamilyIdentities(
      family.primaryPath,
    );
    for (const member of currentMembers) {
      forbiddenPaths.add(member.path);
      forbiddenIdentities.add(member.dev + ":" + member.ino);
    }
  }

  const cloneFamily = buildQualificationFamilyAuthority(
    "clone",
    options.clonePath,
  );
  if (
    JSON.stringify(cloneFamily) !== JSON.stringify(markerCloneFamily) ||
    cloneFamily.members.length < 1 ||
    forbiddenPaths.has(cloneFamily.primaryPath) ||
    cloneFamily.members.some(
      (member) =>
        forbiddenPaths.has(member.path) ||
        forbiddenIdentities.has(member.device + ":" + member.inode),
    )
  ) {
    invalidQualificationAuthority(
      "clone aliases a forbidden database family",
    );
  }

  // Delete the one-use nonce marker before minting the in-process capability.
  rmSync(authorityPath);
  return {
    dbCapability: qualificationLadybugCloneAuthorities.issue({
      version: QUALIFICATION_AUTHORITY_VERSION,
      phase,
      clonePath,
      cloneFamily,
      forbiddenFamilies,
    }),
    verifiedConfigBytes,
  };
}

export function consumeQualificationLadybugCloneAuthority(
  capability: unknown,
): Readonly<QualificationLadybugCloneAuthority> {
  return qualificationLadybugCloneAuthorities.consume(capability);
}
