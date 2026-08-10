import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

/** Preserve workflow-specific compaction while the compatibility facade migrates. */
export function projectWorkflowValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  return projectCompatibilityValue(input);
}
