import type { Connection } from "kuzu";

import { exec, execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 24;
export const description =
  "Add semantic test-case metadata and require graph rebuild";

const DDL = [
  "ALTER TABLE Symbol ADD testCaseJson STRING DEFAULT NULL",
  "ALTER TABLE SymbolVersion ADD testCaseJson STRING DEFAULT NULL",
];

export async function up(conn: Connection): Promise<void> {
  for (const ddl of DDL) {
    try {
      await execDdl(conn, ddl);
    } catch (error) {
      // Partial DDL may survive a failed migration transaction; reruns skip it.
      const message = error instanceof Error ? error.message : String(error);
      if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
    }
  }

  await exec(
    conn,
    `MATCH (d:DerivedState)
     SET d.graphIntegrityState = 'unknown',
         d.graphIntegrityVersionId = NULL,
         d.graphIntegrityDigest = NULL,
         d.graphIntegrityError = NULL,
         d.graphIntegrityRevision = NULL,
         d.graphIntegrityVerifiedRevision = NULL,
         d.graphIntegrityFilelessPruningSupported = NULL,
         d.graphIntegrityManifestEstablished = false`,
  );
}
