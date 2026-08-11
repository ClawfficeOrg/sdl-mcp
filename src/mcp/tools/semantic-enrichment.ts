import type { ToolContext } from "../../server.js";
import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  refreshSemanticEnrichment,
  getSemanticEnrichmentStatus,
  type SemanticEnrichmentStatusResult,
} from "../../semantic/enrichment.js";
import type { PersistedSemanticProviderRun } from "../../semantic/types.js";
import { projectSemanticEnrichmentStatusForAgent } from "../response-projection/projectors/status.js";
import {
  SemanticEnrichmentRefreshRequestSchema,
  SemanticEnrichmentStatusRequestSchema,
} from "../tools.js";

const DEFAULT_SEMANTIC_STATUS_LIMIT = 5;

export async function handleSemanticEnrichmentRefresh(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = parseActionHandlerArgs(
    SemanticEnrichmentRefreshRequestSchema,
    args,
  );
  return refreshSemanticEnrichment(request, loadConfig());
}

type ProjectedSemanticEnrichmentRun = Omit<
  PersistedSemanticProviderRun,
  "precisionScore"
> & {
  precisionScore?: number;
  precisionMeasurement: "unavailable" | "measured";
  precisionBasis?: "operational-composite";
};

type ProjectedSemanticEnrichmentStatusResult = Omit<
  SemanticEnrichmentStatusResult,
  "lastRuns"
> & {
  lastRuns: ProjectedSemanticEnrichmentRun[];
};

export function projectSemanticEnrichmentRun(
  run: PersistedSemanticProviderRun,
): ProjectedSemanticEnrichmentRun {
  const {
    precisionScore,
    cacheHit,
    canAffectPass2,
    selected,
    metadataJson,
    error,
    ...beforePrecision
  } = run;
  const measurement =
    precisionScore === undefined
      ? { precisionMeasurement: "unavailable" as const }
      : {
          precisionScore,
          precisionMeasurement: "measured" as const,
          precisionBasis: "operational-composite" as const,
        };

  return {
    ...beforePrecision,
    ...measurement,
    ...(cacheHit === undefined ? {} : { cacheHit }),
    ...(canAffectPass2 === undefined ? {} : { canAffectPass2 }),
    ...(selected === undefined ? {} : { selected }),
    ...(metadataJson === undefined ? {} : { metadataJson }),
    ...(error === undefined ? {} : { error }),
  };
}

export function compactSemanticEnrichmentStatusForAgent(
  result: ProjectedSemanticEnrichmentStatusResult,
  limit = DEFAULT_SEMANTIC_STATUS_LIMIT,
): Record<string, unknown> {
  return projectSemanticEnrichmentStatusForAgent(result, limit);
}

export async function handleSemanticEnrichmentStatus(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = parseActionHandlerArgs(
    SemanticEnrichmentStatusRequestSchema,
    args,
  );
  const status = await getSemanticEnrichmentStatus(request, loadConfig());
  const projectedStatus = {
    ...status,
    lastRuns: status.lastRuns.map(projectSemanticEnrichmentRun),
  };
  return projectedStatus;
}
