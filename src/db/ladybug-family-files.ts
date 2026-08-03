import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { normalizePath } from "../util/paths.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";
import {
  createOpaqueLadybugAuthorityIssuer,
  type OpaqueLadybugAuthority,
} from "./ladybug-authority.js";

export const MAX_LADYBUG_CONTROL_BYTES = 16 * 1024;
export const MAX_LADYBUG_QUALIFICATION_CONFIG_BYTES = 10 * 1024 * 1024;
const MAX_FAMILY_MEMBERS = 32;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface LadybugFamilyFileFingerprint {
  path: string;
  size: number;
  sha256: string;
}

export interface LadybugFamilyFingerprint {
  files: LadybugFamilyFileFingerprint[];
  sha256: string;
}

export interface LadybugFileIdentity {
  dev: string;
  ino: string;
}

export interface LadybugFamilyMemberIdentity extends LadybugFileIdentity {
  path: string;
}

interface VerifiedLadybugFamilyCopyState {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceFingerprint: LadybugFamilyFingerprint;
  readonly destinationFingerprint: LadybugFamilyFingerprint;
  readonly sourceMembers: readonly LadybugFamilyMemberIdentity[];
  readonly destinationMembers: readonly LadybugFamilyMemberIdentity[];
}

export type VerifiedLadybugFamilyCopy =
  OpaqueLadybugAuthority<"validated-copy">;

export interface LadybugFamilyCopyEvidence {
  readonly sourceFingerprint: LadybugFamilyFingerprint;
  readonly destinationFingerprint: LadybugFamilyFingerprint;
}

const verifiedLadybugFamilyCopies = createOpaqueLadybugAuthorityIssuer<
  VerifiedLadybugFamilyCopyState,
  "validated-copy"
>("Validated LadybugDB copy capability is invalid or already consumed");

function primaryPath(path: string): string {
  return normalizePath(normalizeGraphDbPath(path));
}

function identity(stat: { dev: bigint | number; ino: bigint | number }): LadybugFileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

export function canonicalLadybugPath(path: string): string {
  const value = realpathSync.native(path);
  return normalizePath(process.platform === "win32" ? value.toLowerCase() : value);
}

export function ladybugFileIdentity(path: string): LadybugFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("LadybugDB family member must be a regular non-symlink file: " + path);
  }
  return identity(stat);
}

export function withStableLadybugRegularFile<T>(
  path: string,
  label: string,
  body: (descriptor: number, opened: ReturnType<typeof fstatSync>) => T,
): T {
  const pathBefore = lstatSync(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error(label + " must be a regular non-symlink file");
  }
  const beforeIdentity = identity(pathBefore);

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error(label + " must be a regular non-symlink file");
      }
    } catch (classificationError) {
      if (
        classificationError instanceof Error &&
        /regular non-symlink file/u.test(classificationError.message)
      ) {
        throw classificationError;
      }
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      JSON.stringify(identity(opened)) !== JSON.stringify(beforeIdentity)
    ) {
      throw new Error(label + " changed while being opened");
    }
    const openedIdentity = identity(opened);
    const pathStat = lstatSync(path, { bigint: true });
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error(label + " must be a regular non-symlink file");
    }
    if (JSON.stringify(identity(pathStat)) !== JSON.stringify(openedIdentity)) {
      throw new Error(label + " changed while being opened");
    }
    const result = body(descriptor, opened);
    const afterOpen = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      JSON.stringify(identity(afterOpen)) !== JSON.stringify(openedIdentity) ||
      afterOpen.size !== opened.size ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      JSON.stringify(identity(afterPath)) !== JSON.stringify(openedIdentity)
    ) {
      throw new Error(label + " changed while being read");
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedLadybugControlFile(
  path: string,
  label: string,
  maxBytes = MAX_LADYBUG_CONTROL_BYTES,
): Buffer {
  return withStableLadybugRegularFile(path, label, (descriptor, stat) => {
    if (stat.size > BigInt(maxBytes)) {
      throw new Error(label + " exceeds " + maxBytes + " bytes");
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) {
      throw new Error(label + " exceeds " + maxBytes + " bytes");
    }
    return buffer.subarray(0, total);
  });
}

export function readBoundedLadybugConfigFile(
  path: string,
  label: string,
): Buffer {
  return readBoundedLadybugControlFile(
    path,
    label,
    MAX_LADYBUG_QUALIFICATION_CONFIG_BYTES,
  );
}

export function collectLadybugFamilyFiles(path: string): string[] {
  const normalized = primaryPath(path);
  const directory = dirname(normalized);
  const primary = basename(normalized);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory)
    .filter((name) => name === primary || name.startsWith(primary + "."))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (names.length > MAX_FAMILY_MEMBERS) {
    throw new Error("LadybugDB family exceeds " + MAX_FAMILY_MEMBERS + " members");
  }
  return names.map((name) => join(directory, name));
}

export function assertLadybugFamilyAbsent(path: string): void {
  const files = collectLadybugFamilyFiles(path);
  if (files.length > 0) {
    throw new Error("LadybugDB family must be absent: " + files.join(", "));
  }
}

function hashFamilyFile(path: string): LadybugFamilyFileFingerprint {
  return withStableLadybugRegularFile(
    path,
    "LadybugDB family member",
    (descriptor, stat) => {
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("LadybugDB family member is too large to inventory");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let size = 0;
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        size += count;
      }
      if (size !== Number(stat.size)) {
        throw new Error("LadybugDB family member changed while hashing");
      }
      return { path: basename(path), size, sha256: hash.digest("hex") };
    },
  );
}

export function fingerprintLadybugFamily(
  path: string,
  options: { exclude?: readonly string[] } = {},
): LadybugFamilyFingerprint {
  const excluded = new Set(options.exclude ?? []);
  const files = collectLadybugFamilyFiles(path)
    .filter((member) => !excluded.has(basename(member)))
    .map(hashFamilyFile);
  return {
    files,
    sha256: createHash("sha256")
      .update(JSON.stringify(files), "utf8")
      .digest("hex"),
  };
}

export function ladybugFamilyFingerprintsEqual(
  left: LadybugFamilyFingerprint,
  right: LadybugFamilyFingerprint,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function inventoryLadybugFamilyIdentities(
  path: string,
  options: { exclude?: readonly string[] } = {},
): LadybugFamilyMemberIdentity[] {
  const excluded = new Set(options.exclude ?? []);
  return collectLadybugFamilyFiles(path)
    .filter((member) => !excluded.has(basename(member)))
    .map((member) => ({
      path: canonicalLadybugPath(member),
      ...ladybugFileIdentity(member),
    }));
}

function mappedFingerprint(
  source: LadybugFamilyFingerprint,
  sourceName: string,
  destinationName: string,
): LadybugFamilyFingerprint {
  const files = source.files.map((file) => {
    if (file.path !== sourceName && !file.path.startsWith(sourceName + ".")) {
      throw new Error("Invalid LadybugDB family member: " + file.path);
    }
    return {
      ...file,
      path: destinationName + file.path.slice(sourceName.length),
    };
  });
  return {
    files,
    sha256: createHash("sha256")
      .update(JSON.stringify(files), "utf8")
      .digest("hex"),
  };
}

function copyVerified(
  sourcePath: string,
  destinationPath: string,
): VerifiedLadybugFamilyCopyState {
  const source = primaryPath(sourcePath);
  const destination = primaryPath(destinationPath);
  const sourceName = basename(source);
  const destinationName = basename(destination);
  assertLadybugFamilyAbsent(destination);
  mkdirSync(dirname(destination), { recursive: true });
  const destinationCanonical = normalizePath(
    join(realpathSync.native(dirname(destination)), destinationName),
  );
  if (
    canonicalLadybugPath(source) ===
    (process.platform === "win32" ? destinationCanonical.toLowerCase() : destinationCanonical)
  ) {
    throw new Error("Verified LadybugDB copy requires distinct source and destination paths");
  }

  const sourceFingerprint = fingerprintLadybugFamily(source);
  if (!sourceFingerprint.files.some((file) => file.path === sourceName)) {
    throw new Error("LadybugDB family primary file is missing: " + source);
  }
  const sourceMembers = inventoryLadybugFamilyIdentities(source);
  for (const sourceMember of collectLadybugFamilyFiles(source)) {
    const sourceMemberName = basename(sourceMember);
    const destinationMember = join(
      dirname(destination),
      destinationName + sourceMemberName.slice(sourceName.length),
    );
    copyFileSync(sourceMember, destinationMember, constants.COPYFILE_EXCL);
  }

  const sourceAfter = fingerprintLadybugFamily(source);
  if (!ladybugFamilyFingerprintsEqual(sourceAfter, sourceFingerprint)) {
    throw new Error("LadybugDB family changed during copy");
  }
  const destinationFingerprint = fingerprintLadybugFamily(destination);
  if (
    !ladybugFamilyFingerprintsEqual(
      destinationFingerprint,
      mappedFingerprint(sourceFingerprint, sourceName, destinationName),
    )
  ) {
    throw new Error("Copied LadybugDB family fingerprint mismatch");
  }
  const destinationMembers = inventoryLadybugFamilyIdentities(destination);
  const sourceIdentities = new Set(sourceMembers.map((member) => member.dev + ":" + member.ino));
  if (
    destinationMembers.some((member) =>
      sourceIdentities.has(member.dev + ":" + member.ino),
    )
  ) {
    throw new Error("Copied LadybugDB family reuses a source file identity");
  }
  return {
    sourcePath: canonicalLadybugPath(source),
    destinationPath: canonicalLadybugPath(destination),
    sourceFingerprint,
    destinationFingerprint,
    sourceMembers,
    destinationMembers,
  };
}

export function copyLadybugFamilyVerified(
  sourcePath: string,
  destinationPath: string,
): LadybugFamilyCopyEvidence {
  const copied = copyVerified(sourcePath, destinationPath);
  return {
    sourceFingerprint: copied.sourceFingerprint,
    destinationFingerprint: copied.destinationFingerprint,
  };
}

export function copyLadybugFamilyForValidatedClone(
  sourcePath: string,
  destinationPath: string,
): VerifiedLadybugFamilyCopy {
  return verifiedLadybugFamilyCopies.issue(
    copyVerified(sourcePath, destinationPath),
  );
}

export function consumeVerifiedLadybugFamilyCopy(
  capability: VerifiedLadybugFamilyCopy,
  destinationPath: string,
): void {
  const state = verifiedLadybugFamilyCopies.consume(capability);
  const destination = primaryPath(destinationPath);
  if (state.destinationPath !== canonicalLadybugPath(destination)) {
    throw new Error("Validated LadybugDB copy destination changed");
  }
  const sourceFingerprint = fingerprintLadybugFamily(state.sourcePath, {
    exclude: [basename(state.sourcePath) + ".sdl-family.lock"],
  });
  const destinationFingerprint = fingerprintLadybugFamily(destination, {
    exclude: [basename(destination) + ".sdl-family.lock"],
  });
  if (
    !ladybugFamilyFingerprintsEqual(
      sourceFingerprint,
      state.sourceFingerprint,
    ) ||
    !ladybugFamilyFingerprintsEqual(
      destinationFingerprint,
      state.destinationFingerprint,
    )
  ) {
    throw new Error("Validated LadybugDB copy bytes changed before open");
  }
  const sourceMembers = inventoryLadybugFamilyIdentities(state.sourcePath, {
    exclude: [basename(state.sourcePath) + ".sdl-family.lock"],
  });
  const destinationMembers = inventoryLadybugFamilyIdentities(destination, {
    exclude: [basename(destination) + ".sdl-family.lock"],
  });
  if (
    JSON.stringify(sourceMembers) !== JSON.stringify(state.sourceMembers) ||
    JSON.stringify(destinationMembers) !==
      JSON.stringify(state.destinationMembers)
  ) {
    throw new Error("Validated LadybugDB copy identities changed before open");
  }
  const sourceIdentities = new Set(sourceMembers.map((member) => member.dev + ":" + member.ino));
  if (
    destinationMembers.some((member) =>
      sourceIdentities.has(member.dev + ":" + member.ino),
    )
  ) {
    throw new Error("Validated LadybugDB copy aliases its source family");
  }
}
