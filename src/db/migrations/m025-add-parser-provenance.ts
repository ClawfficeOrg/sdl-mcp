import type { Connection } from "kuzu";

import { execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 25;
export const description = "Add parser provenance state";

const DDL = [
  `CREATE NODE TABLE IF NOT EXISTS RepoParserState (
    repoId STRING PRIMARY KEY,
    coverageState STRING,
    graphVersionId STRING,
    graphRevision INT64,
    coverageDigest STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS FileParserState (
    stateId STRING PRIMARY KEY,
    repoId STRING,
    fileId STRING,
    engine STRING,
    engineContract STRING,
    adapterKey STRING,
    language STRING
  )`,
  `CREATE REL TABLE IF NOT EXISTS REPO_PARSER_STATE_IN_REPO (
    FROM RepoParserState TO Repo
  )`,
  `CREATE REL TABLE IF NOT EXISTS FILE_PARSER_STATE_IN_REPO (
    FROM FileParserState TO Repo
  )`,
];

export async function up(conn: Connection): Promise<void> {
  for (const ddl of DDL) {
    try {
      await execDdl(conn, ddl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
    }
  }
}
