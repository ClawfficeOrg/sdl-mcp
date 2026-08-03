import type { RepoConfig } from "../config/types.js";
import { withWriteConn } from "../db/ladybug.js";
import { getFileCount } from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

export function resolvePostIndexSessionTimeoutMs(
  repoId: string,
  liveRepos: RepoConfig[],
  storedRepoConfig: RepoConfig,
): number | undefined {
  // Prefer the live config file so timeout tuning does not require
  // re-registering an existing repository.
  return (
    liveRepos.find((repo) => repo.repoId === repoId)
      ?.postIndexSessionTimeoutMs ?? storedRepoConfig.postIndexSessionTimeoutMs
  );
}

export async function resolveEffectiveIndexMode(
  repoId: string,
  requestedMode: "full" | "incremental",
): Promise<"full" | "incremental"> {
  if (requestedMode === "full") return "full";

  // Use the pre-index writer for this one probe so a long-lived verifier read
  // cannot serialize mode resolution behind an occupied round-robin pool slot.
  const fileCount = await withWriteConn((conn) => getFileCount(conn, repoId));
  if (fileCount > 0) return "incremental";

  logger.info(
    "indexRepo: upgrading mode 'incremental' → 'full' (repo has no indexed files)",
    { repoId },
  );
  return "full";
}
