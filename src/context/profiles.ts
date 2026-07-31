import type { ContextTaskType, TaskProfile } from "./types.js";

const SHARED_BEAM_BEHAVIOR = {
  direction: "out",
  maxDepth: null,
} as const;

// ponytail: keep profiles truthful to the existing beam; differentiate walk
// direction/depth only when eval evidence justifies adding beam support.
export const TASK_PROFILES: Readonly<
  Record<ContextTaskType, TaskProfile>
> = Object.freeze({
  debug: Object.freeze({
    taskType: "debug",
    rungPreference: ["card", "hotPath"] as const,
    ...SHARED_BEAM_BEHAVIOR,
    includeTests: true,
    auxiliaryLanes: ["fileSummary"] as const,
  }),
  review: Object.freeze({
    taskType: "review",
    rungPreference: ["card", "hotPath"] as const,
    ...SHARED_BEAM_BEHAVIOR,
    includeTests: true,
    auxiliaryLanes: ["fileSummary"] as const,
  }),
  implement: Object.freeze({
    taskType: "implement",
    rungPreference: ["card", "skeleton"] as const,
    ...SHARED_BEAM_BEHAVIOR,
    includeTests: false,
    auxiliaryLanes: ["fileSummary"] as const,
  }),
  explain: Object.freeze({
    taskType: "explain",
    rungPreference: ["card", "hotPath"] as const,
    ...SHARED_BEAM_BEHAVIOR,
    includeTests: false,
    auxiliaryLanes: ["fileSummary"] as const,
  }),
});

export function getTaskProfile(taskType: ContextTaskType): TaskProfile {
  return TASK_PROFILES[taskType];
}
