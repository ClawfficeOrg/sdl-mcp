import type { DetailLevel } from "./types.js";

const DETAIL_LEVEL_ORDER: readonly DetailLevel[] = [
  "summary",
  "compact",
  "standard",
  "full",
];

export function compareDetailLevels(
  left: DetailLevel,
  right: DetailLevel,
): -1 | 0 | 1 {
  const difference = DETAIL_LEVEL_ORDER.indexOf(left)
    - DETAIL_LEVEL_ORDER.indexOf(right);
  return difference === 0 ? 0 : difference < 0 ? -1 : 1;
}

export function isDetailAtLeast(
  detail: DetailLevel,
  minimum: DetailLevel,
): boolean {
  return compareDetailLevels(detail, minimum) >= 0;
}

export function isNullishProjectionValue(value: unknown): boolean {
  return value === null || value === undefined;
}

/** Match only explicit top-level empty values; this never walks nested data. */
export function isEmptyProjectionValue(value: unknown): boolean {
  if (value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return Boolean(
    value
      && typeof value === "object"
      && Object.keys(value).length === 0,
  );
}

export function isDefaultProjectionValue(
  value: unknown,
  defaultValue: unknown,
): boolean {
  return Object.is(value, defaultValue);
}

/**
 * Construct an object in caller-declared field order. Only declared fields are
 * considered, and omission is delegated to an explicit field-aware predicate.
 */
export function buildStableObject(
  source: Readonly<Record<string, unknown>>,
  orderedFields: readonly string[],
  shouldOmit: (field: string, value: unknown) => boolean,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of orderedFields) {
    if (!Object.hasOwn(source, field)) {
      continue;
    }
    const value = source[field];
    if (!shouldOmit(field, value)) {
      projected[field] = value;
    }
  }
  return projected;
}

export function filterDiagnosticFields(
  diagnostics: Readonly<Record<string, unknown>>,
  allowlist: readonly string[],
  shouldOmit: (field: string, value: unknown) => boolean,
): Record<string, unknown> {
  return buildStableObject(diagnostics, allowlist, shouldOmit);
}
