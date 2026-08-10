import type { OutputExcerpt } from "../runtime/types.js";
import {
  isWindowsCmdEchoLine,
  RUNTIME_INLINE_OUTPUT_BYTES,
  projectRuntimeOutputExcerpts as projectRuntimeDisplayExcerpts,
} from "./response-projection/projectors/runtime.js";

export { isWindowsCmdEchoLine, RUNTIME_INLINE_OUTPUT_BYTES };

/** Compatibility delegate; runtime display policy is owned by the runtime projector. */
export function projectRuntimeOutputExcerpts(
  excerpts: readonly OutputExcerpt[],
  runtime?: string,
  commandSummary?: string,
): OutputExcerpt[] {
  return projectRuntimeDisplayExcerpts(excerpts, runtime, commandSummary);
}
