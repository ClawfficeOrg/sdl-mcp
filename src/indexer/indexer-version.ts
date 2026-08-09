import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

type RecordTiming = (phaseName: string, durationMs: number) => void;

const SNAPSHOT_DIAGNOSTICS_ENABLED =
  process.env.SDL_MCP_SNAPSHOT_DIAGNOSTICS === "1";

function logSnapshotDiagnostic(
  message: string,
  fields: Record<string, unknown>,
): void {
  if (!SNAPSHOT_DIAGNOSTICS_ENABLED) return;
  process.stderr.write(
    `[snapshot-diagnostic] ${message} ${JSON.stringify(fields)}\n`,
  );
}

async function measureVersionPhase<T>(
  recordTiming: RecordTiming | undefined,
  phaseName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordTiming?.(phaseName, Date.now() - startedAt);
  }
}

async function snapshotSymbolsForVersion(params: {
  repoId: string;
  versionId: string;
  recordTiming?: RecordTiming;
}): Promise<number> {
  const { repoId, versionId, recordTiming } = params;
  const readConn = await getLadybugConn();
  let afterSymbolId: string | undefined;
  let symbolCount = 0;
  let pageNumber = 0;

  await measureVersionPhase(
    recordTiming,
    "versionSnapshot.snapshot",
    async () => {
      // ponytail: Batched MERGE is the ceiling until Ladybug COPY has a native blank-key safety regression.
      while (true) {
        const currentPage = pageNumber + 1;
        // These paired boundaries distinguish native result delivery failures
        // from the SymbolVersion transactions that consume each delivered page.
        logSnapshotDiagnostic("snapshot read page start", {
          repoId,
          versionId,
          pageNumber: currentPage,
          afterSymbolId: afterSymbolId ?? null,
        });
        const symbols = await measureVersionPhase(
          recordTiming,
          "versionSnapshot.snapshot.readPages",
          () =>
            ladybugDb.getSymbolsByRepoForSnapshotPage(readConn, repoId, {
              afterSymbolId,
            }),
        );
        logSnapshotDiagnostic("snapshot read page end", {
          repoId,
          versionId,
          pageNumber: currentPage,
          rowCount: symbols.length,
          lastSymbolId: symbols[symbols.length - 1]?.symbolId ?? null,
        });
        if (symbols.length === 0) break;

        const rows = symbols.map((symbol) => ({
          versionId,
          symbolId: symbol.symbolId,
          astFingerprint: symbol.astFingerprint,
          signatureJson: symbol.signatureJson,
          summary: symbol.summary,
          invariantsJson: symbol.invariantsJson,
          sideEffectsJson: symbol.sideEffectsJson,
          testCaseJson: symbol.testCaseJson,
        }));
        await measureVersionPhase(
          recordTiming,
          "versionSnapshot.snapshot.writePages",
          () =>
            withWriteConn((wConn) =>
              ladybugDb.snapshotSymbolVersionsBatch(wConn, rows),
            ),
        );
        symbolCount += symbols.length;
        pageNumber = currentPage;
        afterSymbolId = symbols[symbols.length - 1]?.symbolId;
      }
    },
  );

  logger.debug("Version snapshot complete", {
    repoId,
    versionId,
    symbolCount,
  });
  return symbolCount;
}

export async function snapshotCurrentSymbolsForVersion(params: {
  repoId: string;
  versionId: string;
  recordTiming?: RecordTiming;
}): Promise<number> {
  return snapshotSymbolsForVersion(params);
}

export async function createVersionAndSnapshot(params: {
  repoId: string;
  versionId: string;
  reason: string;
  recordTiming?: RecordTiming;
}): Promise<void> {
  const { repoId, versionId, reason, recordTiming } = params;
  logSnapshotDiagnostic("version create start", { repoId, versionId });
  await measureVersionPhase(
    recordTiming,
    "versionSnapshot.createVersion",
    () =>
      withWriteConn(async (wConn) => {
        await ladybugDb.createVersion(wConn, {
          versionId,
          repoId,
          createdAt: new Date().toISOString(),
          reason,
          prevVersionHash: null,
          versionHash: null,
        });
      }),
  );
  logSnapshotDiagnostic("version create end", { repoId, versionId });
  await snapshotSymbolsForVersion({
    repoId,
    versionId,
    recordTiming,
  });
}
