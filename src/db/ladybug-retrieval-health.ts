import type { Connection } from "kuzu";

import { querySingle } from "./ladybug-core.js";

export interface RetrievalCoverageRow {
  eligible: unknown;
  covered: unknown;
}

const TRUSTED_RETRIEVAL_VECTOR_PROPERTIES = new Set([
  "embeddingJinaCodeVec",
  "embeddingNomicVec",
]);

function assertTrustedVectorProperty(property: string): void {
  if (!TRUSTED_RETRIEVAL_VECTOR_PROPERTIES.has(property)) {
    throw new Error(`Unsupported vector property: ${property}`);
  }
}

/** Count searchable real symbols and those covered by one trusted vector property. */
export async function getSymbolRetrievalCoverage(
  conn: Connection,
  repoId: string,
  property: string,
): Promise<RetrievalCoverageRow> {
  assertTrustedVectorProperty(property);
  const row = await querySingle<RetrievalCoverageRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
       AND trim(coalesce(s.searchText, '')) <> ''
     RETURN count(DISTINCT s.symbolId) AS eligible,
            count(DISTINCT CASE WHEN s.${property} IS NOT NULL THEN s.symbolId ELSE NULL END) AS covered`,
    { repoId },
  );
  return row ?? { eligible: 0, covered: 0 };
}

/** Count searchable file summaries and those covered by one trusted vector property. */
export async function getFileSummaryRetrievalCoverage(
  conn: Connection,
  repoId: string,
  property: string,
): Promise<RetrievalCoverageRow> {
  assertTrustedVectorProperty(property);
  const row = await querySingle<RetrievalCoverageRow>(
    conn,
    `MATCH (fs:FileSummary {repoId: $repoId})
     WHERE trim(coalesce(fs.searchText, '')) <> ''
     RETURN count(DISTINCT fs.fileId) AS eligible,
            count(DISTINCT CASE WHEN fs.${property} IS NOT NULL THEN fs.fileId ELSE NULL END) AS covered`,
    { repoId },
  );
  return row ?? { eligible: 0, covered: 0 };
}
