import type { ProjectionProfile } from "./types.js";

/**
 * Canonical actions that can reach a model through the flat MCP, Code Mode,
 * or workflow-child surfaces. This policy inventory deliberately imports no
 * tool handlers.
 */
export const PROJECTION_PROFILE_ACTIONS = [
  "symbol.search",
  "symbol.getCard",
  "symbol.edit",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "delta.get",
  "pr.risk.analyze",
  "code.needWindow",
  "code.getSkeleton",
  "code.getHotPath",
  "repo.register",
  "repo.status",
  "repo.unregister",
  "repo.overview",
  "index.refresh",
  "policy.get",
  "policy.set",
  "usage.stats",
  "file.read",
  "file.write",
  "search.edit",
  "semantic.enrichment.refresh",
  "semantic.enrichment.status",
  "agent.feedback",
  "agent.feedback.query",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "runtime.execute",
  "runtime.queryOutput",
  "response.get",
  "memory.store",
  "memory.query",
  "memory.remove",
  "memory.surface",
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
  "workflowContinuationGet",
  "action.search",
  "info",
  "manual",
  "context",
  "file",
  "retrieve",
  "workflow",
] as const;

export type ProjectionAction = (typeof PROJECTION_PROFILE_ACTIONS)[number];
export type ProjectionProfileEntry = readonly [
  ProjectionAction,
  Readonly<ProjectionProfile>,
];

function profile(
  projector: string,
  budgetClass: ProjectionProfile["budgetClass"],
  largeResponseStrategy: ProjectionProfile["largeResponseStrategy"],
  recoveryPolicy: ProjectionProfile["recoveryPolicy"],
  observabilityProfile: string,
): Readonly<ProjectionProfile> {
  return Object.freeze({
    projector,
    observabilityProfile,
    defaultDetail: "compact",
    budgetClass,
    largeResponseStrategy,
    recoveryPolicy,
  });
}

const COMPACT_PROFILE = profile(
  "generic",
  "compact",
  "truncate",
  "none",
  "standard",
);
const SMALL_PROFILE = profile(
  "generic",
  "small",
  "truncate",
  "none",
  "standard",
);
const STATUS_PROFILE = profile(
  "generic",
  "small",
  "truncate",
  "none",
  "status",
);
const MUTATION_PROFILE = profile(
  "generic",
  "compact",
  "truncate",
  "none",
  "mutation",
);
const ARTIFACT_PROFILE = profile(
  "generic",
  "standard",
  "artifact",
  "on-truncation",
  "standard",
);
const MUTATING_ARTIFACT_PROFILE = profile(
  "generic",
  "standard",
  "artifact",
  "on-truncation",
  "mutation",
);
const ACTION_SEARCH_PROFILE = profile(
  "actionSearch",
  "compact",
  "truncate",
  "none",
  "standard",
);
const REPO_STATUS_PROFILE = profile(
  "repoStatus",
  "compact",
  "truncate",
  "none",
  "status",
);
const USAGE_PROFILE = profile(
  "usage",
  "compact",
  "truncate",
  "none",
  "usage",
);
const WORKFLOW_PROFILE = profile(
  "workflow",
  "standard",
  "artifact",
  "on-truncation",
  "workflow",
);

const PROFILE_ENTRIES = [
  ["symbol.search", ARTIFACT_PROFILE],
  ["symbol.getCard", COMPACT_PROFILE],
  ["symbol.edit", MUTATION_PROFILE],
  ["slice.build", ARTIFACT_PROFILE],
  ["slice.refresh", ARTIFACT_PROFILE],
  ["slice.spillover.get", ARTIFACT_PROFILE],
  ["delta.get", ARTIFACT_PROFILE],
  ["pr.risk.analyze", ARTIFACT_PROFILE],
  ["code.needWindow", ARTIFACT_PROFILE],
  ["code.getSkeleton", ARTIFACT_PROFILE],
  ["code.getHotPath", ARTIFACT_PROFILE],
  ["repo.register", MUTATION_PROFILE],
  ["repo.status", REPO_STATUS_PROFILE],
  ["repo.unregister", MUTATION_PROFILE],
  ["repo.overview", COMPACT_PROFILE],
  ["index.refresh", MUTATION_PROFILE],
  ["policy.get", SMALL_PROFILE],
  ["policy.set", MUTATION_PROFILE],
  ["usage.stats", USAGE_PROFILE],
  ["file.read", ARTIFACT_PROFILE],
  ["file.write", MUTATION_PROFILE],
  ["search.edit", MUTATING_ARTIFACT_PROFILE],
  ["semantic.enrichment.refresh", MUTATION_PROFILE],
  ["semantic.enrichment.status", STATUS_PROFILE],
  ["agent.feedback", MUTATION_PROFILE],
  ["agent.feedback.query", COMPACT_PROFILE],
  ["buffer.push", MUTATION_PROFILE],
  ["buffer.checkpoint", MUTATION_PROFILE],
  ["buffer.status", STATUS_PROFILE],
  ["runtime.execute", ARTIFACT_PROFILE],
  ["runtime.queryOutput", ARTIFACT_PROFILE],
  ["response.get", ARTIFACT_PROFILE],
  ["memory.store", MUTATION_PROFILE],
  ["memory.query", COMPACT_PROFILE],
  ["memory.remove", MUTATION_PROFILE],
  ["memory.surface", MUTATION_PROFILE],
  ["dataPick", COMPACT_PROFILE],
  ["dataMap", COMPACT_PROFILE],
  ["dataFilter", COMPACT_PROFILE],
  ["dataSort", COMPACT_PROFILE],
  ["dataTemplate", COMPACT_PROFILE],
  ["workflowContinuationGet", ARTIFACT_PROFILE],
  ["action.search", ACTION_SEARCH_PROFILE],
  ["info", STATUS_PROFILE],
  ["manual", COMPACT_PROFILE],
  ["context", ARTIFACT_PROFILE],
  ["file", MUTATING_ARTIFACT_PROFILE],
  ["retrieve", ARTIFACT_PROFILE],
  ["workflow", WORKFLOW_PROFILE],
] as const satisfies readonly ProjectionProfileEntry[];

/**
 * Build a closed registry. Unknown, duplicate, and missing entries are errors;
 * callers never receive a wildcard or silent generic fallback.
 */
export function createProjectionProfileRegistry(
  entries: readonly (readonly [string, Readonly<ProjectionProfile>])[],
  expectedActions: readonly string[] = PROJECTION_PROFILE_ACTIONS,
): Readonly<Record<string, Readonly<ProjectionProfile>>> {
  const expected = new Set<string>();
  for (const action of expectedActions) {
    if (expected.has(action)) {
      throw new Error(`Duplicate expected projection action: ${action}`);
    }
    expected.add(action);
  }

  const registry: Record<string, Readonly<ProjectionProfile>> = {};
  for (const [action, entryProfile] of entries) {
    if (!expected.has(action)) {
      throw new Error(`Unknown projection profile action: ${action}`);
    }
    if (Object.hasOwn(registry, action)) {
      throw new Error(`Duplicate projection profile action: ${action}`);
    }
    registry[action] = Object.isFrozen(entryProfile)
      ? entryProfile
      : Object.freeze({ ...entryProfile });
  }

  for (const action of expectedActions) {
    if (!Object.hasOwn(registry, action)) {
      throw new Error(`Missing projection profile action: ${action}`);
    }
  }

  return Object.freeze(registry);
}

export const PROJECTION_PROFILE_REGISTRY = createProjectionProfileRegistry(
  PROFILE_ENTRIES,
) as Readonly<Record<ProjectionAction, Readonly<ProjectionProfile>>>;

/** Active workflow aliases are listed explicitly and map to canonical actions. */
export const WORKFLOW_CHILD_ACTION_BINDINGS = Object.freeze({
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  symbolEdit: "symbol.edit",
  sliceBuild: "slice.build",
  sliceRefresh: "slice.refresh",
  sliceSpilloverGet: "slice.spillover.get",
  deltaGet: "delta.get",
  prRiskAnalyze: "pr.risk.analyze",
  codeNeedWindow: "code.needWindow",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  repoRegister: "repo.register",
  repoStatus: "repo.status",
  repoUnregister: "repo.unregister",
  repoOverview: "repo.overview",
  indexRefresh: "index.refresh",
  policyGet: "policy.get",
  policySet: "policy.set",
  agentFeedback: "agent.feedback",
  agentFeedbackQuery: "agent.feedback.query",
  bufferPush: "buffer.push",
  bufferCheckpoint: "buffer.checkpoint",
  bufferStatus: "buffer.status",
  runtimeExecute: "runtime.execute",
  runtimeQueryOutput: "runtime.queryOutput",
  responseGet: "response.get",
  memoryStore: "memory.store",
  memoryQuery: "memory.query",
  memoryRemove: "memory.remove",
  memorySurface: "memory.surface",
  usageStats: "usage.stats",
  fileRead: "file.read",
  fileWrite: "file.write",
  searchEdit: "search.edit",
  semanticEnrichmentRefresh: "semantic.enrichment.refresh",
  semanticEnrichmentStatus: "semantic.enrichment.status",
} as const satisfies Readonly<Record<string, ProjectionAction>>);

function canonicalActionName(actionOrToolName: string): string {
  return actionOrToolName.startsWith("sdl.")
    ? actionOrToolName.slice("sdl.".length)
    : actionOrToolName;
}

export function getProjectionProfile(
  actionOrToolName: string,
): Readonly<ProjectionProfile> {
  const action = canonicalActionName(actionOrToolName);
  if (!Object.hasOwn(PROJECTION_PROFILE_REGISTRY, action)) {
    throw new Error(`Missing response projection profile: ${action}`);
  }
  return PROJECTION_PROFILE_REGISTRY[action as ProjectionAction];
}

export function getWorkflowProjectionAction(
  fn: string,
): ProjectionAction | undefined {
  return Object.hasOwn(WORKFLOW_CHILD_ACTION_BINDINGS, fn)
    ? WORKFLOW_CHILD_ACTION_BINDINGS[
      fn as keyof typeof WORKFLOW_CHILD_ACTION_BINDINGS
    ]
    : undefined;
}

/** Fail closed before a set of public actions is advertised. */
export function assertProjectionProfilesForActions(
  actions: readonly string[],
  source = "public actions",
): void {
  const seen = new Set<string>();
  for (const advertised of actions) {
    const action = canonicalActionName(advertised);
    if (seen.has(action)) {
      throw new Error(`Duplicate ${source} projection action: ${action}`);
    }
    seen.add(action);
    getProjectionProfile(action);
  }
}

/** Assert exact canonical inventory parity for tests and startup checks. */
export function assertProjectionProfileInventory(
  publicActions: readonly string[],
): void {
  assertProjectionProfilesForActions(publicActions);
  const publicSet = new Set(publicActions.map(canonicalActionName));
  for (const action of PROJECTION_PROFILE_ACTIONS) {
    if (!publicSet.has(action)) {
      throw new Error(`Projection profile is not publicly advertised: ${action}`);
    }
  }
}

/** Assert exact workflow alias parity and profile coverage. */
export function assertWorkflowProjectionBindings(
  activeFnNameMap: Readonly<Record<string, string>>,
): void {
  for (const [fn, action] of Object.entries(activeFnNameMap)) {
    if (!Object.hasOwn(WORKFLOW_CHILD_ACTION_BINDINGS, fn)) {
      throw new Error(`Missing workflow projection binding: ${fn}`);
    }
    const bound = WORKFLOW_CHILD_ACTION_BINDINGS[
      fn as keyof typeof WORKFLOW_CHILD_ACTION_BINDINGS
    ];
    if (bound !== action) {
      throw new Error(
        `Workflow projection binding mismatch for ${fn}: ${bound} !== ${action}`,
      );
    }
    getProjectionProfile(bound);
  }

  for (const fn of Object.keys(WORKFLOW_CHILD_ACTION_BINDINGS)) {
    if (!Object.hasOwn(activeFnNameMap, fn)) {
      throw new Error(`Unknown workflow projection binding: ${fn}`);
    }
  }
}
