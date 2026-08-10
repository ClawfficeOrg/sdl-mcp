/**
 * Model-facing detail requested from a projector. Diagnostics remain an
 * independent opt-in so increasing detail never enables them implicitly.
 */
export type DetailLevel = "summary" | "compact" | "standard" | "full";

/** Public callers use three stable levels; summary remains projector-internal. */
export type ProjectionDetailLevel = "compact" | "standard" | "full";

export type OutputBudgetClass =
  | "summary"
  | "empty"
  | "error"
  | "small"
  | "compact"
  | "standard"
  | "full"
  | "diagnostic";

export type LargeResponseStrategy = "truncate" | "artifact";

export type RecoveryPolicy = "none" | "on-truncation";

/** Stable identifiers let registries name behavior without coupling to functions. */
export type ProjectorId = string;
export type ObservabilityProfileId = string;

export interface ProjectionProfile {
  readonly projector: ProjectorId;
  readonly observabilityProfile: ObservabilityProfileId;
  readonly defaultDetail: DetailLevel;
  readonly budgetClass: OutputBudgetClass;
  readonly largeResponseStrategy: LargeResponseStrategy;
  readonly recoveryPolicy: RecoveryPolicy;
}

export interface ProjectionStats {
  readonly profile: ProjectionProfile;
  readonly effectiveDetail: DetailLevel;
  readonly diagnosticsIncluded: boolean;
  readonly rawBytes: number;
  readonly rawTokens: number;
  readonly projectedBytes: number;
  readonly projectedTokens: number;
  readonly removedFieldCount: number;
  readonly truncated: boolean;
  readonly responseHandled: boolean;
  readonly recoveryEmitted: boolean;
}

export interface ModelProjection<T = unknown> {
  readonly value: T;
  readonly stats: ProjectionStats;
}

export interface ProjectionRequestOptions {
  readonly detail?: ProjectionDetailLevel;
  readonly includeDiagnostics?: boolean;
  readonly budgetClass?: OutputBudgetClass;
  readonly maxTokens?: number;
  readonly largeResponseStrategy?: LargeResponseStrategy;
  readonly recoveryPolicy?: RecoveryPolicy;
}

export interface EffectiveProjectionRequestOptions {
  readonly detail: ProjectionDetailLevel;
  readonly includeDiagnostics: boolean;
}
