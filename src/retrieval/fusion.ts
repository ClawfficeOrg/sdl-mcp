// =============================================================================
// retrieval/fusion.ts — Pure RRF fusion + evidence builders.
//
// Public exports:
//   Symbol-level:
//     - SourceRanking, DEFAULT_RRF_K
//     - rrfFuse(rankings, k?, candidateLimit?) — reciprocal-rank fusion
//     - buildEvidence(rankings, fused, fusionLatencyMs, fallbackReason?) — evidence shape
//   Entity-level:
//     - EntitySourceRanking
//     - rrfFuseEntities(...)
//     - buildEntityEvidence(...)
//
// Extracted from retrieval/orchestrator.ts. All helpers are pure (no I/O).
// =============================================================================

import type {
  RetrievalSource,
  RetrievalEvidence,
  HybridSearchResultItem,
  EntitySearchResultItem,
  EntityType,
} from "./types.js";

export interface SourceRanking {
  source: RetrievalSource;
  /** symbolId -> 1-based rank */
  ranks: Map<string, number>;
  candidateCount: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RRF_K = 60;


export type FusionSourceKind =
  | "exactIdentifier"
  | "fts"
  | "vector"
  | "legacyFallback"
  | "overlay";

/** Context-only fusion route; public retrieval evidence remains unchanged. */
export type ContextCandidateSource = RetrievalSource | "exactIdentifier";

export interface FusionWeights {
  fts: number;
  vector: number;
  legacyFallback: number;
  overlay: number;
}


/** Scale only the logical vector lane; fusion renormalizes lanes that are present. */
export function coverageAdjustedFusionWeights(
  weights: Readonly<FusionWeights>,
  coveragePermille: number,
): FusionWeights {
  const boundedCoverage = Number.isFinite(coveragePermille)
    ? Math.max(0, Math.min(1000, coveragePermille))
    : 0;
  return {
    ...weights,
    vector: (weights.vector * boundedCoverage) / 1000,
  };
}
export interface FusionOptions {
  weights?: Readonly<FusionWeights>;
  pinnedIds?: readonly string[];
}

export interface EntityFusionOptions {
  weights?: Readonly<FusionWeights>;
  pinnedItems?: ReadonlyArray<{
    entityType: EntityType;
    entityId: string;
  }>;
}

export type SourceRanks = Partial<Record<RetrievalSource, number>>;
export type ContextSourceRanks = Partial<
  Record<ContextCandidateSource, number>
>;
interface FusibleRanking<Source extends ContextCandidateSource> {
  source: Source;
  ranks: Map<string, number>;
}
interface Candidate<Source extends ContextCandidateSource> {
  score: number;
  bestContribution: number;
  bestSource?: Source;
  sourceRanks: Map<Source, number>;
  pinned: boolean;
}

const SOURCE_KIND_ORDER: readonly FusionSourceKind[] = [
  "exactIdentifier",
  "fts",
  "vector",
  "overlay",
  "legacyFallback",
];
const SCORE_QUANTIZATION = 1_000_000_000_000;
const DEFAULT_PINNED_FUSION_SOURCE = "fts" as const;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceKind(source: ContextCandidateSource): FusionSourceKind {
  if (
    source === "exactIdentifier" ||
    source === "fts" ||
    source === "legacyFallback" ||
    source === "overlay"
  ) {
    return source;
  }
  return "vector";
}

function quantizeScore(score: number): number {
  return Math.round(score * SCORE_QUANTIZATION);
}

function fuseRankings<Source extends ContextCandidateSource>(
  rankings: FusibleRanking<Source>[],
  k: number,
  limit: number,
  weights: Readonly<FusionWeights> | undefined,
  pinnedKeys: readonly string[],
): Array<{
  key: string;
  score: number;
  source: Source | "fts";
  sourceRanks: Partial<Record<Source, number>>;
}> {
  const candidates = new Map<string, Candidate<Source>>();
  const getCandidate = (key: string): Candidate<Source> => {
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = {
        score: 0,
        bestContribution: 0,
        sourceRanks: new Map(),
        pinned: false,
      };
      candidates.set(key, candidate);
    }
    return candidate;
  };

  for (const key of new Set(pinnedKeys)) getCandidate(key).pinned = true;

  const lanes = new Map<FusionSourceKind, FusibleRanking<Source>[]>();
  for (const ranking of rankings) {
    if (ranking.ranks.size === 0) continue;
    const kind = sourceKind(ranking.source);
    const lane = lanes.get(kind) ?? [];
    lane.push(ranking);
    lanes.set(kind, lane);
  }
  const presentKinds = SOURCE_KIND_ORDER.filter((kind) => lanes.has(kind));
  const laneWeights = new Map(
    presentKinds.map(
      (kind) =>
        [
          kind,
          kind === "exactIdentifier" ? 1 : (weights?.[kind] ?? 1),
        ] as const,
    ),
  );
  const totalWeight = Array.from(laneWeights.values()).reduce(
    (sum, weight) => sum + weight,
    0,
  );

  for (const kind of presentKinds) {
    const bestRanks = new Map<
      string,
      { rank: number; source: Source }
    >();
    const laneRankings = [...(lanes.get(kind) ?? [])].sort((a, b) =>
      compareText(a.source, b.source),
    );
    for (const ranking of laneRankings) {
      for (const [key, rank] of ranking.ranks) {
        const candidate = getCandidate(key);
        const sourceRank = candidate.sourceRanks.get(ranking.source);
        if (sourceRank === undefined || rank < sourceRank) {
          candidate.sourceRanks.set(ranking.source, rank);
        }
        const previous = bestRanks.get(key);
        if (
          !previous ||
          rank < previous.rank ||
          (rank === previous.rank &&
            compareText(ranking.source, previous.source) < 0)
        ) {
          bestRanks.set(key, { rank, source: ranking.source });
        }
      }
    }

    const laneWeight =
      totalWeight > 0
        ? (laneWeights.get(kind) ?? 0) / totalWeight
        : 1 / presentKinds.length;
    for (const [key, best] of bestRanks) {
      const candidate = getCandidate(key);
      const contribution = laneWeight / (k + best.rank);
      candidate.score += contribution;
      const contributionOrder =
        quantizeScore(contribution) - quantizeScore(candidate.bestContribution);
      if (
        contributionOrder > 0 ||
        (contributionOrder === 0 &&
          (candidate.bestSource === undefined ||
            compareText(best.source, candidate.bestSource) < 0))
      ) {
        candidate.bestContribution = contribution;
        candidate.bestSource = best.source;
      }
    }
  }

  return Array.from(candidates, ([key, candidate]) => ({
    key,
    score: candidate.score,
    source: candidate.bestSource ?? DEFAULT_PINNED_FUSION_SOURCE,
    sourceRanks: Object.fromEntries(
      [...candidate.sourceRanks].sort(([a], [b]) => compareText(a, b)),
    ) as Partial<Record<Source, number>>,
    pinned: candidate.pinned,
  }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        quantizeScore(b.score) - quantizeScore(a.score) ||
        compareText(a.key, b.key),
    )
    .slice(0, limit);
}
export function rrfFuse(
  rankings: SourceRanking[],
  k: number,
  limit: number,
  options: FusionOptions = {},
): HybridSearchResultItem[] {
  return fuseRankings(
    rankings,
    k,
    limit,
    options.weights,
    options.pinnedIds ?? [],
  ).map(({ key, score, source, sourceRanks }) => ({
    symbolId: key,
    score,
    source,
    sourceRanks,
  }));
}

// ---------------------------------------------------------------------------
// Evidence builder
// ---------------------------------------------------------------------------

export function buildEvidence(
  rankings: SourceRanking[],
  fusedResults: HybridSearchResultItem[],
  fusionLatencyMs: number,
  fallbackReason?: string,
): RetrievalEvidence {
  const sources: RetrievalSource[] = rankings.map((r) => r.source);
  const candidateCountPerSource: Record<string, number> = {};
  for (const r of rankings) {
    candidateCountPerSource[r.source] = r.candidateCount;
  }

  // For each source, find the 1-based positions in the fused list where
  // that source's candidates appear.
  const topRanksPerSource: Record<string, number[]> = {};
  for (const ranking of rankings) {
    const positions: number[] = [];
    for (let i = 0; i < fusedResults.length; i++) {
      if (ranking.ranks.has(fusedResults[i].symbolId)) {
        positions.push(i + 1); // 1-based
      }
    }
    topRanksPerSource[ranking.source] = positions;
  }

  return {
    sources,
    topRanksPerSource,
    candidateCountPerSource,
    fusionLatencyMs,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface EntitySourceRanking {
  source: RetrievalSource;
  entityType: EntityType;
  /** entityId -> 1-based rank */
  ranks: Map<string, number>;
  candidateCount: number;
}

export interface ContextEntitySourceRanking {
  source: ContextCandidateSource;
  entityType: EntityType;
  /** entityId -> 1-based rank */
  ranks: Map<string, number>;
  candidateCount: number;
}

export interface ContextCandidateProvenance {
  symbol?: ContextSourceRanks;
  fileSummary?: ContextSourceRanks;
}

export interface ContextCandidateFusionItem {
  symbolId: string;
  score: number;
  source: ContextCandidateSource;
  sourceRanks: ContextSourceRanks;
  provenance: ContextCandidateProvenance;
}

export interface ContextCandidateFusionOptions {
  weights: Readonly<FusionWeights>;
  coveragePermille: {
    symbolVector: number;
    fileSummaryVector: number;
  };
  pinnedIds?: readonly string[];
}

function setMinimumSourceRank(
  ranks: Map<ContextCandidateSource, number>,
  source: ContextCandidateSource,
  rank: number,
): void {
  const current = ranks.get(source);
  if (current === undefined || rank < current) ranks.set(source, rank);
}

function orderedSourceRanks(
  ranks: ReadonlyMap<ContextCandidateSource, number>,
): ContextSourceRanks {
  return Object.fromEntries(
    [...ranks].sort(([left], [right]) => compareText(left, right)),
  ) as ContextSourceRanks;
}

/**
 * Map FileSummary source rankings onto their bounded owning symbols, then run
 * one weighted/collapsed symbol fusion. Route-specific provenance is retained
 * alongside the canonical per-source minimum ranks.
 */
export function rrfFuseContextCandidates(
  rankings: ContextEntitySourceRanking[],
  symbolIdsByFileId: ReadonlyMap<string, readonly string[]>,
  k: number,
  limit: number,
  options: ContextCandidateFusionOptions,
): ContextCandidateFusionItem[] {
  const provenance = new Map<
    string,
    {
      symbol: Map<ContextCandidateSource, number>;
      fileSummary: Map<ContextCandidateSource, number>;
    }
  >();
  const mappedRankings: Array<
    FusibleRanking<ContextCandidateSource> & { candidateCount: number }
  > = [];

  const getProvenance = (symbolId: string) => {
    let item = provenance.get(symbolId);
    if (!item) {
      item = { symbol: new Map(), fileSummary: new Map() };
      provenance.set(symbolId, item);
    }
    return item;
  };

  for (const ranking of rankings) {
    if (
      ranking.entityType !== "symbol" &&
      ranking.entityType !== "fileSummary"
    ) {
      continue;
    }
    const mappedRanks = new Map<string, number>();
    const orderedEntries = [...ranking.ranks].sort(
      ([leftId, leftRank], [rightId, rightRank]) =>
        leftRank - rightRank || compareText(leftId, rightId),
    );
    for (const [entityId, rank] of orderedEntries) {
      const symbolIds =
        ranking.entityType === "symbol"
          ? [entityId]
          : [
              ...new Set(symbolIdsByFileId.get(entityId) ?? []),
            ].sort(compareText);
      for (const symbolId of symbolIds) {
        const current = mappedRanks.get(symbolId);
        if (current === undefined || rank < current) {
          mappedRanks.set(symbolId, rank);
        }
        const route = getProvenance(symbolId)[ranking.entityType];
        setMinimumSourceRank(route, ranking.source, rank);
      }
    }
    mappedRankings.push({
      source: ranking.source,
      ranks: mappedRanks,
      candidateCount: mappedRanks.size,
    });
  }

  const activeVectorCoverage = [
    ...(rankings.some(
      (ranking) =>
        ranking.entityType === "symbol" &&
        ranking.source.startsWith("vector:") &&
        ranking.ranks.size > 0,
    )
      ? [options.coveragePermille.symbolVector]
      : []),
    ...(rankings.some(
      (ranking) =>
        ranking.entityType === "fileSummary" &&
        ranking.source.startsWith("vector:") &&
        ranking.ranks.size > 0,
    )
      ? [options.coveragePermille.fileSummaryVector]
      : []),
  ];
  const vectorCoveragePermille =
    activeVectorCoverage.length > 0
      ? Math.min(...activeVectorCoverage)
      : 1000;
  const fused = fuseRankings(
    mappedRankings,
    k,
    limit,
    coverageAdjustedFusionWeights(
      options.weights,
      vectorCoveragePermille,
    ),
    options.pinnedIds ?? [],
  ).map(({ key, score, source, sourceRanks }) => ({
    symbolId: key,
    score,
    source,
    sourceRanks,
  }));

  return fused.map((item) => {
    const routes = provenance.get(item.symbolId);
    return {
      ...item,
      provenance: {
        ...(routes && routes.symbol.size > 0
          ? { symbol: orderedSourceRanks(routes.symbol) }
          : {}),
        ...(routes && routes.fileSummary.size > 0
          ? {
              fileSummary: orderedSourceRanks(
                routes.fileSummary,
              ),
            }
          : {}),
      },
    };
  });
}

/**
 * RRF fusion for multi-entity results.
 *
 * Identical algorithm to rrfFuse() but operates on EntitySourceRanking and
 * returns EntitySearchResultItem[].  The entity-type tag from the ranking
 * that contributed the best score is carried forward into the result.
 */

export function rrfFuseEntities(
  rankings: EntitySourceRanking[],
  k: number,
  limit: number,
  options: EntityFusionOptions = {},
): EntitySearchResultItem[] {
  const entities = new Map<
    string,
    { entityType: EntityType; entityId: string }
  >();
  const keyedRankings = rankings.map((ranking) => {
    const ranks = new Map<string, number>();
    for (const [entityId, rank] of ranking.ranks) {
      const key = JSON.stringify([entityId, ranking.entityType]);
      entities.set(key, { entityType: ranking.entityType, entityId });
      ranks.set(key, rank);
    }
    return { source: ranking.source, ranks };
  });
  const pinnedKeys = (options.pinnedItems ?? []).map((item) => {
    const key = JSON.stringify([item.entityId, item.entityType]);
    entities.set(key, item);
    return key;
  });

  return fuseRankings(
    keyedRankings,
    k,
    limit,
    options.weights,
    pinnedKeys,
  ).map(({ key, score, source, sourceRanks }) => {
    const entity = entities.get(key) ?? {
      entityType: "symbol" as const,
      entityId: key,
    };
    return {
      ...entity,
      score,
      source,
      sourceRanks,
    };
  });
}

/**
 * Build evidence for entity search — parallel to buildEvidence() but uses
 * entityId as the key to look up ranks in each source ranking.
 */

export function buildEntityEvidence(
  rankings: EntitySourceRanking[],
  fusedResults: EntitySearchResultItem[],
  fusionLatencyMs: number,
  fallbackReason?: string,
): RetrievalEvidence {
  const orderedRankings = [...rankings].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.entityType.localeCompare(b.entityType),
  );
  const sources = Array.from(
    new Set(orderedRankings.map((ranking) => ranking.source)),
  );
  const candidateCountPerSource: Record<string, number> = {};
  for (const ranking of orderedRankings) {
    // Candidate counts remain source-kind aggregates for public diagnostics.
    candidateCountPerSource[ranking.source] =
      (candidateCountPerSource[ranking.source] ?? 0) +
      ranking.candidateCount;
  }

  const topRanksPerSource: Record<string, number[]> = {};
  for (const ranking of orderedRankings) {
    const evidenceKey = `${ranking.source}:${ranking.entityType}`;
    const positions: number[] = [];
    for (let i = 0; i < fusedResults.length; i++) {
      const result = fusedResults[i];
      if (
        result.entityType === ranking.entityType &&
        ranking.ranks.has(result.entityId)
      ) {
        positions.push(i + 1); // 1-based
      }
    }
    topRanksPerSource[evidenceKey] = Array.from(
      new Set([...(topRanksPerSource[evidenceKey] ?? []), ...positions]),
    ).sort((a, b) => a - b);
  }

  return {
    sources,
    topRanksPerSource,
    candidateCountPerSource,
    fusionLatencyMs,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

/**
 * Multi-entity hybrid search.
 *
 * Runs FTS and (where available) vector search across the requested entity
 * types (Symbol, Memory, Cluster, Process, FileSummary), then fuses results
 * via Reciprocal Rank Fusion.  Degrades gracefully when individual backends
 * are unavailable — a failing FTS/vector query for one entity type is caught
 * and skipped without aborting the rest of the search.
 *
 * Backward-compatible note: `entitySearch({ entityTypes: ["symbol"] })`
 * produces equivalent results to `hybridSearch()` for the symbol dimension.
 */
