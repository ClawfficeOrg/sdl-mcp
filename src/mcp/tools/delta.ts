import { DeltaGetRequestSchema, type DeltaGetResponse } from "../tools.js";
import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import { computeDelta } from "../../delta/diff.js";
import { runGovernorLoop } from "../../delta/blastRadius.js";
import { truncateArray } from "../../util/truncation.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import {
  getSliceHandle,
  updateSliceHandleSpillover,
} from "../../db/ladybug-queries.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  prefetchDeltaBlastRadius,
  consumePrefetchedKey,
} from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";
import { attachRawContext } from "../token-usage.js";
import { IndexError } from "../errors.js";
import type { ToolContext } from "../../server.js";

/** Default max changed symbols for delta responses (tighter than slice default). */
const DEFAULT_DELTA_MAX_CARDS = 10;
/** Default max tokens for delta responses (tighter than slice default). */
const DEFAULT_DELTA_MAX_TOKENS = 4000;
/** Hard cap on blast-radius items returned to the caller. */
const MAX_BLAST_RADIUS_ITEMS = 25;

class DeltaCursorMismatchError extends Error {
  readonly code = "DELTA_CURSOR_MISMATCH";

  constructor() {
    super("Delta cursor versions do not match the requested version range.");
    this.name = "DeltaCursorMismatchError";
  }
}

const DELTA_CHANGE_TYPE_ORDER = {
  added: 0,
  modified: 1,
  removed: 2,
} as const;

/**
 * Handles delta pack requests.
 * Computes and returns changes between two ledger versions with blast radius analysis.
 * Supports truncation for large delta sets and spillover handling.
 *
 * @param args - Raw arguments containing repoId, fromVersion, toVersion, and optional budget
 * @returns Delta pack response with changed symbols and blast radius
 * @throws {Error} If delta computation fails
 */
export async function handleDeltaGet(
  args: unknown,
  context?: ToolContext,
): Promise<DeltaGetResponse> {
  const validated = parseActionHandlerArgs(DeltaGetRequestSchema, args);

  recordToolTrace({
    repoId: validated.repoId,
    taskType: "delta",
    tool: "delta.get",
    clientKey: context?.clientKey,
  });

  const executeDelta = async () => {
    // Resolve version defaults when not provided
    const resolveConn = await getLadybugConn();
    let toVersion = validated.toVersion;
    let fromVersion = validated.fromVersion;
    if (!toVersion) {
      const latest = await ladybugDb.getLatestVersion(resolveConn, validated.repoId);
      if (!latest) {
        throw new IndexError("No versions found. Run indexing first.");
      }
      toVersion = latest.versionId;
    }
    if (!fromVersion) {
      const versions = await ladybugDb.getVersionsByRepo(resolveConn, validated.repoId, 2);
      fromVersion = versions.length >= 2 ? versions[1].versionId : toVersion;
    }

    
    if (
      validated.cursor &&
      (validated.cursor.fromVersion !== fromVersion ||
        validated.cursor.toVersion !== toVersion)
    ) {
      throw new DeltaCursorMismatchError();
    }

    const singleVersionHint = fromVersion === toVersion
      ? "Only one ledger version exists — delta is empty. Run index.refresh after making changes to create a new version."
      : undefined;
    let delta;
    try {
      delta = await computeDelta(
        validated.repoId,
        fromVersion,
        toVersion,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to compute delta pack.";
      throw new IndexError(`Delta pack error: ${message}`);
    }

    delta.changedSymbols.sort((left, right) => {
      const typeOrder =
        DELTA_CHANGE_TYPE_ORDER[left.changeType] -
        DELTA_CHANGE_TYPE_ORDER[right.changeType];
      if (typeOrder !== 0) return typeOrder;
      if (left.symbolId < right.symbolId) return -1;
      if (left.symbolId > right.symbolId) return 1;
      return 0;
    });

    const changedSymbolIds = delta.changedSymbols.map(
      (change) => change.symbolId,
    );

    // Fix #1: emit the large-delta warning BEFORE running the governor
    // loop so callers with a huge auto-resolved range can bail out cheaply
    // (the governor + blast-radius step is the dominant latency cost).
    const totalChangesEarly = delta.changedSymbols.length;
    const preValidated = validated as unknown as {
      preview?: boolean;
      previewSampleSize?: number;
      skipBlastRadius?: boolean;
    };
    // Hard cap: above this many changed symbols, blast radius computation is
    // unbounded (267s observed on 635-change deltas). Skip regardless of
    // whether fromVersion was provided; callers can opt back in via
    // skipBlastRadius:false on a budget-narrowed range.
    const HARD_AUTO_SKIP_THRESHOLD = 500;
    const autoSkipBlastRadius =
      totalChangesEarly > HARD_AUTO_SKIP_THRESHOLD ||
      (validated.budget?.maxCards != null && totalChangesEarly > validated.budget.maxCards * 5);
    const shouldSkipBlastRadius =
      preValidated.preview === true ||
      preValidated.skipBlastRadius === true ||
      autoSkipBlastRadius;

    if (preValidated.preview === true) {
      const sampleSize = Math.min(
        preValidated.previewSampleSize ?? 20,
        totalChangesEarly,
      );
      const sampleIds = changedSymbolIds.slice(0, sampleSize);
      const previewConn = await getLadybugConn();
      const symbolMap = await ladybugDb.getSymbolsByIds(
        previewConn,
        sampleIds,
      );
      const fileIds = [
        ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
      ];
      const fileMap = await ladybugDb.getFilesByIds(previewConn, fileIds);
      const sample = delta.changedSymbols.slice(0, sampleSize).map((c) => {
        const sym = symbolMap.get(c.symbolId);
        const file = sym ? fileMap.get(sym.fileId) : undefined;
        return {
          ...c,
          name: sym?.name,
          kind: sym?.kind,
          file: file?.relPath,
        };
      });
      // Shape the preview response so withSpan's
      // span.setAttributes(result.delta.changedSymbols.length, ...)
      // still type-checks. We inject a synthetic `delta` envelope with
      // an empty blastRadius and the sampled changes.
      const previewDelta = {
        ...delta,
        changedSymbols: sample,
        blastRadius: [],
      };
      (previewDelta as unknown as Record<string, unknown>).mode = "preview";
      (previewDelta as unknown as Record<string, unknown>).totalChanges =
        totalChangesEarly;
      (previewDelta as unknown as Record<string, unknown>).sampleSize =
        sampleSize;
      if (totalChangesEarly > 500) {
        (previewDelta as unknown as Record<string, unknown>).largeDeltaWarning =
          `This delta spans ${totalChangesEarly} changes. Use fromVersion/toVersion to narrow, or call without preview=true to compute blast radius.`;
      }
      return {
        delta: previewDelta,
        amplifiers: [] as Array<{
          symbolId: string;
          growthRate: number;
          previous: number;
          current: number;
        }>,
      };
    }

    // Consume prefetched blast-radius keys
    for (const symbolId of changedSymbolIds) {
      consumePrefetchedKey(
        validated.repoId,
        `blast:${symbolId}`,
        "delta-blast",
        context,
      );
    }

    if (!shouldSkipBlastRadius) {
      prefetchDeltaBlastRadius(validated.repoId, changedSymbolIds, context);
    }

    const config = loadConfig();
    const defaultDeltaMaxTokens =
      config.slice?.defaultMaxTokens ?? DEFAULT_DELTA_MAX_TOKENS;

    // Resolve omitted fields independently before applying hard response caps.
    const budget = {
      maxCards: Math.min(
        validated.budget?.maxCards ?? DEFAULT_DELTA_MAX_CARDS,
        100,
      ),
      maxEstimatedTokens: Math.min(
        validated.budget?.maxEstimatedTokens ?? defaultDeltaMaxTokens,
        20_000,
      ),
    };
    const governorOptions = {
      repoId: validated.repoId,
      budget,
      runDiagnostics: true,
      diagnosticsTimeoutMs: 5000,
      fromVersionId: fromVersion,
      toVersionId: toVersion,
    };

    const conn = await getLadybugConn();
    // Fix #1: skip the governor loop (which drives the 111s latency on
    // large deltas) when preview/skipBlastRadius/auto-skip is active.
    let governorResult: Awaited<ReturnType<typeof runGovernorLoop>> | null = null;
    if (!shouldSkipBlastRadius) {
      governorResult = await runGovernorLoop(
        conn,
        changedSymbolIds,
        governorOptions,
      );
      delta.blastRadius = governorResult.blastRadius;
      delta.trimmedSet = governorResult.trimmedSet;
    } else {
      // Keep the shape deterministic even when skipped so downstream
      // truncation + enrichment blocks don't branch on null.
      delta.blastRadius = [];
      // preview === true returned earlier; only explicit skipBlastRadius or
      // the auto-skip threshold can land us here.
      const reason =
        preValidated.skipBlastRadius === true ? "explicit" : "auto-skip";
      (delta as unknown as Record<string, unknown>).blastRadiusSkipped = {
        reason,
        totalChanges: totalChangesEarly,
        threshold: HARD_AUTO_SKIP_THRESHOLD,
        howToResume:
          "Pass { preview: false, skipBlastRadius: false, budget: { maxCards: <N> } } with a narrower fromVersion/toVersion window to compute blast radius.",
      };
    }

    if (governorResult && governorResult.spilloverHandle) {
      const spilloverHandle = governorResult.spilloverHandle;
      delta.spilloverHandle = spilloverHandle;

      await withWriteConn(async (wConn) => {
        // Ensure the handle exists so slice.spillover.get can retrieve it
        const handleRow = await getSliceHandle(conn, spilloverHandle);
        if (!handleRow) {
          await ladybugDb.upsertSliceHandle(wConn, {
            handle: spilloverHandle,
            repoId: validated.repoId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            minVersion: null,
            maxVersion: validated.toVersion ?? null,
            sliceHash: spilloverHandle,
            spilloverRef: null,
            cardDetail: null,
          });
        }
        await updateSliceHandleSpillover(
          wConn,
          spilloverHandle,
          JSON.stringify(governorResult.trimmedSet.droppedSymbols),
        );
      })
    }

    const maxChanges = budget.maxCards;
    const maxBlastRadius = MAX_BLAST_RADIUS_ITEMS;
    const totalChanges = delta.changedSymbols.length;
    const pageOffset = validated.cursor?.offset ?? 0;
    const nextOffset = Math.min(pageOffset + maxChanges, totalChanges);
    const hasMore = nextOffset < totalChanges;
    const nextCursor = hasMore
      ? { fromVersion, toVersion, offset: nextOffset }
      : undefined;
    delta.changedSymbols = delta.changedSymbols.slice(pageOffset, nextOffset);

    const blastRadiusTruncation = truncateArray(delta.blastRadius, {
      maxItems: maxBlastRadius,
    });
    if (blastRadiusTruncation.truncated) {
      delta.blastRadius = blastRadiusTruncation.items;
      delta.truncation = {
        truncated: true,
        droppedChanges: 0,
        droppedBlastRadius: blastRadiusTruncation.droppedCount,
        // Blast-radius spillover is handle-backed above when available. Do not
        // advertise the legacy array cursor because no public action accepts it.
        howToResume: null,
      };
    }

    delta.blastRadius = delta.blastRadius.map(
      ({ reason: _reason, ...rest }) =>
        rest as (typeof delta.blastRadius)[number],
    );

    // Warn when auto-resolved delta is very large
    if (totalChanges > 500 && !validated.fromVersion) {
      const suffix = shouldSkipBlastRadius
        ? " Blast-radius computation was skipped (pass skipBlastRadius=false to force)."
        : "";
      (delta as unknown as Record<string, unknown>).largeDeltaWarning =
        "This delta spans " +
        totalChanges +
        " changes. Narrow the version range with fromVersion/toVersion for targeted results." +
        suffix;
    }

    // Collect all symbol IDs for enrichment (changed + blast radius)
    const blastRadiusSymbolIds = delta.blastRadius.map((item) => item.symbolId);
    const pageChangedSymbolIds = delta.changedSymbols.map(
      (change) => change.symbolId,
    );
    const allSymbolIds = [
      ...new Set([...pageChangedSymbolIds, ...blastRadiusSymbolIds]),
    ];

    const symbolMap = await ladybugDb.getSymbolsByIds(conn, allSymbolIds);

    // Build fileId-to-relPath map for enrichment
    const allFileIds = [
      ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
    ];
    const fileMap = await ladybugDb.getFilesByIds(conn, allFileIds);

    // Enrich changedSymbols with human-readable fields
    delta.changedSymbols = delta.changedSymbols.map((change) => {
      const sym = symbolMap.get(change.symbolId);
      if (!sym) return change;
      const file = fileMap.get(sym.fileId);
      return {
        ...change,
        name: sym.name,
        kind: sym.kind,
        file: file?.relPath ?? undefined,
      };
    });

    // Enrich blastRadius with human-readable fields
    delta.blastRadius = delta.blastRadius.map((item) => {
      const sym = symbolMap.get(item.symbolId);
      if (!sym) return item;
      const file = fileMap.get(sym.fileId);
      return {
        ...item,
        name: sym.name,
        kind: sym.kind,
        file: file?.relPath ?? undefined,
      };
    });

    // Apply MAX_BLAST_RADIUS_ITEMS hard cap
    // Defensive hard cap (first truncation via truncateArray should already enforce this)
    if (delta.blastRadius.length > MAX_BLAST_RADIUS_ITEMS) {
      delta.blastRadius = delta.blastRadius.slice(0, MAX_BLAST_RADIUS_ITEMS);
    }

    const amplifiers = delta.blastRadius
      .filter((item) => item.fanInTrend?.isAmplifier)
      .map((item) => ({
        symbolId: item.symbolId,
        growthRate: item.fanInTrend!.growthRate,
        previous: item.fanInTrend!.previous,
        current: item.fanInTrend!.current,
      }));

    const fileIds = allFileIds;

    const continuationArgs = nextCursor
      ? {
          repoId: validated.repoId,
          fromVersion,
          toVersion,
          cursor: nextCursor,
          budget,
          ...(validated.preview !== undefined
            ? { preview: validated.preview }
            : {}),
          ...(validated.previewSampleSize !== undefined
            ? { previewSampleSize: validated.previewSampleSize }
            : {}),
          ...(validated.skipBlastRadius !== undefined
            ? { skipBlastRadius: validated.skipBlastRadius }
            : {}),
        }
      : undefined;
    const response: Record<string, unknown> = {
      delta,
      ...(singleVersionHint ? { hint: singleVersionHint } : {}),
      amplifiers,
      ...(nextCursor && continuationArgs
        ? {
            cursor: nextCursor,
            hasMore: true,
            nextAction: {
              action: "sdl.delta.get",
              args: continuationArgs,
            },
          }
        : {}),
    };
    return attachRawContext(response, { fileIds }) as DeltaGetResponse;
  };

  if (isTracingEnabled()) {
    const attrs: SpanAttributes = {
      repoId: validated.repoId,
      versionId: `${validated.fromVersion}..${validated.toVersion}`,
      budget: validated.budget ?? {},
    };
    return withSpan(
      SPAN_NAMES.DELTA_GET,
      async (span) => {
        const result = await executeDelta();
        span.setAttributes({
          "counts.changedSymbols": result.delta.changedSymbols.length,
          "counts.blastRadius": result.delta.blastRadius.length,
        });
        return result;
      },
      attrs,
    );
  }

  return executeDelta();
}
