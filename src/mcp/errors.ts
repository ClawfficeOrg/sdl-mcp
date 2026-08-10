import type { NextBestAction, RequiredFieldsForNext } from "./types.js";
import {
  buildValidatedRecoveryAction,
  isPolicyNextBestAction,
  RECOVERY_DEFAULT_MAX_BYTES,
} from "./response-projection/recovery.js";
import {
  FLAT_RECOVERY_TOOL_NAMES,
  getRecoverySurfaceToolNames,
} from "./response-projection/registry.js";

// Re-export domain error types for backward compatibility
export {
  ErrorCode,
  ConfigError,
  DatabaseError,
  IndexError,
  ValidationError,
  PolicyError,
  NotFoundError,
} from "../domain/errors.js";

import { ErrorCode } from "../domain/errors.js";

export class WireFormatRetiredError extends Error {
  readonly retiredVersion: number;
  readonly migrationHint: string;
  constructor(retiredVersion: number) {
    const hint =
      "Compact wire format versions 1 and 2 were retired in 0.11.0. " +
      'Use wireFormatVersion: 3 (default) or wireFormat: "packed".';
    super(`wireFormatVersion ${retiredVersion} is retired. ${hint}`);
    this.name = "WireFormatRetiredError";
    this.retiredVersion = retiredVersion;
    this.migrationHint = hint;
    (this as { code?: string }).code = "WIRE_FORMAT_RETIRED";
  }
}

export class PolicyDenialError extends Error {
  readonly code = ErrorCode.POLICY_ERROR;
  readonly nextBestAction?: NextBestAction;
  readonly requiredFieldsForNext?: RequiredFieldsForNext;

  constructor(
    message: string,
    nextBestAction?: NextBestAction,
    requiredFieldsForNext?: RequiredFieldsForNext,
  ) {
    super(message);
    this.name = "PolicyDenialError";
    this.nextBestAction = nextBestAction;
    this.requiredFieldsForNext = requiredFieldsForNext;
    Object.setPrototypeOf(this, PolicyDenialError.prototype);
  }
}

export function createPolicyDenial(
  message: string,
  nextBestAction?: NextBestAction,
  requiredFieldsForNext?: RequiredFieldsForNext,
): PolicyDenialError {
  return new PolicyDenialError(message, nextBestAction, requiredFieldsForNext);
}

export interface McpErrorDetail {
  message: string;
  code?: string;
  details?: string[];
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
  classification?: string;
  retryable?: boolean;
  suggestedRetryDelayMs?: number;
  fallbackTools?: string[];
  nextCalls?: Array<{ action: string; args: Record<string, unknown> }>;
  fallbackRationale?: string;
  candidates?: Array<Record<string, unknown>>;
}

/**
 * Determines whether an error is a known domain error whose message is safe
 * to expose to MCP clients.  Unknown/unexpected errors are sanitized to
 * prevent leaking internal paths, stack traces, or DB state.
 */
function isDomainError(error: Error): boolean {
  const code = (error as { code?: string }).code;
  return (
    typeof code === "string" &&
    Object.values(ErrorCode).includes(code as ErrorCode)
  );
}

function defaultClassification(code?: string): string | undefined {
  switch (code) {
    case ErrorCode.NOT_FOUND:
      return "not_found";
    case ErrorCode.VALIDATION_ERROR:
      return "invalid_input";
    case ErrorCode.POLICY_ERROR:
      return "policy_denied";
    case ErrorCode.DATABASE_ERROR:
      return "internal_error";
    case ErrorCode.INDEX_ERROR:
      return "unavailable";
    case ErrorCode.CONFIG_ERROR:
      return "configuration_error";
    case ErrorCode.RUNTIME_ERROR:
      return "runtime_error";
    default:
      return undefined;
  }
}

function defaultRetryable(code?: string): boolean | undefined {
  switch (code) {
    case ErrorCode.DATABASE_ERROR:
    case ErrorCode.INDEX_ERROR:
    case ErrorCode.RUNTIME_ERROR:
      return true;
    case ErrorCode.NOT_FOUND:
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.POLICY_ERROR:
    case ErrorCode.CONFIG_ERROR:
      return false;
    default:
      return undefined;
  }
}

function fallbackRationaleForNextAction(nextBestAction?: NextBestAction): string | undefined {
  switch (nextBestAction) {
    case "requestSkeleton":
      return "Use a skeleton request first to stay on the context ladder.";
    case "requestHotPath":
      return "Use a hot-path excerpt before requesting a larger code window.";
    case "refreshSlice":
      return "Refresh the existing slice before rebuilding broader context.";
    case "buildSlice":
      return "Build a focused slice before escalating to raw code access.";
    case "retryWithSameInputs":
      return "The request may succeed on a later retry with the same inputs.";
    default:
      return undefined;
  }
}

function ownString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return Object.hasOwn(value, key) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

interface ValidatedPolicyGuidance {
  nextBestAction: NextBestAction;
  requiredFieldsForNext: RequiredFieldsForNext;
  nextCall: { action: string; args: Record<string, unknown> };
}

function ownRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const candidate = value[key];
  return typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
    ? (candidate as Readonly<Record<string, unknown>>)
    : undefined;
}

function validatePolicyGuidance(
  policyError: Readonly<Record<string, unknown>>,
): ValidatedPolicyGuidance | undefined {
  const nextBestAction = ownString(policyError, "nextBestAction");
  if (!isPolicyNextBestAction(nextBestAction)) return undefined;

  const requiredFields = ownRecord(policyError, "requiredFieldsForNext");
  if (nextBestAction !== "requestSkeleton" || !requiredFields) {
    return undefined;
  }

  const requestSkeleton = ownRecord(requiredFields, "requestSkeleton");
  if (!requestSkeleton) return undefined;
  const repoId = ownString(requestSkeleton, "repoId");
  const symbolId = ownString(requestSkeleton, "symbolId");
  if (!repoId || !symbolId) return undefined;

  const validated = buildValidatedRecoveryAction(
    {
      action: "sdl.retrieve",
      args: {
        repoId,
        op: "codeSkeleton",
        args: { symbolId },
      },
    },
    {
      repoId,
      advertisedTools: getRecoverySurfaceToolNames(true),
    },
  );
  if (!validated.nextAction) return undefined;

  return {
    nextBestAction,
    requiredFieldsForNext: {
      requestSkeleton: { repoId, symbolId },
    },
    nextCall: {
      action: validated.nextAction.action,
      args: { ...validated.nextAction.args },
    },
  };
}

function filterAdvertisedFallbackTools(
  fallbackTools: readonly unknown[],
  advertisedTools: readonly string[],
): string[] | undefined {
  const activeTools = new Set(advertisedTools);
  const canonicalTools = fallbackTools.flatMap((tool) => {
    if (typeof tool !== "string") return [];
    const canonical = tool.startsWith("sdl.") ? tool : `sdl.${tool}`;
    if (activeTools.has(canonical)) return [canonical];
    return activeTools.has(tool) ? [tool] : [];
  });
  return canonicalTools.length > 0
    ? [...new Set(canonicalTools)]
    : undefined;
}

function validateGeneratedRecoveryCalls(
  nextCalls: readonly unknown[],
  advertisedTools: readonly string[],
  activeWorkflowFunctions?: readonly string[],
): Array<{ action: string; args: Record<string, unknown> }> | undefined {
  const validCalls: Array<{
    action: string;
    args: Record<string, unknown>;
  }> = [];
  const seenCalls = new Set<string>();

  for (const nextCall of nextCalls) {
    if (
      typeof nextCall !== "object" ||
      nextCall === null ||
      Array.isArray(nextCall)
    ) {
      continue;
    }
    const args = ownRecord(nextCall, "args");
    if (!args) continue;

    const repoId = ownString(args, "repoId");
    const actionName =
      ownString(nextCall, "action") ??
      ownString(nextCall, "tool") ??
      ownString(nextCall, "id");
    const canonicalAction = actionName?.startsWith("sdl.")
      ? actionName.slice("sdl.".length)
      : actionName;
    const continuation =
      canonicalAction === "response.get"
        ? {
            ...(typeof args.handle === "string"
              ? { handle: args.handle }
              : {}),
            maxBytes:
              typeof args.maxBytes === "number"
                ? args.maxBytes
                : RECOVERY_DEFAULT_MAX_BYTES,
          }
        : undefined;
    const validated = buildValidatedRecoveryAction(nextCall, {
      ...(repoId ? { repoId } : {}),
      advertisedTools,
      ...(activeWorkflowFunctions
        ? { activeWorkflowFunctions }
        : {}),
      ...(continuation ? { continuation } : {}),
    });
    if (validated.nextAction) {
      const validCall = {
        action: validated.nextAction.action,
        args: { ...validated.nextAction.args },
      };
      const signature = JSON.stringify(validCall);
      if (!seenCalls.has(signature)) {
        seenCalls.add(signature);
        validCalls.push(validCall);
      }
    }
  }

  return validCalls.length > 0 ? validCalls : undefined;
}

export function errorToMcpResponse(
  error: unknown,
  advertisedTools: readonly string[] = FLAT_RECOVERY_TOOL_NAMES,
  activeWorkflowFunctions?: readonly string[],
): Record<string, unknown> {
  if (error instanceof Error) {
    // Only expose the raw message for known domain errors; sanitize unexpected errors.
    const safe = isDomainError(error);
    const detail: McpErrorDetail = {
      message: safe
        ? error.message
        : "An internal error occurred. Check server logs for details.",
    };

    const codeError = error as { code?: string };
    if (codeError.code) {
      detail.code = codeError.code;
    }
    const detailError = error as { details?: string[] };
    if (Array.isArray(detailError.details)) {
      detail.details = detailError.details;
    }

    const policyGuidance = validatePolicyGuidance(
      error as unknown as Readonly<Record<string, unknown>>,
    );
    if (policyGuidance) {
      detail.nextBestAction = policyGuidance.nextBestAction;
      detail.requiredFieldsForNext = policyGuidance.requiredFieldsForNext;
    }

    const classifiedError = error as {
      classification?: string;
      retryable?: boolean;
      suggestedRetryDelayMs?: number;
      fallbackTools?: string[];
      nextCalls?: Array<{
        action?: string;
        tool?: string;
        id?: string;
        args: Record<string, unknown>;
      }>;
      fallbackRationale?: string;
      candidates?: Array<Record<string, unknown>>;
    };
    detail.classification =
      classifiedError.classification ?? defaultClassification(codeError.code);
    detail.retryable = classifiedError.retryable ?? defaultRetryable(codeError.code);
    if (classifiedError.suggestedRetryDelayMs !== undefined) {
      detail.suggestedRetryDelayMs = classifiedError.suggestedRetryDelayMs;
    }
    if (
      Object.hasOwn(classifiedError, "fallbackTools") &&
      Array.isArray(classifiedError.fallbackTools)
    ) {
      const validatedFallbackTools = filterAdvertisedFallbackTools(
        classifiedError.fallbackTools,
        advertisedTools,
      );
      if (validatedFallbackTools) {
        detail.fallbackTools = validatedFallbackTools;
      }
    } else if (policyGuidance) {
      detail.fallbackTools = [policyGuidance.nextCall.action];
    }
    if (
      Object.hasOwn(classifiedError, "nextCalls") &&
      Array.isArray(classifiedError.nextCalls)
    ) {
      const validatedNextCalls = validateGeneratedRecoveryCalls(
        classifiedError.nextCalls,
        advertisedTools,
        activeWorkflowFunctions,
      );
      if (validatedNextCalls) {
        detail.nextCalls = validatedNextCalls;
      }
    } else if (policyGuidance) {
      detail.nextCalls = [policyGuidance.nextCall];
    }
    if (
      Object.hasOwn(classifiedError, "fallbackRationale") &&
      typeof classifiedError.fallbackRationale === "string"
    ) {
      detail.fallbackRationale = classifiedError.fallbackRationale;
    } else if (policyGuidance) {
      detail.fallbackRationale = fallbackRationaleForNextAction(
        policyGuidance.nextBestAction,
      );
    }
    if (Array.isArray(classifiedError.candidates)) {
      detail.candidates = classifiedError.candidates;
    }

    return { error: detail };
  }
  return {
    error: {
      message: "An internal error occurred. Check server logs for details.",
    },
  };
}
