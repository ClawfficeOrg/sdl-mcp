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

const RECOVERY_TEXT_FIELDS = ["fallbackRationale", "downgradeGuidance"] as const;
const RECOVERY_TEXT_ARRAY_FIELDS = ["whyDenied", "warnings"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function projectNextAction(value: unknown, fallbackRepoId?: string): unknown {
  if (!isRecord(value)) return value;

  const referenceKey =
    typeof value.tool === "string"
      ? "tool"
      : typeof value.action === "string"
        ? "action"
        : undefined;
  if (!referenceKey) return value;

  const actionName = value[referenceKey] as string;
  if (!Object.hasOwn(EXCLUSIVE_GATEWAY_REFERENCES, actionName)) return value;
  const gateway = EXCLUSIVE_GATEWAY_REFERENCES[actionName];

  const originalArgs = isRecord(value.args) ? value.args : {};
  const { repoId: originalRepoId, ...actionArgs } = originalArgs;
  const repoId =
    typeof originalRepoId === "string" ? originalRepoId : fallbackRepoId;
  const gatewayArgs =
    gateway.tool === "sdl.retrieve"
      ? { ...(repoId ? { repoId } : {}), op: gateway.op, args: actionArgs }
      : {
          ...(repoId ? { repoId } : {}),
          steps: [{ fn: gateway.fn, args: actionArgs }],
        };

  return {
    ...value,
    [referenceKey]: gateway.tool,
    args: gatewayArgs,
  };
}

/**
 * Rewrite only recovery-specific fields emitted through the exclusive Code Mode
 * surface. Flat handlers keep their native action names when they are callable.
 */
export function projectExclusiveCodeModeRecovery<T>(
  value: T,
  fallbackRepoId?: string,
): T {
  if (!isRecord(value)) return value;

  const projected: Record<string, unknown> =
    value instanceof Error ? value : { ...value };

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
      ...new Set(
        projected.fallbackTools.map((tool) =>
          typeof tool === "string"
            ? (EXCLUSIVE_GATEWAY_REFERENCES[tool]?.tool ?? tool)
            : tool,
        ),
      ),
    ];
  }
  if (projected.nextBestAction !== undefined) {
    projected.nextBestAction = projectNextAction(
      projected.nextBestAction,
      fallbackRepoId,
    );
  }
  if (Array.isArray(projected.nextCalls)) {
    projected.nextCalls = projected.nextCalls.map((nextCall) =>
      projectNextAction(nextCall, fallbackRepoId),
    );
  }

  // Workflow envelopes nest action results and failures under stable fields.
  if (Array.isArray(projected.results)) {
    projected.results = projected.results.map((result) =>
      projectExclusiveCodeModeRecovery(result, fallbackRepoId),
    );
  }
  for (const field of ["result", "failureTrace"] as const) {
    if (projected[field] !== undefined) {
      projected[field] = projectExclusiveCodeModeRecovery(
        projected[field],
        fallbackRepoId,
      );
    }
  }
  if (Array.isArray(projected.data)) {
    projected.data = projected.data.map((item) =>
      projectExclusiveCodeModeRecovery(item, fallbackRepoId),
    );
  } else if (isRecord(projected.data)) {
    projected.data = projectExclusiveCodeModeRecovery(
      projected.data,
      fallbackRepoId,
    );
  }
  if (typeof projected.error === "string") {
    projected.error = rewriteRecoveryText(projected.error);
  } else if (projected.error !== undefined) {
    projected.error = projectExclusiveCodeModeRecovery(
      projected.error,
      fallbackRepoId,
    );
  }

  return projected as T;
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
