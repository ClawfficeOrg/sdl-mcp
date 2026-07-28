/**
 * `ctx3` encoder for the canonical sdl.context v2 payload.
 */

import { encodeSchemaDriven } from "../schema.js";
import {
  aliasPackedSymbolId,
  appendIntroducedShortIds,
  packedShortIdsActive,
  type PackedShortIdOptions,
} from "../short-ids.js";
import type { TableSpec } from "../types.js";

interface ContextInput {
  status?: string;
  taskType?: string;
  retrieval?: {
    level?: string;
    lanes?: Array<{
      id?: string;
      available?: boolean;
      coveragePermille?: number;
    }>;
  };
  evidence?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  omitted?: {
    total?: number;
    byReason?: { budget?: number; unavailable?: number };
    highestRanked?: Array<Record<string, unknown>>;
  };
  nextActions?: Array<Record<string, unknown>>;
}

const LANES_SPEC: TableSpec = {
  tag: "l",
  key: "retrievalLanes",
  columns: [
    { name: "id", type: "str", intern: true },
    { name: "available", type: "bool" },
    { name: "coveragePermille", type: "int" },
  ],
};
const EVIDENCE_SPEC: TableSpec = {
  tag: "e",
  key: "evidence",
  columns: [
    { name: "rung", type: "str", intern: true },
    { name: "symbolId", type: "str" },
    { name: "path", type: "str" },
    { name: "rank", type: "int" },
    { name: "tier", type: "int" },
    { name: "lanes", type: "str", intern: true },
    { name: "content", type: "str" },
    { name: "ref", type: "str" },
    { name: "unchanged", type: "bool" },
    { name: "changedSincePrior", type: "bool" },
  ],
};
const EDGES_SPEC: TableSpec = {
  tag: "g",
  key: "edges",
  columns: [
    { name: "from", type: "str" },
    { name: "to", type: "str" },
    { name: "kind", type: "str", intern: true },
    { name: "confidencePermille", type: "int" },
  ],
};
const OMITTED_SPEC: TableSpec = {
  tag: "o",
  key: "omitted",
  columns: [
    { name: "symbolId", type: "str" },
    { name: "path", type: "str" },
    { name: "rung", type: "str", intern: true },
    { name: "rank", type: "int" },
    { name: "tier", type: "int" },
    { name: "reason", type: "str", intern: true },
    { name: "actionId", type: "str", intern: true },
    { name: "args", type: "str" },
  ],
};
const ACTIONS_SPEC: TableSpec = {
  tag: "a",
  key: "nextActions",
  columns: [
    { name: "id", type: "str", intern: true },
    { name: "args", type: "str" },
  ],
};

function textValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function symbolId(
  value: unknown,
  options: PackedShortIdOptions,
  introduced: Map<string, string>,
): string {
  return typeof value === "string"
    ? aliasPackedSymbolId(value, options, introduced)
    : "";
}

export function encodePackedContext(
  input: ContextInput,
  options: PackedShortIdOptions = {},
): string {
  const introduced = new Map<string, string>();
  const encoderId = packedShortIdsActive(options)
    ? CONTEXT_SHORT_ID_ENCODER_ID
    : CONTEXT_ENCODER_ID;
  const evidence = (input.evidence ?? []).map((item) => ({
    rung: textValue(item.rung),
    symbolId: symbolId(item.symbolId, options, introduced),
    path: textValue(item.path),
    rank: Number(item.rank ?? 0),
    tier: Number(item.tier ?? 0),
    lanes: Array.isArray(item.lanes) ? item.lanes.join(",") : "",
    content: textValue(item.content),
    ref: textValue(item.ref),
    unchanged: item.unchanged === true,
    changedSincePrior: item.changedSincePrior === true,
  }));
  const edges = (input.edges ?? []).map((edge) => ({
    from: symbolId(edge.from, options, introduced),
    to: symbolId(edge.to, options, introduced),
    kind: textValue(edge.kind),
    confidencePermille: Number(edge.confidencePermille ?? 0),
  }));
  const omitted = (input.omitted?.highestRanked ?? []).map((item) => {
    const action =
      item.action && typeof item.action === "object"
        ? (item.action as Record<string, unknown>)
        : {};
    return {
      symbolId: symbolId(item.symbolId, options, introduced),
      path: textValue(item.path),
      rung: textValue(item.rung),
      rank: Number(item.rank ?? 0),
      tier: Number(item.tier ?? 0),
      reason: textValue(item.reason),
      actionId: textValue(action.id),
      args: textValue(action.args),
    };
  });
  const nextActions = (input.nextActions ?? []).map((action) => ({
    id: textValue(action.id),
    args: textValue(action.args),
  }));
  const retrievalLanes = (input.retrieval?.lanes ?? []).map((lane) => ({
    id: lane.id ?? "",
    available: lane.available === true,
    coveragePermille: lane.coveragePermille ?? 0,
  }));

  const payload = encodeSchemaDriven({
    toolName: "context",
    encoderId,
    scalars: {
      status: input.status ?? "",
      taskType: input.taskType ?? "",
      retrievalLevel: input.retrieval?.level ?? "",
      omittedTotal: input.omitted?.total ?? 0,
      omittedBudget: input.omitted?.byReason?.budget ?? 0,
      omittedUnavailable: input.omitted?.byReason?.unavailable ?? 0,
    },
    scalarTypes: {
      status: "str",
      taskType: "str",
      retrievalLevel: "str",
      omittedTotal: "int",
      omittedBudget: "int",
      omittedUnavailable: "int",
    },
    tables: [
      { spec: LANES_SPEC, rows: retrievalLanes },
      { spec: EVIDENCE_SPEC, rows: evidence },
      { spec: EDGES_SPEC, rows: edges },
      { spec: OMITTED_SPEC, rows: omitted },
      { spec: ACTIONS_SPEC, rows: nextActions },
    ],
    legendCandidates: [
      ...evidence.map((item) => item.path),
      ...omitted.map((item) => item.path),
    ],
  });
  return appendIntroducedShortIds(payload, introduced, options);
}

export const CONTEXT_ENCODER_ID = "ctx3";
export const CONTEXT_SHORT_ID_ENCODER_ID = "ctx4";
