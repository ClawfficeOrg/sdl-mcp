import type { TestCaseFacet } from "../domain/types.js";

export const TEST_CASE_MODIFIER_ORDER = [
  "skip",
  "todo",
  "only",
  "parameterized",
] as const;

const TEST_CASE_CATEGORIES = new Set(["test", "benchmark", "example", "fuzz"]);
const TEST_CASE_MODIFIERS = new Set<string>(TEST_CASE_MODIFIER_ORDER);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundText(value: string): string {
  return [...normalizeWhitespace(value)].slice(0, 256).join("");
}

export function normalizeTestCaseFacet(input: unknown): TestCaseFacet | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  if (typeof candidate.framework !== "string" || typeof candidate.title !== "string") {
    return undefined;
  }
  if (
    candidate.suitePath !== undefined &&
    (!Array.isArray(candidate.suitePath) ||
      candidate.suitePath.some((segment) => typeof segment !== "string"))
  ) {
    return undefined;
  }
  if (
    candidate.category !== undefined &&
    (typeof candidate.category !== "string" || !TEST_CASE_CATEGORIES.has(candidate.category))
  ) {
    return undefined;
  }
  if (
    candidate.modifiers !== undefined &&
    (!Array.isArray(candidate.modifiers) ||
      candidate.modifiers.some(
        (modifier) => typeof modifier !== "string" || !TEST_CASE_MODIFIERS.has(modifier),
      ))
  ) {
    return undefined;
  }

  const framework = normalizeWhitespace(candidate.framework).toLowerCase();
  const title = boundText(candidate.title);
  if (!framework || !title) {
    return undefined;
  }

  const normalized: TestCaseFacet = { framework, title };
  const suitePath = (candidate.suitePath as string[] | undefined)
    ?.map(boundText)
    .filter(Boolean)
    .slice(-16);
  if (suitePath?.length) {
    normalized.suitePath = suitePath;
  }
  if (candidate.category !== undefined && candidate.category !== "test") {
    normalized.category = candidate.category as Exclude<TestCaseFacet["category"], "test">;
  }

  const modifierSet = new Set(candidate.modifiers as string[] | undefined);
  const modifiers = TEST_CASE_MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
  if (modifiers.length) {
    normalized.modifiers = modifiers;
  }

  return normalized;
}

export function serializeTestCaseFacet(facet: TestCaseFacet): string | undefined {
  const normalized = normalizeTestCaseFacet(facet);
  return normalized ? JSON.stringify(normalized) : undefined;
}

export function parseTestCaseFacetJson(
  value: string | null | undefined,
): TestCaseFacet | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return normalizeTestCaseFacet(JSON.parse(value));
  } catch {
    return undefined;
  }
}
