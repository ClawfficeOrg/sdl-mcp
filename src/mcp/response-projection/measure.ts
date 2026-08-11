import { normalizeValue } from "../../util/hashing.js";
import { estimateTokens } from "../../util/tokenize.js";
import { isPolicyNextBestAction } from "./recovery.js";

/**
 * Serialize a copied, key-sorted JSON value. normalizeValue is the repository's
 * canonical deterministic serializer input and does not mutate the source.
 */
export function serializeProjectionValue(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recovery projection removes invalid executable actions. Count only removed
 * recovery fields while walking matching object/array positions.
 */
function countRemovedRecoveryActions(
  rawValue: unknown,
  projectedValue: unknown,
): number {
  if (Array.isArray(rawValue) && Array.isArray(projectedValue)) {
    return rawValue.reduce(
      (count, item, index) =>
        count + countRemovedRecoveryActions(item, projectedValue[index]),
      0,
    );
  }
  if (!isRecord(rawValue) || !isRecord(projectedValue)) return 0;

  let count = 0;
  for (const [key, rawChild] of Object.entries(rawValue)) {
    if (
      (key === "nextAction" ||
        (key === "nextBestAction" && !isPolicyNextBestAction(rawChild))) &&
      rawChild !== undefined &&
      !Object.hasOwn(projectedValue, key)
    ) {
      count += 1;
      continue;
    }
    if (Object.hasOwn(projectedValue, key)) {
      count += countRemovedRecoveryActions(rawChild, projectedValue[key]);
    }
  }
  return count;
}

export function measureProjectionValue(
  value: unknown,
): Readonly<{ bytes: number; tokens: number }> {
  return measureSerializedValue(serializeProjectionValue(value));
}

export function measureProjectionPair(
  rawValue: unknown,
  projectedValue: unknown,
): Readonly<{
  rawBytes: number;
  rawTokens: number;
  projectedBytes: number;
  projectedTokens: number;
  invalidRecoveryCount: number;
}> {
  const raw = measureProjectionValue(rawValue);
  const projected = measureProjectionValue(projectedValue);

  return {
    rawBytes: raw.bytes,
    rawTokens: raw.tokens,
    projectedBytes: projected.bytes,
    projectedTokens: projected.tokens,
    invalidRecoveryCount: countRemovedRecoveryActions(
      rawValue,
      projectedValue,
    ),
  };
}

function measureSerializedValue(
  serialized: string,
): Readonly<{ bytes: number; tokens: number }> {
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    tokens: estimateTokens(serialized),
  };
}
