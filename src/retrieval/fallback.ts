/**
 * Retrieval fallback and health checking.
 *
 * Provides capability detection for the retrieval subsystem and the
 * decision logic that determines whether the hybrid pipeline can run
 * or the system should fall back to the legacy search path.
 */

import { getLadybugConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import { loadConfig } from "../config/loadConfig.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import type { RetrievalCapabilities, DegradationReason } from "./types.js";
import { checkRetrievalHealth as checkStrictRetrievalHealth } from "./health.js";
/** Build structured degradation reasons from index health data. */
function buildDegradationReasons(
  health: {
    fts: { exists: boolean; healthy: boolean };
    vectors: Array<{ model: string; exists: boolean; healthy: boolean }>;
  },
  caps: { fts: boolean; vector: boolean },
): DegradationReason[] {
  const reasons: DegradationReason[] = [];
  if (!caps.fts) {
    reasons.push({ code: "fts-extension-unavailable", message: "FTS extension not loaded", affects: "fts" });
  } else if (!health.fts.exists) {
    reasons.push({ code: "fts-index-missing", message: "FTS index not found in database", affects: "fts" });
  } else if (!health.fts.healthy) {
    reasons.push({ code: "fts-index-missing", message: "FTS index is present but not healthy", affects: "fts" });
  }
  if (!caps.vector) {
    reasons.push({ code: "vector-extension-unavailable", message: "Vector extension not loaded", affects: "vector" });
  } else {
    for (const v of health.vectors) {
      if (!v.exists) {
        reasons.push({ code: "vector-index-missing", message: "Vector index missing for model " + v.model, affects: "vector" });
      } else if (!v.healthy) {
        reasons.push({ code: "vector-index-missing", message: "Vector index is present but not healthy for model " + v.model, affects: "vector" });
      }
    }
  }
  return reasons;
}

export function buildRetrievalCapabilitiesFromIndexHealth(
  health: {
    fts: { exists: boolean; healthy: boolean };
    vectors: Array<{ model: string; exists: boolean; healthy: boolean }>;
  },
  caps: { fts: boolean; vector: boolean },
): RetrievalCapabilities {
  let vectorNomic = false;
  let vectorJinaCode = false;

  for (const vector of health.vectors) {
    if (vector.model === "nomic-embed-text-v1.5") {
      vectorNomic = caps.vector && vector.healthy;
    } else if (vector.model === "jina-embeddings-v2-base-code") {
      vectorJinaCode = caps.vector && vector.healthy;
    }
  }

  return {
    fts: caps.fts && health.fts.healthy,
    fileSummaryFts: false,
    vectorNomic,
    vectorJinaCode,
    coveragePermille: {
      symbolVector: 0,
      fileSummaryVector: 0,
    },
    degradationReasons: buildDegradationReasons(health, caps),
  };
}


// ---------------------------------------------------------------------------
// Health / capability detection
// ---------------------------------------------------------------------------

/**
 * Inspect strict retrieval health for the active database and repository.
 *
 * The strict health checker validates the real FTS and vector indexes against
 * the active semantic configuration. If inspection fails, this adapter returns
 * unavailable capabilities with a degradation reason so callers fail closed.
 *
 * @param repoId - Repository ID used for repository-scoped health inspection.
 */
export async function checkRetrievalHealth(
  repoId = "",
): Promise<RetrievalCapabilities> {
  try {
    const conn = await getLadybugConn();
    return await checkStrictRetrievalHealth(conn, repoId, loadConfig().semantic);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[retrieval] strict health admission failed: ${message}`);
    return {
      fts: false,
      fileSummaryFts: false,
      vectorNomic: false,
      vectorJinaCode: false,
      coveragePermille: {
        symbolVector: 0,
        fileSummaryVector: 0,
      },
      degradationReasons: [
        { code: "health-check-error", message, affects: "all" },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Fallback decision
// ---------------------------------------------------------------------------

/**
 * Determine whether the system should fall back to the legacy (non-hybrid)
 * search path.
 *
 * Returns `true` (use legacy) when:
 * - The configured mode is explicitly `"legacy"`, OR
 * - The configured mode is `"hybrid"` but the required capabilities are
 *   not available (e.g. FTS extension failed to load).
 *
 * Returns `false` (use hybrid) when mode is `"hybrid"` and at least the
 * FTS capability is present (vector is optional for a degraded hybrid run).
 *
 * When `health` is provided and the configured mode is `"legacy"`, the
 * function can auto-flip to hybrid if infrastructure is healthy (FTS +
 * at least one real-model vector index).
 */
export function shouldFallbackToLegacy(
  caps: RetrievalCapabilities,
  config: SemanticRetrievalConfig,
): boolean {
  // Explicit legacy mode -- always use legacy path.
  if (config.mode === "legacy") {
    return true;
  }

  // Hybrid mode requested but FTS is unavailable or unhealthy -- cannot run the
  // minimum viable hybrid pipeline.
  if (!caps.fts) {
    return true;
  }

  // Hybrid mode with at least FTS available -- proceed with hybrid.
  // (Missing vector backends will simply contribute zero candidates.)
  return false;
}

// ---------------------------------------------------------------------------
// Auto-flip detection for Stage 2
// ---------------------------------------------------------------------------

/**
 * Check whether hybrid retrieval infrastructure is healthy enough to use.
 * Used by Stage 2 start-node resolution to decide between hybrid and legacy paths.
 * Auto-promotes from legacy to hybrid when:
 * - semantic.enabled is true
  * - FTS index is healthy
  * - At least one real-model vector index is healthy
 */
export async function isHybridRetrievalAvailable(
  repoId = "",
  healthFactory: () => Promise<RetrievalCapabilities> = () =>
    checkRetrievalHealth(repoId),
): Promise<boolean> {
  let healthStarted = false;
  try {
    const config = loadConfig();
    const semanticConfig = config.semantic;
    if (!semanticConfig?.enabled) return false;

    const retrievalConfig = semanticConfig.retrieval;

    // Explicit hybrid mode still needs a healthy FTS index; extension-level
    // capability alone can leave the retrieval path pointed at a broken index.
    if (retrievalConfig?.mode === "hybrid") {
      healthStarted = true;
      const health = await healthFactory();
      return health.fts;
    }

    // Legacy mode - auto-promote when infrastructure is healthy.
    healthStarted = true;
    const health = await healthFactory();
    return health.fts && (health.vectorNomic || health.vectorJinaCode);
  } catch (err) {
    if (healthStarted) throw err;
    return false;
  }
}
