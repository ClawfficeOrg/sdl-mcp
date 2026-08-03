import type { Connection, Database } from "kuzu";

import { execCheckpoint } from "./ladybug-core.js";
import {
  fenceLadybugOperationsForNativeCleanup,
  withExclusiveLadybugOperation,
} from "./ladybug-operation-gate.js";

export interface ManagedLadybugDatabaseOptions {
  bufferManagerSize?: number;
  checkpointThresholdBytes?: number;
}

export interface LadybugDatabaseConstructor {
  new (
    databasePath: string,
    bufferManagerSize?: number,
    enableCompression?: boolean,
    readOnly?: boolean,
    maxDbSize?: number,
    autoCheckpoint?: boolean,
    checkpointThreshold?: number,
    throwOnWalReplayFailure?: boolean,
  ): Database;
}

export interface LadybugConnectionConstructor {
  new (database: Database): Connection;
}

interface PendingShadowLadybugDatabaseCleanup {
  conn?: Connection;
  db?: Database;
}

let pendingShadowCleanup: PendingShadowLadybugDatabaseCleanup | null = null;

export function hasPendingShadowLadybugDatabaseCleanup(): boolean {
  return pendingShadowCleanup !== null;
}

/** Retry handles retained after a failed shadow close. Caller owns exclusive admission. */
export async function retryPendingShadowLadybugDatabaseCleanup(): Promise<void> {
  const pending = pendingShadowCleanup;
  if (!pending) return;
  const failures: unknown[] = [];

  if (pending.conn) {
    try {
      await pending.conn.close();
      pending.conn = undefined;
    } catch (error) {
      failures.push(error);
    }
  }
  if (pending.db) {
    try {
      await pending.db.close();
      pending.db = undefined;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!pending.conn && !pending.db) pendingShadowCleanup = null;

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Pending shadow Ladybug database cleanup failed",
    );
  }
}

/**
 * Construct an SDL-managed database with native auto-checkpointing disabled and
 * strict WAL replay enabled. SDL owns every checkpoint admission explicitly.
 */
export function createManagedLadybugDatabase(
  DatabaseConstructor: LadybugDatabaseConstructor,
  databasePath: string,
  options: ManagedLadybugDatabaseOptions = {},
): Database {
  return new DatabaseConstructor(
    databasePath,
    options.bufferManagerSize,
    true,
    false,
    0,
    false,
    options.checkpointThresholdBytes,
    true,
  );
}

/**
 * Checkpoint and close a short-lived database under one exclusive admission.
 * Every cleanup is attempted so a failed checkpoint cannot leak native handles.
 */
export function checkpointAndCloseLadybugDatabase(
  conn: Connection | undefined,
  db: Database,
): Promise<void> {
  return withExclusiveLadybugOperation(async () => {
    const failures: unknown[] = [];
    const retained: PendingShadowLadybugDatabaseCleanup = {};

    if (conn) {
      try {
        await execCheckpoint(conn);
      } catch (error) {
        failures.push(error);
      }
      try {
        await conn.close();
      } catch (error) {
        failures.push(error);
        retained.conn = conn;
      }
    }
    try {
      await db.close();
    } catch (error) {
      failures.push(error);
      retained.db = db;
    }

    if (retained.conn || retained.db) {
      pendingShadowCleanup = retained;
      fenceLadybugOperationsForNativeCleanup();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Ladybug database checkpoint and close failed",
      );
    }
  });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Own a short-lived shadow database from construction through cleanup. Keeping
 * ownership here closes the database even when Connection construction fails,
 * and preserves both a primary operation failure and any cleanup failure.
 */
export async function withShadowLadybugDatabase<T>(
  DatabaseConstructor: LadybugDatabaseConstructor,
  ConnectionConstructor: LadybugConnectionConstructor,
  databasePath: string,
  body: (conn: Connection) => Promise<T>,
  options: ManagedLadybugDatabaseOptions = {},
): Promise<T> {
  return withExclusiveLadybugOperation(async () => {
    const db = createManagedLadybugDatabase(
      DatabaseConstructor,
      databasePath,
      options,
    );
    let conn: Connection | undefined;
    let result!: T;
    let operationFailed = false;
    let operationError: unknown;

    try {
      conn = new ConnectionConstructor(db);
      result = await body(conn);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await checkpointAndCloseLadybugDatabase(conn, db);
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }

    if (operationFailed && cleanupFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Shadow Ladybug database operation failed: ${failureMessage(operationError)}; cleanup failed: ${failureMessage(cleanupError)}`,
      );
    }
    if (operationFailed) throw operationError;
    if (cleanupFailed) throw cleanupError;
    return result;
  });
}
