import { logger } from "../../util/logger.js";
import type {
  RecoveryActionCall,
  RecoveryBuildResult,
  RecoveryValidationContext,
  RecoveryValidationMetrics,
} from "./types.js";

interface RecoveryActionDefinition {
  readonly action: string;
  readonly fn: string | null;
  readonly toolName: string | null;
  readonly schema: {
    safeParse(input: unknown):
      | { success: true; data: unknown }
      | { success: false };
  };
  readonly aliases?: Readonly<Record<string, string>>;
  readonly kind: "gateway" | "internal" | "meta";
}

interface RecoveryCatalog {
  readonly resolveActionDefinition: (
    actionOrToolName: string,
  ) => RecoveryActionDefinition | undefined;
  readonly resolveWorkflowFunction: (
    actionOrToolName: string,
  ) => string | undefined;
}

let recoveryCatalog: RecoveryCatalog | undefined;

/** Register the already-initialized public action catalog without a back-edge. */
export function registerRecoveryCatalog(catalog: RecoveryCatalog): void {
  recoveryCatalog = catalog;
}

function resolveActionDefinition(
  actionOrToolName: string,
): RecoveryActionDefinition | undefined {
  return recoveryCatalog?.resolveActionDefinition(actionOrToolName);
}

function resolveWorkflowFunction(
  actionOrToolName: string,
): string | undefined {
  return recoveryCatalog?.resolveWorkflowFunction(actionOrToolName);
}

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
const AMBIENT_REFERENCE_PATTERN = /\$\d+/;

let invalidRecoveryCount = 0;
let strictValidationForTests = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableValue(value[key]);
  }
  return sorted;
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
    typeof candidate.action === "string"
      ? candidate.action
      : typeof candidate.tool === "string"
        ? candidate.tool
        : typeof candidate.id === "string"
          ? candidate.id
          : undefined;
  if (!action) return undefined;

  const args: Record<string, unknown> = isRecord(candidate.args)
    ? { ...candidate.args }
    : {};
  for (const [key, value] of Object.entries(candidate)) {
    if (RECOVERY_METADATA_FIELDS.has(key) || Object.hasOwn(args, key)) {
      continue;
    }
    args[key] = value;
  }
  return { action, args };
}

function applyAliases(
  definition: RecoveryActionDefinition,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = { ...args };
  for (const [alias, canonical] of Object.entries(definition.aliases ?? {})) {
    if (
      Object.hasOwn(normalized, alias) &&
      !Object.hasOwn(normalized, canonical)
    ) {
      normalized[canonical] = normalized[alias];
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

function withoutPresentationFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutPresentationFields);
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (!PRESENTATION_ONLY_FIELDS.has(key)) {
      result[key] = withoutPresentationFields(value[key]);
    }
  }
  return result;
}

function logicalCallSignature(
  call: RecoveryActionCall,
  ambientRepoId?: string,
): string | undefined {
  const definition = resolveActionDefinition(call.action);
  if (!definition) return undefined;

  const withRepoId = { ...call.args };
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

/**
 * Materialize and validate a generated recovery before it crosses a public
 * response boundary. Invalid recovery is diagnostic-only and never replaces
 * the safe error/result that produced it.
 */
export function buildValidatedRecoveryAction(
  candidate: unknown,
  context: RecoveryValidationContext,
): RecoveryBuildResult {
  const extracted = extractCandidate(candidate);
  if (!extracted) {
    return invalidRecovery("candidate does not name an action");
  }

  const definition = resolveActionDefinition(extracted.action);
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

  const logicalCandidate: RecoveryActionCall = {
    action: definition.action,
    args: parsed.data,
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
      args: stableRecord(parsed.data),
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

  const fn = resolveWorkflowFunction(definition.action);
  if (!fn) {
    return invalidRecovery(
      "target action is not active in the workflow function map",
      definition.action,
    );
  }
  const repoId =
    typeof parsed.data.repoId === "string"
      ? parsed.data.repoId
      : contextRepoId(context);
  if (!repoId) {
    return invalidRecovery(
      "workflow recovery cannot materialize repoId",
      definition.action,
    );
  }

  const { repoId: _repoId, ...childArgs } = parsed.data;
  const workflowDefinition = resolveActionDefinition("workflow");
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
