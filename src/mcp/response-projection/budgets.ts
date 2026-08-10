import type { OutputBudgetClass } from "./types.js";

const SUMMARY_TOKEN_LIMIT = 120;
const EMPTY_OR_ERROR_TOKEN_LIMIT = 200;
const SMALL_TOKEN_LIMIT = 500;
const COMPACT_TOKEN_LIMIT = 1_000;
const STANDARD_TOKEN_LIMIT = 2_000;

export const MODEL_VISIBLE_HARD_LIMIT_TOKENS = 8_000;
export const ARTIFACT_PAGE_BYTES = 8_192;
export const ARTIFACT_HARD_MAX_BYTES = 65_536;

/** Fixed budget classes keep model-visible response sizing prompt-cache stable. */
export const OUTPUT_BUDGET_TOKEN_LIMITS = Object.freeze({
  summary: SUMMARY_TOKEN_LIMIT,
  empty: EMPTY_OR_ERROR_TOKEN_LIMIT,
  error: EMPTY_OR_ERROR_TOKEN_LIMIT,
  small: SMALL_TOKEN_LIMIT,
  compact: COMPACT_TOKEN_LIMIT,
  standard: STANDARD_TOKEN_LIMIT,
  full: MODEL_VISIBLE_HARD_LIMIT_TOKENS,
  diagnostic: MODEL_VISIBLE_HARD_LIMIT_TOKENS,
} as const satisfies Readonly<Record<OutputBudgetClass, number>>);

export function getOutputBudgetTokenLimit(
  budgetClass: OutputBudgetClass,
): number {
  return OUTPUT_BUDGET_TOKEN_LIMITS[budgetClass];
}

/**
 * Combine the selected class, an optional caller cap, and the global hard cap.
 * The lowest limit always wins.
 */
export function getCombinedModelVisibleTokenLimit(
  budgetClass: OutputBudgetClass,
  requestedMaxTokens: number = MODEL_VISIBLE_HARD_LIMIT_TOKENS,
): number {
  return Math.min(
    getOutputBudgetTokenLimit(budgetClass),
    requestedMaxTokens,
    MODEL_VISIBLE_HARD_LIMIT_TOKENS,
  );
}
