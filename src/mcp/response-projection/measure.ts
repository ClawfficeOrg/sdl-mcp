import { normalizeValue } from "../../util/hashing.js";
import { estimateTokens } from "../../util/tokenize.js";

/**
 * Serialize a copied, key-sorted JSON value. normalizeValue is the repository's
 * canonical deterministic serializer input and does not mutate the source.
 */
export function serializeProjectionValue(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
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
}> {
  const raw = measureProjectionValue(rawValue);
  const projected = measureProjectionValue(projectedValue);

  return {
    rawBytes: raw.bytes,
    rawTokens: raw.tokens,
    projectedBytes: projected.bytes,
    projectedTokens: projected.tokens,
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
