import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { DatabaseError } from "../domain/errors.js";
import { isProcessAlive } from "../util/pidfile.js";
import { normalizePath } from "../util/paths.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";

const RECEIPT_KIND = "sdl-mcp-ladybug-ready";
const RECEIPT_VERSION = 2;
const MARKER_SUFFIX = ".sdl-lineage.json";
const LOCK_SUFFIX = ".sdl-family.lock";
const MAX_CONTROL_BYTES = 16 * 1024;
const MAX_FAMILY_MEMBERS = 32;
const HASH_BUFFER_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const LEASE = Symbol("LadybugFamilyLease");

export interface LadybugLineageDriver {
  version: string;
  storageVersion: string;
}

export interface LadybugFamilyFileFingerprint {
  path: string;
  size?: number;
  sha256: string;
}

export interface LadybugFamilyFingerprint {
  files: LadybugFamilyFileFingerprint[];
  sha256: string;
}

interface FileIdentity {
  dev: string;
  ino: string;
}

interface FamilySnapshot {
  canonicalDbPath: string;
  primaryFile: FileIdentity;
  family: LadybugFamilyFingerprint;
}

interface FamilyMemberAuthority {
  path: string;
  device: string;
  inode: string;
}

export interface QualificationFamilyAuthority {
  role: string;
  primaryPath: string;
  members: FamilyMemberAuthority[];
  fingerprint: LadybugFamilyFingerprint;
}

export interface QualificationLadybugCloneAuthority {
  version: 1;
  phase: string;
  clonePath: string;
  cloneFamily: QualificationFamilyAuthority;
  forbiddenFamilies: QualificationFamilyAuthority[];
}

export interface ValidatedLadybugCloneAuthority {
  authorityKind: "validated-ladybug-clone";
  canonicalDbPath: string;
  primaryFile: FileIdentity;
  family: LadybugFamilyFingerprint;
}

export interface LadybugFamilyLease {
  readonly [LEASE]: true;
  readonly dbPath: string;
  readonly driver: LadybugLineageDriver;
  readonly mode: "normal" | "safe-rebuild" | "qualification" | "validated-clone";
  readonly lockPath: string;
  readonly lockNonce: string;
  readonly lockIdentity: FileIdentity;
  lockDescriptor: number | null;
  released: boolean;
  safeRebuildSnapshot?: FamilySnapshot;
}

function dbPath(path: string): string {
  return normalizePath(normalizeGraphDbPath(path));
}

function canonical(path: string): string {
  return normalizePath(realpathSync.native(path));
}

function qualificationCanonical(path: string): string {
  const value = realpathSync.native(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function identity(stat: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function pathIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw lineageError(path, "database family member is not a regular file");
  }
  return identity(stat);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lineageError(path: string, reason: string): DatabaseError {
  return new DatabaseError(
    "Refusing to open LadybugDB at " +
      dbPath(path) +
      " because its " +
      reason +
      ". Preserve the existing database family and build a fresh candidate with: " +
      "sdl-mcp index --force --safe-rebuild <absolute-new-path>.",
  );
}

function familyNames(path: string): string[] {
  const normalized = dbPath(path);
  const directory = dirname(normalized);
  const primary = basename(normalized);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name === primary || name.startsWith(primary + "."))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function withStableRegularFile<T>(
  path: string,
  label: string,
  body: (
    descriptor: number,
    opened: ReturnType<typeof fstatSync>,
  ) => T,
): T {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(label + " must be a regular non-symlink file");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(label + " changed while being opened");
    }
    const result = body(descriptor, opened);
    const afterOpen = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      afterOpen.dev !== opened.dev ||
      afterOpen.ino !== opened.ino ||
      afterOpen.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw new Error(label + " changed while being read");
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function readBounded(path: string, label: string): Buffer {
  return withStableRegularFile(path, label, (descriptor, stat) => {
    if (stat.size > BigInt(MAX_CONTROL_BYTES)) {
      throw new Error(label + " exceeds " + MAX_CONTROL_BYTES + " bytes");
    }
    const buffer = Buffer.allocUnsafe(MAX_CONTROL_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_CONTROL_BYTES) {
      throw new Error(label + " exceeds " + MAX_CONTROL_BYTES + " bytes");
    }
    return buffer.subarray(0, total);
  });
}

function hashFile(path: string): LadybugFamilyFileFingerprint {
  return withStableRegularFile(path, "database family member", (descriptor, stat) => {
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("database family member is too large to inventory");
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
      throw new Error("database family member changed while hashing");
    }
    return { path: basename(path), size, sha256: hash.digest("hex") };
  });
}

function fingerprint(paths: readonly string[]): LadybugFamilyFingerprint {
  if (paths.length > MAX_FAMILY_MEMBERS) {
    throw new Error(
      "database family exceeds " + MAX_FAMILY_MEMBERS + " members",
    );
  }
  const files = paths.map(hashFile);
  return {
    files,
    sha256: createHash("sha256")
      .update(JSON.stringify(files), "utf8")
      .digest("hex"),
  };
}

function closedSnapshot(path: string): FamilySnapshot {
  const normalized = dbPath(path);
  const primary = basename(normalized);
  const allowed = new Set([primary, primary + ".wal"]);
  const metadata = new Set([
    primary + MARKER_SUFFIX,
    primary + LOCK_SUFFIX,
  ]);
  const names = familyNames(normalized);
  const unexpected = names.find(
    (name) => !allowed.has(name) && !metadata.has(name),
  );
  if (unexpected) {
    throw lineageError(
      normalized,
      "database family contains unexpected member " + unexpected,
    );
  }
  if (!names.includes(primary)) {
    throw lineageError(normalized, "primary database file is missing");
  }
  return {
    canonicalDbPath: canonical(normalized),
    primaryFile: pathIdentity(normalized),
    family: fingerprint(
      names
        .filter((name) => allowed.has(name))
        .map((name) => join(dirname(normalized), name)),
    ),
  };
}

function broadFingerprint(path: string): LadybugFamilyFingerprint {
  const normalized = dbPath(path);
  const lockName = basename(normalized) + LOCK_SUFFIX;
  return fingerprint(
    familyNames(normalized)
      .filter((name) => name !== lockName)
      .map((name) => join(dirname(normalized), name)),
  );
}

function validateFingerprint(
  path: string,
  value: LadybugFamilyFingerprint,
): void {
  if (
    !value ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > MAX_FAMILY_MEMBERS ||
    !SHA256.test(value.sha256) ||
    value.files.some(
      (file) =>
        !file ||
        basename(file.path) !== file.path ||
        !SHA256.test(file.sha256) ||
        (file.size !== undefined &&
          (!Number.isSafeInteger(file.size) || file.size < 0)),
    )
  ) {
    throw lineageError(path, "verified copy fingerprint is invalid");
  }
}

function fingerprintMatches(
  actual: LadybugFamilyFingerprint,
  expected: LadybugFamilyFingerprint,
): boolean {
  return (
    actual.files.length === expected.files.length &&
    expected.files.every((file, index) => {
      const candidate = actual.files[index];
      return (
        candidate?.path === file.path &&
        candidate.sha256 === file.sha256 &&
        (file.size === undefined || candidate.size === file.size)
      );
    })
  );
}

function verifyCopy(path: string, expected: LadybugFamilyFingerprint): void {
  validateFingerprint(path, expected);
  if (!fingerprintMatches(broadFingerprint(path), expected)) {
    throw lineageError(path, "verified copy fingerprint mismatch");
  }
}

function assertFresh(path: string): void {
  const normalized = dbPath(path);
  const lockName = basename(normalized) + LOCK_SUFFIX;
  const existing = familyNames(normalized).filter((name) => name !== lockName);
  if (existing.length > 0) {
    throw lineageError(
      normalized,
      "database family is not fresh; existing members: " + existing.join(", "),
    );
  }
}

function readLock(path: string, db: string): {
  pid: number;
  nonce: string;
  identity: FileIdentity;
} {
  let value: unknown;
  try {
    value = JSON.parse(readBounded(path, "family lock").toString("utf8"));
  } catch (error) {
    throw lineageError(
      db,
      "family lock is invalid: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const record = value as Record<string, unknown>;
  if (
    !record ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    typeof record.nonce !== "string" ||
    !SHA256.test(record.nonce)
  ) {
    throw lineageError(db, "family lock is malformed");
  }
  return {
    pid: Number(record.pid),
    nonce: record.nonce,
    identity: pathIdentity(path),
  };
}

function newLease(
  path: string,
  driver: LadybugLineageDriver,
  mode: LadybugFamilyLease["mode"],
): LadybugFamilyLease {
  const normalized = dbPath(path);
  const lockPath = getLadybugFamilyLockPath(normalized);
  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = createHash("sha256").update(randomUUID()).digest("hex");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        JSON.stringify({ version: 1, pid: process.pid, nonce }) + "\n",
      );
      fsyncSync(descriptor);
      return {
        [LEASE]: true,
        dbPath: normalized,
        driver: { ...driver },
        mode,
        lockPath,
        lockNonce: nonce,
        lockIdentity: identity(fstatSync(descriptor, { bigint: true })),
        lockDescriptor: descriptor,
        released: false,
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readLock(lockPath, normalized);
      if (isProcessAlive(owner.pid)) {
        throw lineageError(
          normalized,
          "family lock is owned by active SDL-MCP process PID " + owner.pid,
        );
      }
      if (!same(owner.identity, pathIdentity(lockPath))) {
        throw lineageError(
          normalized,
          "family lock changed during stale-owner recovery",
        );
      }
      unlinkSync(lockPath);
    }
  }
  throw lineageError(normalized, "family lock could not be acquired");
}

function requireLease(
  lease: LadybugFamilyLease,
  mode?: LadybugFamilyLease["mode"],
): void {
  if (
    !lease ||
    lease[LEASE] !== true ||
    lease.released ||
    lease.lockDescriptor === null ||
    (mode !== undefined && lease.mode !== mode)
  ) {
    throw new DatabaseError("Invalid or released LadybugDB family lease");
  }
  const owner = readLock(lease.lockPath, lease.dbPath);
  if (
    owner.pid !== process.pid ||
    owner.nonce !== lease.lockNonce ||
    !same(owner.identity, lease.lockIdentity)
  ) {
    throw lineageError(lease.dbPath, "family lock ownership changed");
  }
}

function release(lease: LadybugFamilyLease): void {
  if (lease.released) return;
  requireLease(lease);
  closeSync(lease.lockDescriptor!);
  lease.lockDescriptor = null;
  if (!same(pathIdentity(lease.lockPath), lease.lockIdentity)) {
    lease.released = true;
    throw lineageError(lease.dbPath, "family lock changed before release");
  }
  unlinkSync(lease.lockPath);
  lease.released = true;
}

function reservePrimary(lease: LadybugFamilyLease): void {
  requireLease(lease);
  assertFresh(lease.dbPath);
  try {
    closeSync(openSync(lease.dbPath, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw lineageError(
        lease.dbPath,
        "primary database appeared during fresh initialization",
      );
    }
    throw error;
  }
  const remaining = familyNames(lease.dbPath).filter(
    (name) => name !== basename(lease.lockPath),
  );
  if (!same(remaining, [basename(lease.dbPath)])) {
    throw lineageError(
      lease.dbPath,
      "database family changed after primary reservation",
    );
  }
}

function readReceipt(path: string): Record<string, unknown> {
  const marker = getLadybugLineageMarkerPath(path);
  if (!existsSync(marker)) throw lineageError(path, "lineage marker is missing");
  let bytes: Buffer;
  try {
    bytes = readBounded(marker, "lineage marker");
  } catch (error) {
    throw lineageError(
      path,
      error instanceof Error ? error.message : "lineage marker is malformed",
    );
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw lineageError(path, "lineage marker is malformed");
  }
}

function verifyReceipt(path: string, driver: LadybugLineageDriver): void {
  const receipt = readReceipt(path);
  if (receipt.receiptKind !== RECEIPT_KIND) {
    throw lineageError(path, "receipt kind mismatch");
  }
  if (receipt.receiptVersion !== RECEIPT_VERSION) {
    throw lineageError(path, "receipt version mismatch");
  }
  if (receipt.canonicalDbPath !== canonical(path)) {
    throw lineageError(path, "canonical path mismatch");
  }
  if (!same(receipt.primaryFile, pathIdentity(path))) {
    throw lineageError(path, "primary file identity mismatch");
  }
  if (receipt.driverVersion !== driver.version) {
    throw lineageError(path, "driver version mismatch");
  }
  if (receipt.storageVersion !== driver.storageVersion) {
    throw lineageError(path, "storage version mismatch");
  }
  const snapshot = closedSnapshot(path);
  if (!same(receipt.family, snapshot.family)) {
    throw lineageError(path, "closed family digest mismatch");
  }
}

function markerIsSafe(path: string): void {
  const marker = getLadybugLineageMarkerPath(path);
  if (!existsSync(marker)) return;
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw lineageError(
      path,
      "lineage marker must be a regular non-symlink file",
    );
  }
}

function syncParentBestEffort(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unsupported on some Windows filesystems.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function publish(
  lease: LadybugFamilyLease,
  expected: FamilySnapshot,
  changedReason: string,
): void {
  requireLease(lease);
  markerIsSafe(lease.dbPath);
  const marker = getLadybugLineageMarkerPath(lease.dbPath);
  const temporary = join(
    dirname(marker),
    ".sdl-lineage-" + process.pid + "-" + randomUUID() + ".tmp",
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({
        receiptKind: RECEIPT_KIND,
        receiptVersion: RECEIPT_VERSION,
        canonicalDbPath: expected.canonicalDbPath,
        primaryFile: expected.primaryFile,
        driverVersion: lease.driver.version,
        storageVersion: lease.driver.storageVersion,
        family: expected.family,
      }) + "\n",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertUnchanged(lease.dbPath, expected, changedReason);
    markerIsSafe(lease.dbPath);
    renameSync(temporary, marker);
    syncParentBestEffort(marker);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertUnchanged(
  path: string,
  expected: FamilySnapshot,
  reason: string,
): void {
  try {
    if (same(closedSnapshot(path), expected)) return;
  } catch {
    // Normalize every replacement or sidecar race to the caller's boundary.
  }
  throw lineageError(path, reason);
}

function familyAuthority(
  role: string,
  primaryPath: string,
): QualificationFamilyAuthority {
  const normalized = dbPath(primaryPath);
  const lock = basename(normalized) + LOCK_SUFFIX;
  const paths = familyNames(normalized)
    .filter((name) => name !== lock)
    .map((name) => join(dirname(normalized), name));
  return {
    role,
    primaryPath: qualificationCanonical(normalized),
    members: paths.map((path) => {
      const value = pathIdentity(path);
      return {
        path: qualificationCanonical(path),
        device: value.dev,
        inode: value.ino,
      };
    }),
    fingerprint: fingerprint(paths),
  };
}

function verifyAuthorityFamily(
  db: string,
  expected: QualificationFamilyAuthority,
): void {
  validateFingerprint(db, expected.fingerprint);
  const actual = familyAuthority(expected.role, expected.primaryPath);
  if (
    actual.role !== expected.role ||
    actual.primaryPath !== expected.primaryPath ||
    !same(actual.members, expected.members) ||
    !fingerprintMatches(actual.fingerprint, expected.fingerprint)
  ) {
    throw lineageError(
      db,
      "qualification authority family identity or digest changed",
    );
  }
}

function removeCopiedMarker(path: string): void {
  const marker = getLadybugLineageMarkerPath(path);
  if (!existsSync(marker)) return;
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw lineageError(
      path,
      "copied lineage marker must be a regular non-symlink file",
    );
  }
  unlinkSync(marker);
}

function guardedAcquire<T extends LadybugFamilyLease>(
  lease: T,
  body: () => void,
): T {
  try {
    body();
    return lease;
  } catch (error) {
    try {
      release(lease);
    } catch {
      // Preserve the verification or reservation failure.
    }
    throw error;
  }
}

export function getLadybugLineageMarkerPath(path: string): string {
  return dbPath(path) + MARKER_SUFFIX;
}

export function getLadybugFamilyLockPath(path: string): string {
  return dbPath(path) + LOCK_SUFFIX;
}

export function acquireNormalLadybugFamily(
  path: string,
  driver: LadybugLineageDriver,
): LadybugFamilyLease {
  const normalized = dbPath(path);
  const existing = existsSync(normalized);
  if (!existing) assertFresh(normalized);
  const lease = newLease(normalized, driver, "normal");
  return guardedAcquire(lease, () => {
    if (existing) {
      if (!existsSync(normalized)) {
        throw lineageError(
          normalized,
          "primary database disappeared before lineage verification",
        );
      }
      verifyReceipt(normalized, driver);
    } else {
      reservePrimary(lease);
    }
  });
}

export function reserveSafeRebuildLadybugFamily(
  path: string,
  driver: LadybugLineageDriver,
): LadybugFamilyLease {
  const normalized = dbPath(path);
  assertFresh(normalized);
  const lease = newLease(normalized, driver, "safe-rebuild");
  return guardedAcquire(lease, () => reservePrimary(lease));
}

export function bindVerifiedLadybugClone(
  path: string,
  family: LadybugFamilyFingerprint,
): ValidatedLadybugCloneAuthority {
  const normalized = dbPath(path);
  verifyCopy(normalized, family);
  return {
    authorityKind: "validated-ladybug-clone",
    canonicalDbPath: canonical(normalized),
    primaryFile: pathIdentity(normalized),
    family,
  };
}

export function acquireValidatedLadybugCloneFamily(
  path: string,
  authority: ValidatedLadybugCloneAuthority,
  driver: LadybugLineageDriver,
): LadybugFamilyLease {
  const normalized = dbPath(path);
  const lease = newLease(normalized, driver, "validated-clone");
  return guardedAcquire(lease, () => {
    if (
      authority.authorityKind !== "validated-ladybug-clone" ||
      authority.canonicalDbPath !== canonical(normalized) ||
      !same(authority.primaryFile, pathIdentity(normalized))
    ) {
      throw lineageError(normalized, "validated clone identity mismatch");
    }
    verifyCopy(normalized, authority.family);
    removeCopiedMarker(normalized);
    closedSnapshot(normalized);
  });
}

export function acquireQualificationLadybugCloneFamily(
  path: string,
  authority: QualificationLadybugCloneAuthority,
  driver: LadybugLineageDriver,
): LadybugFamilyLease {
  const normalized = dbPath(path);
  const lease = newLease(normalized, driver, "qualification");
  return guardedAcquire(lease, () => {
    if (
      authority.version !== 1 ||
      typeof authority.phase !== "string" ||
      authority.phase.length === 0
    ) {
      throw lineageError(
        normalized,
        "qualification clone authority version or phase mismatch",
      );
    }
    const expectedPath = qualificationCanonical(normalized);
    if (
      authority.clonePath !== expectedPath ||
      authority.cloneFamily.primaryPath !== expectedPath
    ) {
      throw lineageError(normalized, "qualification clone authority path mismatch");
    }
    verifyCopy(normalized, authority.cloneFamily.fingerprint);
    verifyAuthorityFamily(normalized, authority.cloneFamily);
    for (const forbidden of authority.forbiddenFamilies) {
      verifyAuthorityFamily(normalized, forbidden);
    }
    const forbiddenIdentities = new Set(
      authority.forbiddenFamilies.flatMap((family) =>
        family.members.map((member) => member.device + ":" + member.inode),
      ),
    );
    if (
      authority.cloneFamily.members.some((member) =>
        forbiddenIdentities.has(member.device + ":" + member.inode),
      )
    ) {
      throw lineageError(
        normalized,
        "qualification clone hardlinks a forbidden database family",
      );
    }
    removeCopiedMarker(normalized);
    closedSnapshot(normalized);
  });
}

export function sealSafeRebuildFamilyForReopen(
  lease: LadybugFamilyLease,
): void {
  requireLease(lease, "safe-rebuild");
  lease.safeRebuildSnapshot = closedSnapshot(lease.dbPath);
}

export function verifySafeRebuildFamilyBeforeReopen(
  lease: LadybugFamilyLease,
): void {
  requireLease(lease, "safe-rebuild");
  if (!lease.safeRebuildSnapshot) {
    throw lineageError(
      lease.dbPath,
      "safe rebuild was not sealed after its first strict close",
    );
  }
  assertUnchanged(
    lease.dbPath,
    lease.safeRebuildSnapshot,
    "safe rebuild family changed before reopen",
  );
}

function finalizeReusableFamilyClose(lease: LadybugFamilyLease): void {
  try {
    const snapshot = closedSnapshot(lease.dbPath);
    publish(
      lease,
      snapshot,
      "closed family changed before receipt publication",
    );
  } finally {
    release(lease);
  }
}

export function finalizeNormalLadybugFamilyClose(
  lease: LadybugFamilyLease,
): void {
  requireLease(lease, "normal");
  finalizeReusableFamilyClose(lease);
}

export function finalizeValidatedLadybugCloneFamily(
  lease: LadybugFamilyLease,
): void {
  requireLease(lease, "validated-clone");
  finalizeReusableFamilyClose(lease);
}

export function finalizeSafeRebuildLadybugFamily(
  lease: LadybugFamilyLease,
  beforePublication?: () => void,
): void {
  requireLease(lease, "safe-rebuild");
  try {
    if (!lease.safeRebuildSnapshot) {
      throw lineageError(
        lease.dbPath,
        "safe rebuild was not verified through a closed reopen",
      );
    }
    const validated = closedSnapshot(lease.dbPath);
    beforePublication?.();
    assertUnchanged(
      lease.dbPath,
      validated,
      "safe rebuild target changed after validation",
    );
    publish(
      lease,
      validated,
      "safe rebuild target changed after validation",
    );
  } finally {
    release(lease);
  }
}

export function abandonLadybugFamily(lease: LadybugFamilyLease): void {
  release(lease);
}
