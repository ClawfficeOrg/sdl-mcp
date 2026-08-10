import type { z } from "zod";

import {
  AgentFeedbackQueryRequestSchema,
  AgentFeedbackRequestSchema,
  BufferCheckpointRequestSchema,
  BufferPushRequestSchema,
  BufferStatusRequestSchema,
  CodeNeedWindowRequestSchema,
  DeltaGetRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  GetHotPathRequestSchema,
  GetSkeletonRequestSchema,
  IndexRefreshRequestSchema,
  MemoryQueryRequestSchema,
  MemoryRemoveRequestSchema,
  MemoryStoreRequestSchema,
  MemorySurfaceRequestSchema,
  PolicyGetRequestSchema,
  PolicySetRequestSchema,
  PRRiskAnalysisRequestSchema,
  RepoOverviewRequestSchema,
  RepoRegisterRequestSchema,
  RepoStatusRequestSchema,
  RepoUnregisterRequestSchema,
  ResponseGetRequestSchema,
  RuntimeExecuteRequestSchema,
  RuntimeQueryOutputRequestSchema,
  SearchEditRequestSchema,
  SemanticEnrichmentRefreshRequestSchema,
  SemanticEnrichmentStatusRequestSchema,
  SliceBuildRequestSchema,
  SliceRefreshRequestSchema,
  SliceSpilloverGetRequestSchema,
  SymbolEditRequestSchema,
  SymbolGetCardRequestSchema,
  SymbolSearchRequestSchema,
  UsageStatsRequestSchema,
} from "../mcp/tools.js";
import { WORKFLOW_CHILD_ACTION_BINDINGS } from "../mcp/response-projection/registry.js";

import { INTERNAL_TRANSFORMS } from "./transforms.js";
import { WorkflowRequestSchema } from "./types.js";

export interface RecoveryActionDefinition {
  readonly action: string;
  readonly fn: string | null;
  readonly toolName: string | null;
  readonly schema: z.ZodType;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly kind: "gateway" | "internal" | "meta";
}

/**
 * Gateway schemas and workflow bindings share one dependency-light registry so
 * recovery validation never depends on action-catalog import side effects.
 */
export const RECOVERY_GATEWAY_ACTION_SCHEMAS = [
  ["symbol.search", SymbolSearchRequestSchema],
  ["symbol.getCard", SymbolGetCardRequestSchema],
  ["symbol.edit", SymbolEditRequestSchema],
  ["slice.build", SliceBuildRequestSchema],
  ["slice.refresh", SliceRefreshRequestSchema],
  ["slice.spillover.get", SliceSpilloverGetRequestSchema],
  ["delta.get", DeltaGetRequestSchema],
  ["pr.risk.analyze", PRRiskAnalysisRequestSchema],
  ["code.needWindow", CodeNeedWindowRequestSchema],
  ["code.getSkeleton", GetSkeletonRequestSchema],
  ["code.getHotPath", GetHotPathRequestSchema],
  ["repo.register", RepoRegisterRequestSchema],
  ["repo.status", RepoStatusRequestSchema],
  ["repo.unregister", RepoUnregisterRequestSchema],
  ["repo.overview", RepoOverviewRequestSchema],
  ["index.refresh", IndexRefreshRequestSchema],
  ["policy.get", PolicyGetRequestSchema],
  ["policy.set", PolicySetRequestSchema],
  ["usage.stats", UsageStatsRequestSchema],
  ["file.read", FileReadRequestSchema],
  ["file.write", FileWriteRequestSchema],
  ["search.edit", SearchEditRequestSchema],
  ["semantic.enrichment.refresh", SemanticEnrichmentRefreshRequestSchema],
  ["semantic.enrichment.status", SemanticEnrichmentStatusRequestSchema],
  ["agent.feedback", AgentFeedbackRequestSchema],
  ["agent.feedback.query", AgentFeedbackQueryRequestSchema],
  ["buffer.push", BufferPushRequestSchema],
  ["buffer.checkpoint", BufferCheckpointRequestSchema],
  ["buffer.status", BufferStatusRequestSchema],
  ["runtime.execute", RuntimeExecuteRequestSchema],
  ["runtime.queryOutput", RuntimeQueryOutputRequestSchema],
  ["response.get", ResponseGetRequestSchema],
  ["memory.store", MemoryStoreRequestSchema],
  ["memory.query", MemoryQueryRequestSchema],
  ["memory.remove", MemoryRemoveRequestSchema],
  ["memory.surface", MemorySurfaceRequestSchema],
] as const satisfies ReadonlyArray<
  readonly [action: string, schema: z.ZodType]
>;

export const RECOVERY_FN_NAME_MAP: Readonly<Record<string, string>> =
  WORKFLOW_CHILD_ACTION_BINDINGS;

const ACTION_TO_FN: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RECOVERY_FN_NAME_MAP).map(([fn, action]) => [action, fn]),
  ),
);

export const RECOVERY_GATEWAY_ACTION_DEFINITIONS: readonly RecoveryActionDefinition[] =
  Object.freeze(
    RECOVERY_GATEWAY_ACTION_SCHEMAS.map(([action, schema]) =>
      Object.freeze({
        action,
        fn: ACTION_TO_FN[action] ?? null,
        toolName: `sdl.${action}`,
        schema,
        ...(action === "code.getSkeleton"
          ? { aliases: Object.freeze({ filePath: "file" }) }
          : {}),
        kind: "gateway" as const,
      }),
    ),
  );

const INTERNAL_RECOVERY_ACTION_DEFINITIONS: readonly RecoveryActionDefinition[] =
  Object.freeze(
    Object.entries(INTERNAL_TRANSFORMS).map(([fn, transform]) =>
      Object.freeze({
        action: fn,
        fn,
        toolName: null,
        schema: transform.schema,
        kind: "internal" as const,
      }),
    ),
  );

const WORKFLOW_RECOVERY_ACTION_DEFINITION: RecoveryActionDefinition =
  Object.freeze({
    action: "workflow",
    fn: "workflow",
    toolName: "sdl.workflow",
    schema: WorkflowRequestSchema,
    kind: "meta",
  });

const RECOVERY_ACTION_DEFINITION_BY_ACTION: Readonly<
  Record<string, RecoveryActionDefinition>
> = Object.freeze(
  Object.fromEntries(
    [
      ...RECOVERY_GATEWAY_ACTION_DEFINITIONS,
      ...INTERNAL_RECOVERY_ACTION_DEFINITIONS,
      WORKFLOW_RECOVERY_ACTION_DEFINITION,
    ].map((definition) => [definition.action, definition]),
  ),
);

/** Resolve canonical, flat-tool, and workflow-fn names without load-order state. */
export function resolveRecoveryActionDefinition(
  actionOrToolName: string,
): RecoveryActionDefinition | undefined {
  const unprefixed = actionOrToolName.startsWith("sdl.")
    ? actionOrToolName.slice("sdl.".length)
    : actionOrToolName;
  const action = Object.hasOwn(RECOVERY_FN_NAME_MAP, unprefixed)
    ? RECOVERY_FN_NAME_MAP[unprefixed]
    : unprefixed;
  return Object.hasOwn(RECOVERY_ACTION_DEFINITION_BY_ACTION, action)
    ? RECOVERY_ACTION_DEFINITION_BY_ACTION[action]
    : undefined;
}

/** Return only function names present in the active workflow dispatch maps. */
export function resolveRecoveryWorkflowFunction(
  actionOrToolName: string,
): string | undefined {
  const definition = resolveRecoveryActionDefinition(actionOrToolName);
  if (!definition?.fn) return undefined;

  if (definition.kind === "gateway") {
    return RECOVERY_FN_NAME_MAP[definition.fn] === definition.action
      ? definition.fn
      : undefined;
  }
  if (definition.kind === "internal") {
    return Object.hasOwn(INTERNAL_TRANSFORMS, definition.fn)
      ? definition.fn
      : undefined;
  }
  return undefined;
}
