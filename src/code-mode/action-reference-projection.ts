import {
  resolveRecoveryActionDefinition,
  resolveRecoveryWorkflowFunction,
} from "./action-catalog.js";
import {
  buildValidatedRecoveryAction,
  _recoveryValidationTesting,
  RECOVERY_DEFAULT_MAX_BYTES,
} from "../mcp/response-projection/recovery.js";
import {
  EXCLUSIVE_CODE_MODE_RECOVERY_TOOL_NAMES,
} from "../mcp/response-projection/registry.js";
import type {
  RecoveryActionCall,
  RecoveryContinuationContext,
} from "../mcp/response-projection/types.js";

export {
  buildValidatedRecoveryAction,
  _recoveryValidationTesting,
};

type GatewayReference =
  | { tool: "sdl.retrieve"; op: string }
  | { tool: "sdl.workflow"; fn: string };

const EXCLUSIVE_GATEWAY_REFERENCES: Readonly<Record<string, GatewayReference>> =
  Object.freeze({
    "sdl.symbol.search": { tool: "sdl.retrieve", op: "symbolSearch" },
    "sdl.symbol.getCard": { tool: "sdl.retrieve", op: "symbolGetCard" },
    "sdl.code.getSkeleton": { tool: "sdl.retrieve", op: "codeSkeleton" },
    "sdl.code.getHotPath": { tool: "sdl.retrieve", op: "codeHotPath" },
    "sdl.code.needWindow": { tool: "sdl.retrieve", op: "codeNeedWindow" },
    "sdl.policy.set": { tool: "sdl.workflow", fn: "policySet" },
  });

const EXCLUSIVE_RECOVERY_TOOL_SET = new Set<string>(
  EXCLUSIVE_CODE_MODE_RECOVERY_TOOL_NAMES,
);

const RECOVERY_TEXT_FIELDS = ["fallbackRationale", "downgradeGuidance"] as const;
const RECOVERY_TEXT_ARRAY_FIELDS = ["whyDenied", "warnings"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteRecoveryText(text: string): string {
  let rewritten = text;
  for (const [flatTool, gateway] of Object.entries(
    EXCLUSIVE_GATEWAY_REFERENCES,
  )) {
    const replacement =
      gateway.tool === "sdl.retrieve"
        ? `sdl.retrieve op:"${gateway.op}"`
        : `sdl.workflow step fn:"${gateway.fn}"`;
    rewritten = rewritten.replaceAll(flatTool, replacement);
  }
  return rewritten;
}

function candidateArgs(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const args = isRecord(value.args) ? { ...value.args } : {};
  for (const [key, candidateValue] of Object.entries(value)) {
    if (
      key === "action" ||
      key === "tool" ||
      key === "id" ||
      key === "args" ||
      key === "kind" ||
      key === "message" ||
      key === "rationale" ||
      key === "description" ||
      Object.hasOwn(args, key)
    ) {
      continue;
    }
    args[key] = candidateValue;
  }
  return args;
}

function continuationForCandidate(
  value: unknown,
  materializeResponseBound: boolean,
): RecoveryContinuationContext | undefined {
  if (!isRecord(value)) return undefined;
  const actionName =
    typeof value.action === "string"
      ? value.action
      : typeof value.tool === "string"
        ? value.tool
        : typeof value.id === "string"
          ? value.id
          : undefined;
  if (!actionName) return undefined;

  const definition = resolveRecoveryActionDefinition(actionName);
  if (!definition || definition.action !== "response.get") {
    return undefined;
  }
  const args = candidateArgs(value);
  return {
    ...(typeof args.handle === "string" ? { handle: args.handle } : {}),
    ...(typeof args.maxBytes === "number"
      ? { maxBytes: args.maxBytes }
      : materializeResponseBound
        ? { maxBytes: RECOVERY_DEFAULT_MAX_BYTES }
        : {}),
  };
}

function failedCallFromTrace(
  value: Readonly<Record<string, unknown>>,
  fallbackRepoId: string | undefined,
  inherited: RecoveryActionCall | undefined,
): RecoveryActionCall | undefined {
  const failureLike =
    value.status === "error" ||
    value.status === "failure" ||
    (typeof value.message === "string" &&
      (value.kind === "gateway" || value.kind === "internal"));
  if (!failureLike || typeof value.action !== "string") {
    return inherited;
  }

  const traceArgs =
    isRecord(value._resolvedArgs)
      ? value._resolvedArgs
      : isRecord(value.resolvedArgs)
        ? value.resolvedArgs
        : isRecord(value.args)
          ? value.args
          : {};
  return {
    action: value.action,
    args: {
      ...(fallbackRepoId ? { repoId: fallbackRepoId } : {}),
      ...traceArgs,
    },
  };
}

function projectNextAction(
  value: unknown,
  fallbackRepoId: string | undefined,
  failedCall: RecoveryActionCall | undefined,
  materializeResponseBound = false,
): unknown | undefined {
  if (!isRecord(value)) return undefined;

  const referenceKey =
    typeof value.tool === "string"
      ? "tool"
      : typeof value.action === "string"
        ? "action"
        : typeof value.id === "string"
          ? "id"
          : undefined;
  if (!referenceKey) return undefined;

  const continuation = continuationForCandidate(
    value,
    materializeResponseBound,
  );
  const validated = buildValidatedRecoveryAction(value, {
    ...(fallbackRepoId ? { repoId: fallbackRepoId } : {}),
    advertisedTools: EXCLUSIVE_CODE_MODE_RECOVERY_TOOL_NAMES,
    ...(failedCall ? { failedCall } : {}),
    ...(continuation ? { continuation } : {}),
  });
  if (!validated.nextAction) return undefined;

  return {
    ...value,
    [referenceKey]: validated.nextAction.action,
    args: validated.nextAction.args,
  };
}

function projectFallbackTool(tool: unknown): unknown {
  if (typeof tool !== "string") return tool;
  const publicName = tool.startsWith("sdl.") ? tool : `sdl.${tool}`;
  if (EXCLUSIVE_RECOVERY_TOOL_SET.has(publicName)) {
    return publicName;
  }
  if (Object.hasOwn(EXCLUSIVE_GATEWAY_REFERENCES, publicName)) {
    return EXCLUSIVE_GATEWAY_REFERENCES[publicName].tool;
  }
  return resolveRecoveryWorkflowFunction(tool) ? "sdl.workflow" : tool;
}

function projectRecoveryValue<T>(
  value: T,
  fallbackRepoId: string | undefined,
  inheritedFailedCall: RecoveryActionCall | undefined,
): T {
  if (!isRecord(value)) return value;

  const projected: Record<string, unknown> =
    value instanceof Error ? value : { ...value };
  const failedCall = failedCallFromTrace(
    projected,
    fallbackRepoId,
    inheritedFailedCall,
  );

  if (typeof projected.message === "string") {
    projected.message = rewriteRecoveryText(projected.message);
  }

  for (const field of RECOVERY_TEXT_FIELDS) {
    if (typeof projected[field] === "string") {
      projected[field] = rewriteRecoveryText(projected[field]);
    }
  }
  for (const field of RECOVERY_TEXT_ARRAY_FIELDS) {
    if (Array.isArray(projected[field])) {
      projected[field] = projected[field].map((item) =>
        typeof item === "string" ? rewriteRecoveryText(item) : item,
      );
    }
  }

  if (Array.isArray(projected.fallbackTools)) {
    projected.fallbackTools = [
      ...new Set(projected.fallbackTools.map(projectFallbackTool)),
    ];
  }

  for (const field of ["nextAction", "nextBestAction"] as const) {
    if (projected[field] === undefined) continue;
    const nextAction = projectNextAction(
      projected[field],
      fallbackRepoId,
      failedCall,
    );
    if (nextAction === undefined) {
      delete projected[field];
    } else {
      projected[field] = nextAction;
    }
  }

  if (Array.isArray(projected.nextCalls)) {
    const nextCalls = projected.nextCalls
      .map((nextCall) =>
        projectNextAction(nextCall, fallbackRepoId, failedCall, true),
      )
      .filter((nextCall) => nextCall !== undefined);
    if (nextCalls.length === 0) {
      delete projected.nextCalls;
    } else {
      projected.nextCalls = nextCalls;
    }
  }

  if (Array.isArray(projected.results)) {
    projected.results = projected.results.map((result) =>
      projectRecoveryValue(result, fallbackRepoId, failedCall),
    );
  }
  for (const field of ["result", "failureTrace"] as const) {
    if (projected[field] !== undefined) {
      projected[field] = projectRecoveryValue(
        projected[field],
        fallbackRepoId,
        failedCall,
      );
    }
  }
  if (isRecord(projected.details)) {
    projected.details = projectRecoveryValue(
      projected.details,
      fallbackRepoId,
      failedCall,
    );
  }
  if (Array.isArray(projected.data)) {
    projected.data = projected.data.map((item) =>
      projectRecoveryValue(item, fallbackRepoId, failedCall),
    );
  } else if (isRecord(projected.data)) {
    projected.data = projectRecoveryValue(
      projected.data,
      fallbackRepoId,
      failedCall,
    );
  }
  if (typeof projected.error === "string") {
    projected.error = rewriteRecoveryText(projected.error);
  } else if (projected.error !== undefined) {
    projected.error = projectRecoveryValue(
      projected.error,
      fallbackRepoId,
      failedCall,
    );
  }

  return projected as T;
}

/**
 * Validate and rewrite recovery fields for the exclusive Code Mode surface.
 * Invalid recovery fields are omitted without changing the surrounding result.
 */
export function projectExclusiveCodeModeRecovery<T>(
  value: T,
  fallbackRepoId?: string,
): T {
  return projectRecoveryValue(value, fallbackRepoId, undefined);
}

/** Apply exclusive-surface projection to both successful results and typed errors. */
export async function withExclusiveCodeModeRecoveryProjection<T>(
  exclusive: boolean,
  call: () => Promise<T>,
  request?: unknown,
): Promise<T> {
  const repoId =
    isRecord(request) && typeof request.repoId === "string"
      ? request.repoId
      : undefined;
  try {
    const result = await call();
    return exclusive
      ? projectExclusiveCodeModeRecovery(result, repoId)
      : result;
  } catch (error) {
    if (exclusive) projectExclusiveCodeModeRecovery(error, repoId);
    throw error;
  }
}
