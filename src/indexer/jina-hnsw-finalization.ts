import type { Connection } from "kuzu";

import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import type { AppConfig } from "../config/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import { assertPhysicalSymbolUniqueness } from "../db/ladybug-symbols.js";
import {
  readDeterministicSymbolVectorProbe,
  readRepoSymbolVectorProbe,
  readSymbolNumericVector,
  type SymbolNumericVectorProbe,
} from "../db/ladybug-symbol-embeddings.js";
import {
  createVectorIndex,
  queryVectorIndexProbe,
  showIndexesStrict,
  type IndexInfo,
} from "../retrieval/index-lifecycle.js";
import { EMBEDDING_MODELS } from "../retrieval/model-mapping.js";
import { runHnswRebuildCycle } from "./hnsw-rebuild-cycle.js";

export const JINA_CODE_MODEL = "jina-embeddings-v2-base-code";

export interface ConfiguredJinaHnswSpec {
  model: typeof JINA_CODE_MODEL;
  indexName: string;
  vectorProperty: string;
  dimension: number;
  efc: number;
}

export type ReopenedJinaHnswOutcome =
  | "created"
  | "validated-existing"
  | "skipped-empty";

export interface ReopenedJinaHnswFinalizationResult
  extends ConfiguredJinaHnswSpec {
  outcome: ReopenedJinaHnswOutcome;
  catalogMutated: boolean;
  probe: SymbolNumericVectorProbe | null;
  createMs: number;
  queryMs: number;
  checkpointMs: number;
}

interface JinaHnswFinalizationDependencies {
  getLadybugConn: typeof getLadybugConn;
  withWriteConn: typeof withWriteConn;
  runHnswRebuildCycle: typeof runHnswRebuildCycle;
  showIndexesStrict: typeof showIndexesStrict;
  createVectorIndex: typeof createVectorIndex;
  readRepoSymbolVectorProbe: typeof readRepoSymbolVectorProbe;
  readDeterministicSymbolVectorProbe: typeof readDeterministicSymbolVectorProbe;
  readSymbolNumericVector: typeof readSymbolNumericVector;
  queryVectorIndexProbe: typeof queryVectorIndexProbe;
  assertPhysicalSymbolUniqueness: typeof assertPhysicalSymbolUniqueness;
}

const DEFAULT_FINALIZATION_DEPENDENCIES: JinaHnswFinalizationDependencies = {
  getLadybugConn,
  withWriteConn,
  runHnswRebuildCycle,
  showIndexesStrict,
  createVectorIndex,
  readRepoSymbolVectorProbe,
  readDeterministicSymbolVectorProbe,
  readSymbolNumericVector,
  queryVectorIndexProbe,
  assertPhysicalSymbolUniqueness,
};

/** Resolve the configured Symbol HNSW index only when the Jina lane is active. */
export function resolveConfiguredJinaHnswSpec(
  config: AppConfig,
): ConfiguredJinaHnswSpec | undefined {
  const semanticConfig = config.semantic;
  if (
    !semanticConfig?.enabled ||
    semanticConfig.retrieval?.vector.enabled === false ||
    !resolveSemanticEmbeddingModelPlan(
      semanticConfig,
    ).symbolEmbeddingModels.includes(JINA_CODE_MODEL)
  ) {
    return undefined;
  }

  const modelInfo = EMBEDDING_MODELS[JINA_CODE_MODEL];
  const vectorConfig = semanticConfig.retrieval?.vector;
  return {
    model: JINA_CODE_MODEL,
    indexName:
      vectorConfig?.indexes?.[JINA_CODE_MODEL]?.indexName ?? modelInfo.indexName,
    vectorProperty: modelInfo.vecProperty,
    dimension: modelInfo.dimension,
    efc: vectorConfig?.efc ?? 200,
  };
}

function failFinalization(message: string): never {
  throw new Error(`Post-reopen Jina HNSW finalization failed: ${message}`);
}

function configuredIndex(
  indexes: readonly IndexInfo[],
  spec: ConfiguredJinaHnswSpec,
): IndexInfo | undefined {
  return indexes.find((index) => index.name === spec.indexName);
}

function requireHealthyConfiguredIndex(
  index: IndexInfo | undefined,
  spec: ConfiguredJinaHnswSpec,
): void {
  if (
    !index ||
    index.tableName !== "Symbol" ||
    index.property !== spec.vectorProperty ||
    index.type !== "vector" ||
    index.status !== "healthy" ||
    index.extensionLoaded !== true
  ) {
    failFinalization(
      `configured index ${spec.indexName} is not healthy on Symbol.${spec.vectorProperty}`,
    );
  }
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA > 0 && normB > 0
    ? 1 - dot / Math.sqrt(normA * normB)
    : Number.POSITIVE_INFINITY;
}

export async function validateReopenedJinaHnsw(
  params: {
    spec: ConfiguredJinaHnswSpec;
    probe: SymbolNumericVectorProbe;
  },
  dependencies: JinaHnswFinalizationDependencies =
    DEFAULT_FINALIZATION_DEPENDENCIES,
): Promise<number> {
  const conn = await dependencies.getLadybugConn();
  requireHealthyConfiguredIndex(
    configuredIndex(await dependencies.showIndexesStrict(conn), params.spec),
    params.spec,
  );

  const startedAt = Date.now();
  const rows = await dependencies.queryVectorIndexProbe(
    conn,
    params.spec.indexName,
    params.probe.vector,
  );
  const queryMs = Date.now() - startedAt;
  if (rows.length === 0) {
    failFinalization(`query returned no rows from ${params.spec.indexName}`);
  }

  const nearZeroRows = rows.filter(
    (row) => Number.isFinite(row.distance) && Math.abs(row.distance) <= 1e-6,
  );
  if (nearZeroRows.length === 0) {
    failFinalization(
      `query returned no near-zero neighbor from ${params.spec.indexName}`,
    );
  }

  for (const row of nearZeroRows) {
    const persisted = await dependencies.readSymbolNumericVector(
      conn,
      row.symbolId,
      params.spec.model,
    );
    if (
      persisted &&
      persisted.length === params.probe.vector.length &&
      persisted.every(Number.isFinite) &&
      Math.abs(cosineDistance(params.probe.vector, persisted)) <= 1e-6
    ) {
      return queryMs;
    }
  }

  failFinalization("query returned no persisted vector matching its probe");
}

export async function prepareReopenedJinaHnsw(
  params: {
    spec: ConfiguredJinaHnswSpec;
    selectedFullRepoIds: readonly string[];
    requireAbsent: boolean;
  },
  dependencies: JinaHnswFinalizationDependencies =
    DEFAULT_FINALIZATION_DEPENDENCIES,
): Promise<ReopenedJinaHnswFinalizationResult> {
  const conn = await dependencies.getLadybugConn();
  const existing = configuredIndex(
    await dependencies.showIndexesStrict(conn),
    params.spec,
  );
  if (existing && params.requireAbsent) {
    failFinalization(
      `Jina HNSW deferral failed: ${params.spec.indexName} already exists after reopen`,
    );
  }
  if (existing) requireHealthyConfiguredIndex(existing, params.spec);

  for (const repoId of params.selectedFullRepoIds) {
    const repoProbe = await dependencies.readRepoSymbolVectorProbe(
      conn,
      repoId,
      params.spec.model,
    );
    if (repoProbe.symbolCount > 0 && !repoProbe.probe) {
      failFinalization(
        `non-empty selected full repository ${repoId} has ${repoProbe.symbolCount} Symbol rows but no valid Jina vector`,
      );
    }
  }

  const probe = await dependencies.readDeterministicSymbolVectorProbe(
    conn,
    params.spec.model,
  );
  if (!probe) {
    const symbols = await dependencies.assertPhysicalSymbolUniqueness(conn);
    if (symbols.physicalTotal > 0) {
      failFinalization(
        `non-empty candidate has ${symbols.physicalTotal} Symbol rows but no valid Jina vectors`,
      );
    }
    return {
      ...params.spec,
      outcome: "skipped-empty",
      catalogMutated: false,
      probe: null,
      createMs: 0,
      queryMs: 0,
      checkpointMs: 0,
    };
  }

  if (existing) {
    const queryMs = await validateReopenedJinaHnsw(
      { spec: params.spec, probe },
      dependencies,
    );
    return {
      ...params.spec,
      outcome: "validated-existing",
      catalogMutated: false,
      probe,
      createMs: 0,
      queryMs,
      checkpointMs: 0,
    };
  }

  let createMs = 0;
  let checkpointMs = 0;
  await dependencies.runHnswRebuildCycle(
    "reopened-jina-hnsw-finalization-pre",
    "reopened-jina-hnsw-finalization-post",
    () =>
      dependencies.withWriteConn(async (writeConn: Connection) => {
        const startedAt = Date.now();
        const created = await dependencies.createVectorIndex(
          writeConn,
          "Symbol",
          params.spec.vectorProperty,
          params.spec.indexName,
          params.spec.dimension,
          params.spec.efc,
        );
        createMs = Date.now() - startedAt;
        if (!created) {
          failFinalization(`could not create ${params.spec.indexName}`);
        }
        requireHealthyConfiguredIndex(
          configuredIndex(
            await dependencies.showIndexesStrict(writeConn),
            params.spec,
          ),
          params.spec,
        );
      }),
    undefined,
    (_phaseName, durationMs) => {
      checkpointMs += durationMs;
    },
  );

  return {
    ...params.spec,
    outcome: "created",
    catalogMutated: true,
    probe,
    createMs,
    queryMs: 0,
    checkpointMs,
  };
}
