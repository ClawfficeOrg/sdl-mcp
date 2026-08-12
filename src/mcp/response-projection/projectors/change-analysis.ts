import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefaultTrimmedSet(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.trimmed !== true &&
    (!Array.isArray(value.keptSymbols) || value.keptSymbols.length === 0) &&
    (!Array.isArray(value.droppedSymbols) || value.droppedSymbols.length === 0) &&
    (value.spilloverHandle === null || value.spilloverHandle === undefined)
  );
}

function isDefaultDeltaTruncation(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.truncated !== true &&
    (value.droppedChanges === 0 || value.droppedChanges === undefined) &&
    (value.droppedBlastRadius === 0 ||
      value.droppedBlastRadius === undefined) &&
    (value.howToResume === null || value.howToResume === undefined)
  );
}

/** Preserve delta and risk semantics while centralizing channel delivery. */
export function projectChangeAnalysisValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const projected = projectCompatibilityValue(input);

  if (
    input.options.detail === "compact" &&
    (input.action === "pr.risk.analyze" ||
      input.action === "sdl.pr.risk.analyze") &&
    isRecord(projected) &&
    isRecord(projected.analysis)
  ) {
    // The summary is the single compact home for scores and counts. Normalize
    // canonical and already-compacted handler results to the same projection.
    const analysis = { ...projected.analysis };
    delete analysis.riskScore;
    delete analysis.riskLevel;
    delete analysis.changedSymbolsCount;
    delete analysis.blastRadiusCount;
    return { ...projected, analysis };
  }

  if (
    (input.action !== "delta.get" && input.action !== "sdl.delta.get") ||
    typeof projected !== "object" ||
    projected === null ||
    !("delta" in projected) ||
    typeof projected.delta !== "object" ||
    projected.delta === null
  ) {
    return projected;
  }

  const delta = projected.delta as Record<string, unknown>;
  if (
    !Array.isArray(delta.changedSymbols) ||
    delta.changedSymbols.length !== 0
  ) {
    return projected;
  }

  if (input.options.detail !== "compact") {
    if (
      input.options.detail !== "standard" ||
      typeof input.canonicalResult !== "object" ||
      input.canonicalResult === null ||
      !("delta" in input.canonicalResult) ||
      typeof input.canonicalResult.delta !== "object" ||
      input.canonicalResult.delta === null
    ) {
      return projected;
    }

    const canonicalDelta = input.canonicalResult.delta as Record<string, unknown>;
    const restoredDelta = { ...delta };
    for (const key of ["blastRadius", "trimmedSet", "truncation"] as const) {
      if (key in canonicalDelta) restoredDelta[key] = canonicalDelta[key];
    }
    return { ...projected, delta: restoredDelta };
  }

  const compactDelta = { ...delta };
  if (Array.isArray(delta.blastRadius) && delta.blastRadius.length === 0) {
    delete compactDelta.blastRadius;
  }
  if (isDefaultTrimmedSet(delta.trimmedSet)) {
    delete compactDelta.trimmedSet;
  }
  if (isDefaultDeltaTruncation(delta.truncation)) {
    delete compactDelta.truncation;
  }
  return { ...projected, delta: compactDelta };
}
