import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

/** Keep status and action-discovery compaction source-compatible. */
export function projectStatusValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  return projectCompatibilityValue(input);
}
