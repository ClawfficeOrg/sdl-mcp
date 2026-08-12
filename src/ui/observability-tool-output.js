const MAX_TOOL_ROWS = 12;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function detailCounts(value) {
  const counts = value && typeof value === "object" ? value : {};
  return {
    summary: finiteNumber(counts.summary),
    compact: finiteNumber(counts.compact),
    standard: finiteNumber(counts.standard),
    full: finiteNumber(counts.full),
  };
}

function mapMetric(metric) {
  return {
    calls: finiteNumber(metric.calls),
    errors: finiteNumber(metric.errors),
    reductionRatio: finiteNumber(metric.reductionRatio),
    handledCount: finiteNumber(metric.handledCount),
    truncatedCount: finiteNumber(metric.truncatedCount),
    detailCounts: detailCounts(metric.detailCounts),
    recoveryEmittedCount: finiteNumber(metric.recoveryEmittedCount),
    invalidRecoveryCount: finiteNumber(metric.invalidRecoveryCount),
    p50ProjectedTokens: finiteNumber(metric.p50ProjectedTokens),
    p95ProjectedTokens: finiteNumber(metric.p95ProjectedTokens),
  };
}

/**
 * Maps the bounded observability aggregate to the dashboard's display contract.
 * It deliberately picks only aggregate fields, so payload or path fields cannot
 * cross into the DOM even when a caller supplies an unexpected object.
 */
export function buildToolOutputViewModel(toolOutput) {
  if (
    !toolOutput ||
    typeof toolOutput !== "object" ||
    toolOutput.schemaVersion !== 1 ||
    !toolOutput.overall ||
    finiteNumber(toolOutput.overall.calls) === 0
  ) {
    return { hasData: false, summary: null, rows: [] };
  }

  const rows = (Array.isArray(toolOutput.perTool) ? toolOutput.perTool : [])
    .filter(
      (metric) =>
        metric &&
        typeof metric === "object" &&
        typeof metric.tool === "string",
    )
    .map((metric) => ({ tool: metric.tool, ...mapMetric(metric) }))
    .sort((left, right) =>
      left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0,
    )
    .slice(0, MAX_TOOL_ROWS);

  return {
    hasData: true,
    summary: mapMetric(toolOutput.overall),
    rows,
  };
}
