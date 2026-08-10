import type { NextBestAction } from "../../domain/types.js";
import {
  type RecoveryActionDefinition,
  resolveRecoveryActionDefinition,
  resolveRecoveryWorkflowFunction,
} from "../../code-mode/recovery-action-catalog.js";
import { logger } from "../../util/logger.js";
import type {
  RecoveryActionCall,
  RecoveryBuildResult,
  RecoveryValidationContext,
  RecoveryValidationMetrics,
} from "./types.js";

const MAX_RECOVERY_BYTES = 32 * 1024;
export const RECOVERY_DEFAULT_MAX_BYTES = 8192;
const RECOVERY_METADATA_FIELDS = new Set([
  "action",
  "tool",
  "id",
  "args",
  "kind",
  "message",
  "rationale",
  "description",
]);
const PRESENTATION_ONLY_FIELDS = new Set([
  "detail",
  "includeDiagnostics",
  "includeTelemetry",
]);
const POLICY_NEXT_BEST_ACTIONS = new Set<NextBestAction>([
  "requestSkeleton",
  "requestHotPath",
  "requestRaw",
  "refreshSlice",
  "buildSlice",
  "provideIdentifiersToFind",
  "provideErrorCodeRefs",
  "provideFrontierJustification",
  "increaseBudget",
  "narrowScope",
  "retryWithSameInputs",
]);
const AMBIENT_REFERENCE_PATTERN = /\$\d+/;

let invalidRecoveryCount = 0;
let strictValidationForTests = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsCyclicReference(root: unknown): boolean {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const stack: Array<{ value: unknown; exiting: boolean }> = [
    { value: root, exiting: false },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const value = frame.value;
    if (!Array.isArray(value) && !isRecord(value)) {
      continue;
    }
    if (frame.exiting) {
      visiting.delete(value);
      visited.add(value);
      continue;
    }
    if (visiting.has(value)) {
      return true;
    }
    if (visited.has(value)) {
      continue;
    }

    visiting.add(value);
    stack.push({ value, exiting: true });
    const children = Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], exiting: false });
    }
  }

  return false;
}

function ownString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return Object.hasOwn(value, key) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function isPolicyNextBestAction(
  value: unknown,
): value is NextBestAction {
  return (
    typeof value === "string" &&
    POLICY_NEXT_BEST_ACTIONS.has(value as NextBestAction)
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return stableValue(value) as Record<string, unknown>;
}

function containsAmbientReference(value: unknown): boolean {
  if (typeof value === "string") {
    return AMBIENT_REFERENCE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsAmbientReference);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some(containsAmbientReference);
}

function extractCandidate(
  candidate: unknown,
): { action: string; args: Record<string, unknown> } | undefined {
  if (!isRecord(candidate)) return undefined;

  const action =
    ownString(candidate, "action") ??
    ownString(candidate, "tool") ??
    ownString(candidate, "id");
  if (!action) return undefined;

  const args: Record<string, unknown> =
    Object.hasOwn(candidate, "args") && isRecord(candidate.args)
      ? stableRecord(candidate.args)
      : {};
  for (const [key, value] of Object.entries(candidate)) {
    if (RECOVERY_METADATA_FIELDS.has(key) || Object.hasOwn(args, key)) {
      continue;
    }
    defineOwn(args, key, stableValue(value));
  }
  return { action, args };
}

function applyAliases(
  definition: RecoveryActionDefinition,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = stableRecord(args);
  for (const [alias, canonical] of Object.entries(definition.aliases ?? {})) {
    if (
      Object.hasOwn(normalized, alias) &&
      !Object.hasOwn(normalized, canonical)
    ) {
      defineOwn(normalized, canonical, normalized[alias]);
    }
    delete normalized[alias];
  }
  return normalized;
}

function contextRepoId(context: RecoveryValidationContext): string | undefined {
  if (typeof context.repoId === "string" && context.repoId.length > 0) {
    return context.repoId;
  }
  const failedRepoId = context.failedCall?.args.repoId;
  return typeof failedRepoId === "string" && failedRepoId.length > 0
    ? failedRepoId
    : undefined;
}

function materializeArgs(
  definition: RecoveryActionDefinition,
  args: Readonly<Record<string, unknown>>,
  context: RecoveryValidationContext,
): Record<string, unknown> {
  const materialized = applyAliases(definition, args);
  const repoId = contextRepoId(context);
  if (materialized.repoId === undefined && repoId !== undefined) {
    materialized.repoId = repoId;
  }

  const continuation = context.continuation;
  if (definition.action === "response.get") {
    if (materialized.handle === undefined && continuation?.handle !== undefined) {
      materialized.handle = continuation.handle;
    }
    if (
      materialized.maxBytes === undefined &&
      continuation?.maxBytes !== undefined
    ) {
      materialized.maxBytes = continuation.maxBytes;
    }
  } else if (definition.action === "runtime.queryOutput") {
    if (
      materialized.artifactHandle === undefined &&
      continuation?.handle !== undefined
    ) {
      materialized.artifactHandle = continuation.handle;
    }
    if (materialized.view === undefined && continuation?.view !== undefined) {
      materialized.view = continuation.view;
    }
    if (materialized.cursor === undefined && continuation?.cursor !== undefined) {
      materialized.cursor = { ...continuation.cursor };
    }
  }

  return materialized;
}

function continuationProblem(
  action: string,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  if (action === "response.get") {
    if (typeof args.handle !== "string" || args.handle.length === 0) {
      return "response.get requires an artifact handle";
    }
    if (
      typeof args.maxBytes !== "number" ||
      !Number.isInteger(args.maxBytes) ||
      args.maxBytes <= 0
    ) {
      return "response.get requires a positive maxBytes bound";
    }
  }

  if (action === "runtime.queryOutput") {
    if (
      typeof args.artifactHandle !== "string" ||
      args.artifactHandle.length === 0
    ) {
      return "runtime.queryOutput requires an artifact handle";
    }
    if (args.view !== "model" && args.view !== "raw") {
      return "runtime.queryOutput requires an explicit view";
    }
    if (
      !isRecord(args.cursor) ||
      (args.cursor.stream !== "stdout" && args.cursor.stream !== "stderr") ||
      typeof args.cursor.afterLine !== "number" ||
      !Number.isInteger(args.cursor.afterLine) ||
      args.cursor.afterLine < 0
    ) {
      return "runtime.queryOutput requires an explicit cursor";
    }
  }

  return undefined;
}

function withoutPresentationFields(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !PRESENTATION_ONLY_FIELDS.has(key))
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function logicalCallSignature(
  call: RecoveryActionCall,
  ambientRepoId?: string,
): string | undefined {
  const definition = resolveRecoveryActionDefinition(call.action);
  if (!definition) return undefined;

  const withRepoId = stableRecord(call.args);
  if (withRepoId.repoId === undefined && ambientRepoId !== undefined) {
    withRepoId.repoId = ambientRepoId;
  }
  const parsed = definition.schema.safeParse(applyAliases(definition, withRepoId));
  const args = parsed.success && isRecord(parsed.data)
    ? parsed.data
    : withRepoId;
  return JSON.stringify({
    action: definition.action,
    args: withoutPresentationFields(args),
  });
}

function invalidRecovery(
  reason: string,
  action?: string,
): RecoveryBuildResult {
  invalidRecoveryCount += 1;
  logger.warn("Invalid generated recovery omitted", {
    reason,
    action: action ?? "unknown",
    invalidRecoveryCount,
  });
  if (strictValidationForTests) {
    throw new Error(`Invalid generated recovery: ${reason}`);
  }
  return { invalidRecoveryCount: 1 };
}

function boundedResult(nextAction: RecoveryActionCall): RecoveryBuildResult {
  const serialized = JSON.stringify(nextAction);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES) {
    return invalidRecovery("serialized recovery exceeds the byte bound", nextAction.action);
  }
  return { nextAction, invalidRecoveryCount: 0 };
}

function normalizeWorkflowArgsForActiveSurface(
  action: string,
  args: Record<string, unknown>,
  context: RecoveryValidationContext,
): Record<string, unknown> | undefined {
  if (
    action !== "workflow" ||
    context.activeWorkflowFunctions === undefined
  ) {
    return args;
  }

  const activeFunctions = new Set(context.activeWorkflowFunctions);
  if (!Array.isArray(args.steps)) return undefined;

  const steps: Record<string, unknown>[] = [];
  for (const step of args.steps) {
    if (!isRecord(step)) return undefined;
    const requestedFn = ownString(step, "fn");
    if (!requestedFn) return undefined;
    const resolvedFn =
      resolveRecoveryWorkflowFunction(requestedFn) ?? requestedFn;
    if (!activeFunctions.has(resolvedFn)) return undefined;
    steps.push({ ...step, fn: resolvedFn });
  }

  return { ...args, steps };
}

/**
 * Materialize and validate a generated recovery before it crosses a public
 * response boundary. Invalid recovery is diagnostic-only and never replaces
 * the safe error/result that produced it.
 */
export function buildValidatedRecoveryAction(
  candidate: unknown,
  context: RecoveryValidationContext,
): RecoveryBuildResult {
  // Guard every recursive canonicalization path before generated data can
  // replace the original safe error at the MCP delivery boundary.
  if (containsCyclicReference(candidate)) {
    return invalidRecovery("candidate contains a cyclic reference");
  }
  if (containsCyclicReference(context.failedCall)) {
    return invalidRecovery("failed call contains a cyclic reference");
  }

  const extracted = extractCandidate(candidate);
  if (!extracted) {
    return invalidRecovery("candidate does not name an action");
  }

  const definition = resolveRecoveryActionDefinition(extracted.action);
  if (!definition) {
    return invalidRecovery("candidate names an unknown action", extracted.action);
  }

  const materialized = materializeArgs(definition, extracted.args, context);
  const continuationError = continuationProblem(definition.action, materialized);
  if (continuationError) {
    return invalidRecovery(continuationError, definition.action);
  }

  const parsed = definition.schema.safeParse(materialized);
  if (!parsed.success || !isRecord(parsed.data)) {
    return invalidRecovery("candidate args fail the target input schema", definition.action);
  }

  const activeArgs = normalizeWorkflowArgsForActiveSurface(
    definition.action,
    parsed.data,
    context,
  );
  if (!activeArgs) {
    return invalidRecovery(
      "workflow recovery references a function outside this server's active surface",
      definition.action,
    );
  }

  const logicalCandidate: RecoveryActionCall = {
    action: definition.action,
    args: activeArgs,
  };
  if (context.failedCall) {
    const failedSignature = logicalCallSignature(
      context.failedCall,
      contextRepoId(context),
    );
    const candidateSignature = logicalCallSignature(
      logicalCandidate,
      contextRepoId(context),
    );
    if (
      failedSignature !== undefined &&
      candidateSignature !== undefined &&
      failedSignature === candidateSignature
    ) {
      return invalidRecovery(
        "candidate repeats the failed call without a cause-relevant change",
        definition.action,
      );
    }
  }

  const advertisedTools = new Set(
    context.advertisedTools.map((tool) =>
      tool.startsWith("sdl.") ? tool : `sdl.${tool}`,
    ),
  );
  if (definition.toolName && advertisedTools.has(definition.toolName)) {
    const nextAction: RecoveryActionCall = {
      action: definition.toolName,
      args: stableRecord(activeArgs),
    };
    if (
      nextAction.action === "sdl.workflow" &&
      containsAmbientReference(nextAction.args)
    ) {
      return invalidRecovery(
        "workflow recovery depends on ambient result references",
        definition.action,
      );
    }
    return boundedResult(nextAction);
  }

  if (!advertisedTools.has("sdl.workflow")) {
    return invalidRecovery(
      "target action is not advertised on the active public surface",
      definition.action,
    );
  }

  const fn = resolveRecoveryWorkflowFunction(definition.action);
  if (
    !fn ||
    (context.activeWorkflowFunctions !== undefined &&
      !context.activeWorkflowFunctions.includes(fn))
  ) {
    return invalidRecovery(
      "target action is not active in this server's workflow function map",
      definition.action,
    );
  }
  const repoId =
    typeof activeArgs.repoId === "string"
      ? activeArgs.repoId
      : contextRepoId(context);
  if (!repoId) {
    return invalidRecovery(
      "workflow recovery cannot materialize repoId",
      definition.action,
    );
  }

  const { repoId: _repoId, ...childArgs } = activeArgs;
  const workflowDefinition = resolveRecoveryActionDefinition("workflow");
  if (!workflowDefinition) {
    return invalidRecovery("workflow action is unavailable", definition.action);
  }
  const workflowParsed = workflowDefinition.schema.safeParse({
    repoId,
    steps: [{ fn, args: childArgs }],
    onError: "continue",
  });
  if (!workflowParsed.success || !isRecord(workflowParsed.data)) {
    return invalidRecovery(
      "materialized workflow fails the workflow input schema",
      definition.action,
    );
  }
  if (containsAmbientReference(workflowParsed.data)) {
    return invalidRecovery(
      "workflow recovery depends on ambient result references",
      definition.action,
    );
  }

  return boundedResult({
    action: "sdl.workflow",
    args: stableRecord(workflowParsed.data),
  });
}

export const _recoveryValidationTesting = {
  reset(): void {
    invalidRecoveryCount = 0;
    strictValidationForTests = false;
  },
  setStrictMode(enabled: boolean): void {
    strictValidationForTests = enabled;
  },
  getMetrics(): RecoveryValidationMetrics {
    return { invalidRecoveryCount };
  },
};
