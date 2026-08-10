import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARTIFACT_HARD_MAX_BYTES,
  ARTIFACT_PAGE_BYTES,
  MODEL_VISIBLE_HARD_LIMIT_TOKENS,
  OUTPUT_BUDGET_TOKEN_LIMITS,
  getCombinedModelVisibleTokenLimit,
  getOutputBudgetTokenLimit,
} from "../../dist/mcp/response-projection/budgets.js";
import {
  buildStableObject,
  compareDetailLevels,
  filterDiagnosticFields,
  isDefaultProjectionValue,
  isDetailAtLeast,
  isEmptyProjectionValue,
  isNullishProjectionValue,
} from "../../dist/mcp/response-projection/core.js";
import {
  measureProjectionPair,
  measureProjectionValue,
  serializeProjectionValue,
} from "../../dist/mcp/response-projection/measure.js";
import type {
  DetailLevel,
  LargeResponseStrategy,
  ModelProjection,
  ObservabilityProfileId,
  OutputBudgetClass,
  ProjectionProfile,
  ProjectionRequestOptions,
  ProjectionStats,
  ProjectorId,
  RecoveryPolicy,
} from "../../dist/mcp/response-projection/types.js";
import {
  OUTPUT_BUDGET_TOKEN_LIMITS as COMPATIBILITY_BUDGET_LIMITS,
  measureProjectionValue as measureCompatibilityProjectionValue,
} from "../../dist/mcp/context-response-projection.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

describe("response-projection contracts", () => {
  it("defines the fixed model and artifact budgets", () => {
    const emptyOrErrorLimit = 200;
    const hardLimit = 8_000;
    const expectedLimits = {
      summary: 120,
      empty: emptyOrErrorLimit,
      error: emptyOrErrorLimit,
      small: 500,
      compact: 1_000,
      standard: 2_000,
      full: hardLimit,
      diagnostic: hardLimit,
    } as const;

    assert.deepEqual(OUTPUT_BUDGET_TOKEN_LIMITS, expectedLimits);
    assert.equal(MODEL_VISIBLE_HARD_LIMIT_TOKENS, expectedLimits.full);
    assert.equal(ARTIFACT_PAGE_BYTES, 8_192);
    assert.equal(ARTIFACT_HARD_MAX_BYTES, 65_536);
    assert.equal(Object.isFrozen(OUTPUT_BUDGET_TOKEN_LIMITS), true);
    assert.equal(
      getOutputBudgetTokenLimit("compact"),
      expectedLimits.compact,
    );
    assert.equal(
      getCombinedModelVisibleTokenLimit(
        "diagnostic",
        expectedLimits.standard,
      ),
      expectedLimits.standard,
    );
  });

  it("measures canonical JSON deterministically without mutating inputs", () => {
    const input = {
      zeta: "é",
      alpha: {
        retainedFalse: false,
        retainedZero: 0,
      },
    };
    const original = structuredClone(input);
    const canonical = serializeProjectionValue(input);

    assert.equal(
      canonical,
      '{"alpha":{"retainedFalse":false,"retainedZero":0},"zeta":"é"}',
    );
    assert.equal(
      serializeProjectionValue({
        alpha: input.alpha,
        zeta: input.zeta,
      }),
      canonical,
    );
    assert.equal(measureProjectionValue("é").bytes, 4);
    assert.deepEqual(measureProjectionValue(input), {
      bytes: Buffer.byteLength(canonical, "utf8"),
      tokens: estimateTokens(canonical),
    });

    const projected = {
      retainedFalse: false,
      retainedZero: 0,
    };
    const projectedCanonical = serializeProjectionValue(projected);
    assert.deepEqual(measureProjectionPair(input, projected), {
      rawBytes: Buffer.byteLength(canonical, "utf8"),
      rawTokens: estimateTokens(canonical),
      projectedBytes: Buffer.byteLength(projectedCanonical, "utf8"),
      projectedTokens: estimateTokens(projectedCanonical),
    });
    assert.deepEqual(input, original);
  });

  it("keeps allowlisted false and zero while omitting explicit no-op values", () => {
    const diagnostics = {
      hidden: "internal",
      enabled: false,
      count: 0,
      signal: null,
      warnings: [],
      label: "",
      detail: "standard",
    };
    const orderedFields = [
      "enabled",
      "count",
      "signal",
      "warnings",
      "label",
      "detail",
    ] as const;
    const defaults: Readonly<Record<string, unknown>> = {
      detail: "standard",
    };
    const shouldOmit = (key: string, value: unknown): boolean =>
      isNullishProjectionValue(value)
      || isEmptyProjectionValue(value)
      || (
        Object.hasOwn(defaults, key)
        && isDefaultProjectionValue(value, defaults[key])
      );

    assert.deepEqual(
      buildStableObject(diagnostics, orderedFields, shouldOmit),
      {
        enabled: false,
        count: 0,
      },
    );
    assert.deepEqual(
      filterDiagnosticFields(diagnostics, orderedFields, shouldOmit),
      {
        enabled: false,
        count: 0,
      },
    );
    assert.deepEqual(Object.keys(
      filterDiagnosticFields(diagnostics, orderedFields, shouldOmit),
    ), ["enabled", "count"]);
    assert.equal(isEmptyProjectionValue(false), false);
    assert.equal(isEmptyProjectionValue(0), false);
  });

  it("defines monotonic detail and typed projection contracts", () => {
    const detail: DetailLevel = "standard";
    const budgetClass: OutputBudgetClass = "standard";
    const largeResponseStrategy: LargeResponseStrategy = "artifact";
    const recoveryPolicy: RecoveryPolicy = "on-truncation";
    const projector: ProjectorId = "generic";
    const observabilityProfile: ObservabilityProfileId = "default";
    const profile: ProjectionProfile = {
      projector,
      observabilityProfile,
      defaultDetail: detail,
      budgetClass,
      largeResponseStrategy,
      recoveryPolicy,
    };
    const stats: ProjectionStats = {
      profile,
      effectiveDetail: detail,
      diagnosticsIncluded: false,
      rawBytes: 10,
      rawTokens: 3,
      projectedBytes: 8,
      projectedTokens: 2,
      removedFieldCount: 1,
      truncated: false,
      responseHandled: false,
      recoveryEmitted: false,
    };
    const projection: ModelProjection<{ ok: boolean }> = {
      value: { ok: true },
      stats,
    };
    const options: ProjectionRequestOptions = {
      detail,
      includeDiagnostics: false,
      budgetClass,
      largeResponseStrategy,
      recoveryPolicy,
    };

    assert.equal(compareDetailLevels("summary", "summary"), 0);
    assert.equal(compareDetailLevels("compact", "standard"), -1);
    assert.equal(compareDetailLevels("full", "compact"), 1);
    assert.equal(isDetailAtLeast("standard", "compact"), true);
    assert.equal(isDetailAtLeast("compact", "standard"), false);
    assert.deepEqual(projection.value, { ok: true });
    assert.equal(options.detail, "standard");
  });

  it("re-exports the shared foundation from the compatibility boundary", () => {
    assert.equal(
      COMPATIBILITY_BUDGET_LIMITS,
      OUTPUT_BUDGET_TOKEN_LIMITS,
    );
    assert.equal(
      measureCompatibilityProjectionValue,
      measureProjectionValue,
    );
  });
});
