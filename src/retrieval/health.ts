import type { Connection } from "kuzu";

import type { SemanticConfig } from "../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { getExtensionCapabilities } from "../db/extension-caps.js";
import { toNumber } from "../db/ladybug-core.js";
import {
  getFileSummaryRetrievalCoverage,
  getSymbolRetrievalCoverage,
} from "../db/ladybug-retrieval-health.js";
import { logger } from "../util/logger.js";
import {
  ENTITY_FTS_INDEX_NAMES,
  FILESUMMARY_EMBEDDING_PROPERTIES,
  FILESUMMARY_VECTOR_INDEX_NAMES,
  SYMBOL_FTS_INDEX_NAME,
  showIndexesStrict,
  type IndexInfo,
} from "./index-lifecycle.js";
import { getVecPropertyName, getVectorIndexName } from "./model-mapping.js";
import type {
  DegradationReason,
  RetrievalCapabilities,
} from "./types.js";

export interface RequiredRetrievalIndex {
  model?: string;
  tableName: "Symbol" | "FileSummary";
  name: string;
  type: IndexInfo["type"];
  property: string;
}

export interface RequiredRetrievalIndexes {
  symbolFts: RequiredRetrievalIndex;
  fileSummaryFts: RequiredRetrievalIndex;
  symbolVectors: RequiredRetrievalIndex[];
  fileSummaryVectors: RequiredRetrievalIndex[];
}

export interface CoverageCount {
  eligible: unknown;
  covered: unknown;
  indexHealthy: boolean;
}

/** Resolve the exact indexes required by the active semantic model plan. */
export function resolveRequiredRetrievalIndexes(
  semanticConfig: SemanticConfig | undefined,
): RequiredRetrievalIndexes {
  const plan = resolveSemanticEmbeddingModelPlan(semanticConfig);

  return {
    symbolFts: {
      tableName: "Symbol",
      name: SYMBOL_FTS_INDEX_NAME,
      type: "fts",
      property: "searchText",
    },
    fileSummaryFts: {
      tableName: "FileSummary",
      name: ENTITY_FTS_INDEX_NAMES.fileSummary,
      type: "fts",
      property: "searchText",
    },
    symbolVectors: plan.symbolEmbeddingModels.flatMap((model) => {
      const property = getVecPropertyName(model);
      const name = getVectorIndexName(model);
      return property && name
        ? [{ model, tableName: "Symbol" as const, name, type: "vector" as const, property }]
        : [];
    }),
    fileSummaryVectors: plan.fileSummaryEmbeddingModels.flatMap((model) => {
      const property = getVecPropertyName(model);
      const name = getFileSummaryVectorIndexName(property);
      return property && name
        ? [{ model, tableName: "FileSummary" as const, name, type: "vector" as const, property }]
        : [];
    }),
  };
}

/** Match every index identity field and reject unhealthy or unloaded rows. */
export function hasExactHealthyIndex(
  indexes: readonly IndexInfo[],
  required: RequiredRetrievalIndex,
): boolean {
  return indexes.some(
    (index) =>
      index.tableName === required.tableName &&
      index.name === required.name &&
      index.type === required.type &&
      index.property === required.property &&
      index.status === "healthy" &&
      index.extensionLoaded !== false,
  );
}

/** Aggregate model rows into one logical source before one permille rounding. */
export function aggregateCoveragePermille(
  rows: readonly CoverageCount[],
): number {
  let eligible = 0;
  let covered = 0;

  for (const row of rows) {
    const rowEligible = Math.max(0, toNumber(row.eligible));
    const rowCovered = Math.max(0, toNumber(row.covered));
    eligible += rowEligible;
    covered += row.indexHealthy ? Math.min(rowEligible, rowCovered) : 0;
  }

  return eligible === 0
    ? 1000
    : Math.round((covered * 1000) / eligible);
}

/**
 * Inspect retrieval indexes and repo-scoped embedding coverage.
 *
 * The caller owns connection admission. Any inspection failure stays unavailable;
 * extension availability alone never promotes a retrieval capability.
 */
export async function checkRetrievalHealth(
  conn: Connection,
  repoId: string,
  semanticConfig: SemanticConfig | undefined,
): Promise<RetrievalCapabilities> {
  try {
    const indexes = await showIndexesStrict(conn);
    const extensions = getExtensionCapabilities();
    const required = resolveRequiredRetrievalIndexes(semanticConfig);

    const symbolFts = extensions.fts && hasExactHealthyIndex(indexes, required.symbolFts);
    const fileSummaryFts =
      extensions.fts && hasExactHealthyIndex(indexes, required.fileSummaryFts);

    const symbolRows = await Promise.all(
      required.symbolVectors.map(async (index) => ({
        ...(await getSymbolRetrievalCoverage(conn, repoId, index.property)),
        indexHealthy:
          extensions.vector && hasExactHealthyIndex(indexes, index),
      })),
    );
    const fileSummaryRows = await Promise.all(
      required.fileSummaryVectors.map(async (index) => ({
        ...(await getFileSummaryRetrievalCoverage(conn, repoId, index.property)),
        indexHealthy:
          extensions.vector && hasExactHealthyIndex(indexes, index),
      })),
    );

    const healthySymbolModels = new Set(
      required.symbolVectors
        .filter(
          (index) => extensions.vector && hasExactHealthyIndex(indexes, index),
        )
        .map((index) => index.model),
    );
    const degradationReasons = buildDegradationReasons(
      extensions,
      required,
      indexes,
    );

    return {
      fts: symbolFts,
      fileSummaryFts,
      vectorNomic: healthySymbolModels.has("nomic-embed-text-v1.5"),
      vectorJinaCode: healthySymbolModels.has("jina-embeddings-v2-base-code"),
      coveragePermille: {
        symbolVector: aggregateCoveragePermille(symbolRows),
        fileSummaryVector: aggregateCoveragePermille(fileSummaryRows),
      },
      degradationReasons,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[retrieval] strict health check failed: ${message}`);
    return unavailableCapabilities({
      code: "health-check-error",
      message,
      affects: "all",
    });
  }
}

function getFileSummaryVectorIndexName(property: string | null): string | null {
  if (property === FILESUMMARY_EMBEDDING_PROPERTIES.jinaCode.property) {
    return FILESUMMARY_VECTOR_INDEX_NAMES.jinaCode;
  }
  if (property === FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property) {
    return FILESUMMARY_VECTOR_INDEX_NAMES.nomic;
  }
  return null;
}

function buildDegradationReasons(
  extensions: { fts: boolean; vector: boolean },
  required: RequiredRetrievalIndexes,
  indexes: readonly IndexInfo[],
): DegradationReason[] {
  const reasons: DegradationReason[] = [];
  if (!extensions.fts) {
    reasons.push({
      code: "fts-extension-unavailable",
      message: "FTS extension not loaded",
      affects: "fts",
    });
  } else if (
    !hasExactHealthyIndex(indexes, required.symbolFts) ||
    !hasExactHealthyIndex(indexes, required.fileSummaryFts)
  ) {
    reasons.push({
      code: "fts-index-missing",
      message: "Required retrieval FTS index is missing or unhealthy",
      affects: "fts",
    });
  }

  if (!extensions.vector) {
    reasons.push({
      code: "vector-extension-unavailable",
      message: "Vector extension not loaded",
      affects: "vector",
    });
  }
  for (const index of [
    ...required.symbolVectors,
    ...required.fileSummaryVectors,
  ]) {
    if (!hasExactHealthyIndex(indexes, index)) {
      reasons.push({
        code: "vector-index-missing",
        message: `Required vector index is missing or unhealthy: ${index.name}`,
        affects: "vector",
      });
    }
  }
  return reasons;
}

function unavailableCapabilities(
  reason: DegradationReason,
): RetrievalCapabilities {
  return {
    fts: false,
    fileSummaryFts: false,
    vectorNomic: false,
    vectorJinaCode: false,
    coveragePermille: {
      symbolVector: 0,
      fileSummaryVector: 0,
    },
    degradationReasons: [reason],
  };
}
