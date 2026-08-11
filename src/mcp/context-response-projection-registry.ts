import { getWorkflowProjectionAction } from "./response-projection/registry.js";

export {
  PROJECTION_PROFILE_ACTIONS,
  PROJECTION_PROFILE_REGISTRY,
  WORKFLOW_CHILD_ACTION_BINDINGS,
  assertProjectionProfileInventory,
  assertProjectionProfilesForActions,
  assertWorkflowProjectionBindings,
  createProjectionProfileRegistry,
  getProjectionProfile,
  getWorkflowProjectionAction,
} from "./response-projection/registry.js";
export type {
  ProjectionAction,
  ProjectionProfileEntry,
} from "./response-projection/registry.js";

export const CUSTOM_RESPONSE_PROJECTION_ACTIONS = [
  "action.search",
  "buffer.checkpoint",
  "code.needWindow",
  "context",
  "delta.get",
  "repo.overview",
  "repo.status",
  "slice.build",
  "symbol.search",
  "usage.stats",
  "workflow",
] as const;

export type ResponseProjectionAction =
  (typeof CUSTOM_RESPONSE_PROJECTION_ACTIONS)[number];

export type ResponseProjector =
  | "actionSearch"
  | "generic"
  | "repoStatus"
  | "usage"
  | "workflow";

export interface ResponseProjectionRule {
  projector: ResponseProjector;
  omitTopLevelFields?: readonly string[];
  showRepoId?: boolean;
  keepTopLevelMatchedLines?: boolean;
  keepNestedWhyApproved?: boolean;
  omitBudget?: boolean;
  omitSymbols?: boolean;
}

type ResponseProjectionEntry = readonly [
  ResponseProjectionAction,
  Readonly<ResponseProjectionRule>,
];

const CUSTOM_ACTION_SET = new Set<string>(CUSTOM_RESPONSE_PROJECTION_ACTIONS);

/** Build the closed custom-projection registry and reject accidental drift. */
export function createResponseProjectionRegistry(
  entries: readonly ResponseProjectionEntry[],
): Readonly<
  Record<ResponseProjectionAction, Readonly<ResponseProjectionRule>>
> {
  const registry: Partial<
    Record<ResponseProjectionAction, Readonly<ResponseProjectionRule>>
  > = {};
  for (const [action, rule] of entries) {
    if (!CUSTOM_ACTION_SET.has(action)) {
      throw new Error(`Unknown response projection action: ${action}`);
    }
    registry[action] = Object.freeze({ ...rule });
  }

  for (const action of CUSTOM_RESPONSE_PROJECTION_ACTIONS) {
    if (!(action in registry)) {
      throw new Error(`Missing response projection action: ${action}`);
    }
  }

  return Object.freeze(registry) as Readonly<
    Record<ResponseProjectionAction, Readonly<ResponseProjectionRule>>
  >;
}

export const RESPONSE_PROJECTION_RULES = createResponseProjectionRegistry([
  ["action.search", { projector: "actionSearch" }],
  ["buffer.checkpoint", { projector: "generic", showRepoId: true }],
  [
    "code.needWindow",
    {
      projector: "generic",
      omitTopLevelFields: ["whyApproved", "estimatedTokens"],
      keepTopLevelMatchedLines: true,
      keepNestedWhyApproved: true,
    },
  ],
  ["context", { projector: "generic" }],
  ["delta.get", { projector: "generic", showRepoId: true }],
  [
    "repo.overview",
    {
      projector: "generic",
      showRepoId: true,
      omitTopLevelFields: ["generatedAt"],
    },
  ],
  ["repo.status", { projector: "repoStatus", showRepoId: true }],
  ["slice.build", { projector: "generic", omitBudget: true }],
  ["symbol.search", { projector: "generic", omitSymbols: true }],
  [
    "usage.stats",
    { projector: "usage", omitTopLevelFields: ["formattedSummary"] },
  ],
  ["workflow", { projector: "workflow", showRepoId: true }],
]);

function canonicalActionName(toolName: string): string {
  return toolName.startsWith("sdl.") ? toolName.slice(4) : toolName;
}

export function getResponseProjectionRule(
  toolName: string,
): Readonly<ResponseProjectionRule> | undefined {
  const action = canonicalActionName(toolName);
  return CUSTOM_ACTION_SET.has(action)
    ? RESPONSE_PROJECTION_RULES[action as ResponseProjectionAction]
    : undefined;
}

/** Legacy aliases that are not members of the active workflow function map. */
export const COMPATIBILITY_WORKFLOW_CHILD_ACTIONS: Readonly<
  Record<string, string>
> = Object.freeze({
  actionSearch: "action.search",
  file: "sdl.file",
  sdlFile: "sdl.file",
  symbolGetCards: "symbol.getCards",
});

export function getWorkflowChildAction(fn: string): string {
  return (
    getWorkflowProjectionAction(fn) ??
    COMPATIBILITY_WORKFLOW_CHILD_ACTIONS[fn] ??
    "workflow"
  );
}
