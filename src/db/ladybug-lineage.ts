import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { DatabaseError } from "../domain/errors.js";
import { isProcessAlive } from "../util/pidfile.js";
import { normalizePath } from "../util/paths.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";
import {
  consumeQualificationLadybugCloneAuthority,
  type QualificationFamilyAuthority,
  type QualificationFamilyMemberAuthority,
  type QualificationLadybugCloneAuthority,
  type QualificationLadybugCloneCapability,
} from "./ladybug-authority.js";
import {
  canonicalLadybugPath,
  collectLadybugFamilyFiles,
  consumeVerifiedLadybugFamilyCopy,
  fingerprintLadybugFamily,
  inventoryLadybugFamilyIdentities,
  ladybugFamilyFingerprintsEqual,
  ladybugFileIdentity,
  readBoundedLadybugControlFile,
  type LadybugFamilyFingerprint,
  type LadybugFileIdentity,
  type VerifiedLadybugFamilyCopy,
} from "./ladybug-family-files.js";

const RECEIPT_KIND = "sdl-mcp-ladybug-ready";
const RECEIPT_VERSION = 2;
const MARKER_SUFFIX = ".sdl-lineage.json";
const LOCK_SUFFIX = ".sdl-family.lock";
const MAX_FAMILY_MEMBERS = 32;
const SHA256 = /^[0-9a-f]{64}$/u;
const LEASE = Symbol("LadybugFamilyLease");

export interface LadybugLineageDriver {
  version: string;
  storageVersion: string;
}

export type {
  LadybugFamilyFileFingerprint,
  LadybugFamilyFingerprint,
} from "./ladybug-family-files.js";
export type {
  QualificationFamilyAuthority,
  QualificationLadybugCloneAuthority,
  QualificationLadybugCloneCapability,
} from "./ladybug-authority.js";

type FileIdentity = LadybugFileIdentity;

interface FamilySnapshot {
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
  lockIdentity: FileIdentity | null;
  lockDescriptor: number | null;
  lockReady: boolean;
  lockPathDetached: boolean;
  released: boolean;
  safeRebuildSnapshot?: FamilySnapshot;
}

let pendingLeaseCleanup: LadybugFamilyLease | null = null;

function retainPendingLeaseCleanup(lease: LadybugFamilyLease): void {
  if (
    pendingLeaseCleanup &&
    pendingLeaseCleanup !== lease &&
    !pendingLeaseCleanup.released
  ) {
    throw new DatabaseError(
      "Another LadybugDB family lock cleanup is already pending",
    );
  }
  pendingLeaseCleanup = lease;
}

function clearPendingLeaseCleanup(lease: LadybugFamilyLease): void {
  if (pendingLeaseCleanup === lease) pendingLeaseCleanup = null;
}

function assertNoPendingLeaseCleanup(path: string): void {
  if (pendingLeaseCleanup?.released) pendingLeaseCleanup = null;
  if (!pendingLeaseCleanup) return;
  throw lineageError(
    path,
    "family lock cleanup is pending at " +
      pendingLeaseCleanup.lockPath +
      "; retry closeLadybugDb({ strict: true }) before opening another family",
  );
}

export function hasPendingLadybugFamilyLeaseCleanup(): boolean {
  return pendingLeaseCleanup !== null && !pendingLeaseCleanup.released;
}

export function retryPendingLadybugFamilyLeaseCleanup(): void {
  const lease = pendingLeaseCleanup;
  if (!lease) return;
  try {
    release(lease);
  } finally {
    if (lease.released) clearPendingLeaseCleanup(lease);
  }
}

function dbPath(path: string): string {
  return normalizePath(normalizeGraphDbPath(path));
}

function canonical(path: string): string {
  return canonicalLadybugPath(path);
}

function qualificationCanonical(path: string): string {
  return canonicalLadybugPath(path);
}

function pathIdentity(path: string): FileIdentity {
  return ladybugFileIdentity(path);
}

function identity(stat: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
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
  return collectLadybugFamilyFiles(path).map((member) => basename(member));
}

function readBounded(path: string, label: string): Buffer {
  return readBoundedLadybugControlFile(path, label);
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
    family: fingerprintLadybugFamily(normalized, {
      exclude: [...metadata],
    }),
  };
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
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !SHA256.test(file.sha256),
    ) ||
    createHash("sha256")
      .update(JSON.stringify(value.files), "utf8")
      .digest("hex") !== value.sha256
  ) {
    throw lineageError(path, "verified copy fingerprint is invalid");
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
  assertNoPendingLeaseCleanup(normalized);
  const lockPath = getLadybugFamilyLockPath(normalized);
  const nonce = createHash("sha256").update(randomUUID()).digest("hex");
  let lease: LadybugFamilyLease | undefined;

  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    lease = {
      [LEASE]: true,
      dbPath: normalized,
      driver: { ...driver },
      mode,
      lockPath,
      lockNonce: nonce,
      lockIdentity: null,
      lockDescriptor: descriptor,
      lockReady: false,
      lockPathDetached: false,
      released: false,
    };
    lease.lockIdentity = identity(fstatSync(descriptor, { bigint: true }));
    writeFileSync(
      descriptor,
      JSON.stringify({ version: 1, pid: process.pid, nonce }) + "\n",
    );
    fsyncSync(descriptor);
    lease.lockReady = true;
    return lease;
  } catch (error) {
    if (lease) {
      try {
        release(lease);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "LadybugDB family lock initialization failed and cleanup is pending",
        );
      }
      throw error;
    }

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
        "family lock changed while inspecting its stale owner",
      );
    }
    throw lineageError(
      normalized,
      "family lock owner PID " +
        owner.pid +
        " is not running, but automatic reclamation is unsafe; stop all SDL-MCP processes, verify the database family is offline, then remove the stale lock: " +
        lockPath,
    );
  }
}

function requireLeaseHandle(
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
}

function requireLease(
  lease: LadybugFamilyLease,
  mode?: LadybugFamilyLease["mode"],
): void {
  requireLeaseHandle(lease, mode);
  if (!lease.lockReady || lease.lockIdentity === null) {
    throw new DatabaseError("LadybugDB family lease initialization is incomplete");
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

function closeLeaseAfterPathLoss(
  lease: LadybugFamilyLease,
  pathError: unknown,
): never {
  // Never inspect or unlink a lost/replaced pathname again. If close fails,
  // strict close retries only the descriptor retained by this process.
  lease.lockPathDetached = true;
  try {
    closeSync(lease.lockDescriptor!);
  } catch (closeError) {
    throw new AggregateError(
      [pathError, closeError],
      "LadybugDB family lock ownership changed and its descriptor could not be closed",
    );
  }
  lease.lockDescriptor = null;
  lease.released = true;
  clearPendingLeaseCleanup(lease);
  throw pathError;
}

function release(lease: LadybugFamilyLease): void {
  if (lease.released) return;

  try {
    requireLeaseHandle(lease);
    if (lease.lockIdentity === null) {
      lease.lockIdentity = identity(
        fstatSync(lease.lockDescriptor!, { bigint: true }),
      );
    }

    if (!lease.lockPathDetached) {
      try {
        if (lease.lockReady) {
          const owner = readLock(lease.lockPath, lease.dbPath);
          if (
            owner.pid !== process.pid ||
            owner.nonce !== lease.lockNonce ||
            !same(owner.identity, lease.lockIdentity)
          ) {
            throw lineageError(lease.dbPath, "family lock ownership changed");
          }
        }
        if (!same(pathIdentity(lease.lockPath), lease.lockIdentity)) {
          throw lineageError(lease.dbPath, "family lock changed before release");
        }
      } catch (pathError) {
        closeLeaseAfterPathLoss(lease, pathError);
      }

      // Once unlink succeeds, a close failure can retry the retained descriptor
      // without inspecting a replacement path.
      unlinkSync(lease.lockPath);
      lease.lockPathDetached = true;
    }

    closeSync(lease.lockDescriptor!);
    lease.lockDescriptor = null;
    lease.released = true;
    clearPendingLeaseCleanup(lease);
  } catch (error) {
    if (!lease.released && lease.lockDescriptor !== null) {
      retainPendingLeaseCleanup(lease);
    }
    throw error;
  }
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
  includeFingerprint: boolean,
): QualificationFamilyAuthority {
  const normalized = dbPath(primaryPath);
  const lockName = basename(normalized) + LOCK_SUFFIX;
  const identities = inventoryLadybugFamilyIdentities(normalized, {
    exclude: [lockName],
  });
  return {
    role,
    primaryPath: qualificationCanonical(normalized),
    members: identities.map(({ path, dev, ino }) => ({
      path,
      device: dev,
      inode: ino,
    })),
    ...(includeFingerprint
      ? {
          fingerprint: fingerprintLadybugFamily(normalized, {
            exclude: [lockName],
          }),
        }
      : {}),
  };
}

function validateQualificationAuthority(
  db: string,
  authority: QualificationLadybugCloneAuthority,
): void {
  if (
    !authority ||
    typeof authority !== "object" ||
    authority.version !== 1 ||
    typeof authority.phase !== "string" ||
    !/^[a-z0-9-]+$/u.test(authority.phase) ||
    typeof authority.clonePath !== "string" ||
    !authority.cloneFamily ||
    typeof authority.cloneFamily !== "object" ||
    !Array.isArray(authority.forbiddenFamilies)
  ) {
    throw lineageError(db, "qualification clone authority is malformed");
  }
  const families = [authority.cloneFamily, ...authority.forbiddenFamilies];
  if (
    families.some(
      (family) =>
        typeof family.role !== "string" ||
        typeof family.primaryPath !== "string" ||
        !Array.isArray(family.members),
    ) ||
    authority.cloneFamily.role !== "clone" ||
    authority.forbiddenFamilies.filter((family) => family.role === "source")
      .length !== 1 ||
    authority.forbiddenFamilies.some(
      (family) => family.role !== "source" && family.role !== "active",
    )
  ) {
    throw lineageError(db, "qualification family roles are invalid");
  }
  const paths = families.map((family) => family.primaryPath);
  if (new Set(paths).size !== paths.length) {
    throw lineageError(db, "qualification family roles overlap");
  }
}

function verifyDigestAuthorityFamily(
  db: string,
  expected: QualificationFamilyAuthority,
): QualificationFamilyAuthority {
  if (!expected.fingerprint) {
    throw lineageError(db, "qualification digest-bound family is missing a fingerprint");
  }
  validateFingerprint(db, expected.fingerprint);
  const actual = familyAuthority(expected.role, expected.primaryPath, true);
  if (
    actual.primaryPath !== expected.primaryPath ||
    !same(actual.members, expected.members) ||
    !actual.fingerprint ||
    !ladybugFamilyFingerprintsEqual(actual.fingerprint, expected.fingerprint)
  ) {
    throw lineageError(
      db,
      "qualification authority family identity or digest changed",
    );
  }
  return actual;
}

function currentActiveAuthorityMembers(
  db: string,
  expected: QualificationFamilyAuthority,
): readonly QualificationFamilyMemberAuthority[] {
  const canonicalPrimary = qualificationCanonical(expected.primaryPath);
  if (canonicalPrimary !== expected.primaryPath) {
    throw lineageError(db, "qualification active family path changed");
  }
  const expectedPrimary = expected.members.find(
    (member) => member.path === expected.primaryPath,
  );
  const currentPrimary = pathIdentity(expected.primaryPath);
  if (
    !expectedPrimary ||
    expectedPrimary.device !== currentPrimary.dev ||
    expectedPrimary.inode !== currentPrimary.ino
  ) {
    throw lineageError(db, "qualification active primary identity changed");
  }
  return familyAuthority("active", expected.primaryPath, false).members;
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
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "LadybugDB family acquisition failed and lock cleanup is pending",
      );
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

export function acquireValidatedLadybugCloneFamily(
  path: string,
  capability: VerifiedLadybugFamilyCopy,
  driver: LadybugLineageDriver,
): LadybugFamilyLease {
  const normalized = dbPath(path);
  const lease = newLease(normalized, driver, "validated-clone");
  return guardedAcquire(lease, () => {
    try {
      consumeVerifiedLadybugFamilyCopy(capability, normalized);
    } catch (error) {
      throw lineageError(
        normalized,
        error instanceof Error ? error.message : "validated clone capability failed",
      );
    }
    removeCopiedMarker(normalized);
    closedSnapshot(normalized);
  });
}

export function acquireQualificationLadybugCloneFamily(
  path: string,
  capability: QualificationLadybugCloneCapability,
  driver: LadybugLineageDriver,
): LadybugFamilyLease {
  const normalized = dbPath(path);
  const lease = newLease(normalized, driver, "qualification");
  return guardedAcquire(lease, () => {
    let authority: Readonly<QualificationLadybugCloneAuthority>;
    try {
      authority = consumeQualificationLadybugCloneAuthority(capability);
    } catch (error) {
      throw lineageError(
        normalized,
        error instanceof Error ? error.message : "qualification authority failed",
      );
    }
    validateQualificationAuthority(normalized, authority);
    const expectedPath = qualificationCanonical(normalized);
    if (
      authority.clonePath !== expectedPath ||
      authority.cloneFamily.primaryPath !== expectedPath
    ) {
      throw lineageError(normalized, "qualification clone authority path mismatch");
    }

    if (!authority.cloneFamily.fingerprint) {
      throw lineageError(
        normalized,
        "qualification digest-bound family is missing a fingerprint",
      );
    }
    validateFingerprint(normalized, authority.cloneFamily.fingerprint);
    const clone = familyAuthority("clone", authority.cloneFamily.primaryPath, true);
    const source = authority.forbiddenFamilies.find(
      (family) => family.role === "source",
    )!;
    const sourceCurrent = verifyDigestAuthorityFamily(normalized, source);
    const activeMembers = authority.forbiddenFamilies
      .filter((family) => family.role === "active")
      .flatMap((family) => currentActiveAuthorityMembers(normalized, family));
    const forbiddenIdentities = new Set(
      [...sourceCurrent.members, ...activeMembers].map(
        (member) => member.device + ":" + member.inode,
      ),
    );
    if (
      clone.members.some((member) =>
        forbiddenIdentities.has(member.device + ":" + member.inode),
      )
    ) {
      throw lineageError(
        normalized,
        "qualification clone hardlinks a forbidden database family",
      );
    }
    if (
      clone.primaryPath !== authority.cloneFamily.primaryPath ||
      !same(clone.members, authority.cloneFamily.members) ||
      !clone.fingerprint ||
      !ladybugFamilyFingerprintsEqual(
        clone.fingerprint,
        authority.cloneFamily.fingerprint,
      )
    ) {
      throw lineageError(
        normalized,
        "qualification authority family identity or digest changed",
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

function finalizeAndRelease(
  lease: LadybugFamilyLease,
  finalize: () => void,
): void {
  let finalizeFailed = false;
  let finalizeError: unknown;
  try {
    finalize();
  } catch (error) {
    finalizeFailed = true;
    finalizeError = error;
  }

  try {
    release(lease);
  } catch (cleanupError) {
    if (finalizeFailed) {
      throw new AggregateError(
        [finalizeError, cleanupError],
        "LadybugDB family finalization failed and lock cleanup is pending",
      );
    }
    throw cleanupError;
  }
  if (finalizeFailed) throw finalizeError;
}

function finalizeReusableFamilyClose(lease: LadybugFamilyLease): void {
  finalizeAndRelease(lease, () => {
    const snapshot = closedSnapshot(lease.dbPath);
    publish(
      lease,
      snapshot,
      "closed family changed before receipt publication",
    );
  });
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
  finalizeAndRelease(lease, () => {
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
  });
}

export function abandonLadybugFamily(lease: LadybugFamilyLease): void {
  release(lease);
}
