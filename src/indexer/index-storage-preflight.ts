import type { Connection } from "kuzu";

import { getFileCount } from "../db/ladybug-repos.js";
import {
  assertPhysicalSymbolUniqueness,
  assertPhysicalSymbolUniquenessSnapshot,
  readPhysicalSymbolIdProjection,
  readPhysicalSymbolUniqueness,
} from "../db/ladybug-symbols.js";
import {
  SafeRebuildRequiredError,
  StorageIntegrityError,
} from "../domain/errors.js";

export interface IndexStoragePreflightOptions {
  isolatedRebuild?: boolean;
}

export interface IndexStorageStabilitySnapshot {
  physicalTotal: number;
  distinctTotal: number;
  firstSymbolId: string | null;
  lastSymbolId: string | null;
  sampleSymbolIds: string[];
}

type ReadIndexStorageStabilitySnapshot = (
  conn: Connection,
) => Promise<IndexStorageStabilitySnapshot>;

function projectSymbolIds(rows: Array<{ symbolId: unknown }>): string[] {
  return rows.map(({ symbolId }) => {
    if (typeof symbolId !== "string" || symbolId.length === 0) {
      throw new StorageIntegrityError(
        "LadybugDB returned a non-canonical symbolId during startup preflight",
      );
    }
    return symbolId;
  });
}

export async function readIndexStorageStabilitySnapshot(
  conn: Connection,
): Promise<IndexStorageStabilitySnapshot> {
  const uniqueness = assertPhysicalSymbolUniquenessSnapshot(
    await readPhysicalSymbolUniqueness(conn),
  );
  const projection = await readPhysicalSymbolIdProjection(conn);
  const sampleSymbolIds = projectSymbolIds(projection.sampleRows);
  const lastSymbolIds = projectSymbolIds(projection.lastRows);

  if (
    (uniqueness.physicalTotal === 0 &&
      (sampleSymbolIds.length > 0 || lastSymbolIds.length > 0)) ||
    (uniqueness.physicalTotal > 0 &&
      (sampleSymbolIds.length === 0 || lastSymbolIds.length !== 1))
  ) {
    throw new StorageIntegrityError(
      "LadybugDB Symbol counts and canonical projections disagree during startup preflight",
    );
  }

  return {
    physicalTotal: uniqueness.physicalTotal,
    distinctTotal: uniqueness.distinctTotal,
    firstSymbolId: sampleSymbolIds[0] ?? null,
    lastSymbolId: lastSymbolIds[0] ?? null,
    sampleSymbolIds,
  };
}

export async function assertStableIndexStoragePreflight(
  conn: Connection,
  readSnapshot: ReadIndexStorageStabilitySnapshot =
    readIndexStorageStabilitySnapshot,
): Promise<IndexStorageStabilitySnapshot> {
  const first = await readSnapshot(conn);
  const second = await readSnapshot(conn);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new StorageIntegrityError(
      "LadybugDB physical Symbol scan was unstable across consecutive startup preflights",
    );
  }
  return second;
}

/**
 * Reject unsafe storage before provider generation, checkpoints, or graph
 * writes. A full index is destructive once files exist, so it may only target
 * an explicitly isolated rebuild candidate.
 */
export async function assertIndexStoragePreflight(
  conn: Connection,
  repoId: string,
  requestedMode: "full" | "incremental",
  options: IndexStoragePreflightOptions = {},
): Promise<void> {
  await assertPhysicalSymbolUniqueness(conn);

  if (
    requestedMode === "full" &&
    !options.isolatedRebuild &&
    (await getFileCount(conn, repoId)) > 0
  ) {
    throw new SafeRebuildRequiredError(
      `Refusing an in-place full refresh for populated repository ${repoId}. ` +
        "Build and validate a fresh whole-database candidate with " +
        "`sdl-mcp index --force --safe-rebuild <absolute-new-path>`.",
    );
  }
}
