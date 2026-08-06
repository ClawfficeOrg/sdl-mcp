import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import type { AppConfig } from "../config/types.js";
import { EMBEDDING_MODELS } from "../retrieval/model-mapping.js";

export const JINA_CODE_MODEL = "jina-embeddings-v2-base-code";

export interface ConfiguredJinaHnswSpec {
  model: typeof JINA_CODE_MODEL;
  indexName: string;
  vectorProperty: string;
  dimension: number;
  efc: number;
}

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
