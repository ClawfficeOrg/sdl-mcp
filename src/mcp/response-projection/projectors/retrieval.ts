import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

/** Keep existing retrieval presentation selection behind the new boundary. */
export function projectRetrievalValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  return projectCompatibilityValue(input);
}
