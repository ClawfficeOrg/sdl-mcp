import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { DatabaseError } from "../domain/errors.js";
import { normalizePath } from "../util/paths.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";

const RECEIPT_KIND = "sdl-mcp-ladybug-ready";
const RECEIPT_VERSION = 1;
const MARKER_SUFFIX = ".sdl-lineage.json";

export interface LadybugLineageDriver {
  version: string;
  storageVersion: string;
}

interface LadybugLineageReceipt {
  receiptKind: typeof RECEIPT_KIND;
  receiptVersion: typeof RECEIPT_VERSION;
  canonicalDbPath: string;
  primaryFile: {
    dev: string;
    ino: string;
  };
  driverVersion: string;
  storageVersion: string;
}

function normalizedDbPath(dbPath: string): string {
  return normalizePath(normalizeGraphDbPath(dbPath));
}

function canonicalDbPath(dbPath: string): string {
  return normalizePath(realpathSync.native(dbPath));
}

function primaryFileIdentity(dbPath: string): { dev: string; ino: string } {
  const stat = statSync(dbPath, { bigint: true });
  if (!stat.isFile()) {
    throw lineageError(dbPath, "primary database path is not a regular file");
  }
  return {
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
  };
}

function lineageError(dbPath: string, reason: string): DatabaseError {
  return new DatabaseError(
    "Refusing to open existing LadybugDB at " +
      normalizedDbPath(dbPath) +
      " because its " +
      reason +
      ". Preserve the existing database family and build a fresh candidate with: " +
      "sdl-mcp index --force --safe-rebuild <absolute-new-path>.",
  );
}

function readReceipt(dbPath: string): Record<string, unknown> {
  const markerPath = getLadybugLineageMarkerPath(dbPath);
  if (!existsSync(markerPath)) {
    throw lineageError(dbPath, "lineage marker is missing");
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("receipt must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw lineageError(dbPath, "lineage marker is malformed");
  }
}

export function getLadybugLineageMarkerPath(dbPath: string): string {
  return normalizedDbPath(dbPath) + MARKER_SUFFIX;
}

export function verifyLadybugLineageBeforeOpen(
  dbPath: string,
  driver: LadybugLineageDriver,
): "fresh" | "ready" {
  const normalizedPath = normalizedDbPath(dbPath);
  if (!existsSync(normalizedPath)) {
    if (existsSync(getLadybugLineageMarkerPath(normalizedPath))) {
      throw lineageError(
        normalizedPath,
        "lineage marker exists without its primary database",
      );
    }
    return "fresh";
  }

  const receipt = readReceipt(normalizedPath);
  if (receipt.receiptKind !== RECEIPT_KIND) {
    throw lineageError(normalizedPath, "receipt kind mismatch");
  }
  if (receipt.receiptVersion !== RECEIPT_VERSION) {
    throw lineageError(normalizedPath, "receipt version mismatch");
  }
  if (receipt.canonicalDbPath !== canonicalDbPath(normalizedPath)) {
    throw lineageError(normalizedPath, "canonical path mismatch");
  }

  const identity = primaryFileIdentity(normalizedPath);
  const primaryFile = receipt.primaryFile;
  if (
    !primaryFile ||
    typeof primaryFile !== "object" ||
    Array.isArray(primaryFile) ||
    (primaryFile as Record<string, unknown>).dev !== identity.dev ||
    (primaryFile as Record<string, unknown>).ino !== identity.ino
  ) {
    throw lineageError(normalizedPath, "primary file identity mismatch");
  }
  if (receipt.driverVersion !== driver.version) {
    throw lineageError(normalizedPath, "driver version mismatch");
  }
  if (receipt.storageVersion !== driver.storageVersion) {
    throw lineageError(normalizedPath, "storage version mismatch");
  }
  return "ready";
}

export function reserveFreshLadybugPrimary(dbPath: string): void {
  const normalizedPath = normalizedDbPath(dbPath);
  if (existsSync(getLadybugLineageMarkerPath(normalizedPath))) {
    throw lineageError(
      normalizedPath,
      "lineage marker exists without its primary database",
    );
  }
  if (existsSync(normalizedPath)) {
    throw lineageError(
      normalizedPath,
      "primary database appeared during fresh initialization",
    );
  }

  try {
    closeSync(openSync(normalizedPath, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw lineageError(
        normalizedPath,
        "primary database appeared during fresh initialization",
      );
    }
    throw error;
  }
}

export function writeLadybugLineageMarker(
  dbPath: string,
  driver: LadybugLineageDriver,
): void {
  const normalizedPath = normalizedDbPath(dbPath);
  const markerPath = getLadybugLineageMarkerPath(normalizedPath);
  if (existsSync(markerPath)) {
    throw lineageError(normalizedPath, "lineage marker already exists");
  }
  const receipt: LadybugLineageReceipt = {
    receiptKind: RECEIPT_KIND,
    receiptVersion: RECEIPT_VERSION,
    canonicalDbPath: canonicalDbPath(normalizedPath),
    primaryFile: primaryFileIdentity(normalizedPath),
    driverVersion: driver.version,
    storageVersion: driver.storageVersion,
  };
  const temporaryPath = markerPath + ".tmp-" + process.pid + "-" + randomUUID();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(receipt) + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, markerPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
