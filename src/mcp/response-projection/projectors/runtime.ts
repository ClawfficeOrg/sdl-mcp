import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

/** Project runtime, artifact, and mutation responses without changing handlers. */
export function projectRuntimeValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  return projectCompatibilityValue(input);
}
