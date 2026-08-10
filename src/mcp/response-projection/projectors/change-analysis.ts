import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

/** Preserve delta and risk semantics while centralizing channel delivery. */
export function projectChangeAnalysisValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  return projectCompatibilityValue(input);
}
