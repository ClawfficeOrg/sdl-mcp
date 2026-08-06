import type { AppConfig } from "../config/types.js";
import { normalizePath } from "../util/paths.js";
import { resolveGraphDbPath } from "./graph-db-path.js";
import {
  initLadybugDb,
  initSafeRebuildLadybugDb,
  reopenSafeRebuildLadybugDb,
  type LadybugDbInitOptions,
  type SafeRebuildLadybugSession,
} from "./ladybug.js";

export { resolveGraphDbPath } from "./graph-db-path.js";

function graphDbOptions(
  config: AppConfig,
  options?: LadybugDbInitOptions,
): LadybugDbInitOptions {
  return {
    ...options,
    bufferPoolBytes:
      config.graphDatabase?.bufferPoolBytes ?? options?.bufferPoolBytes,
  };
}

export async function initGraphDb(
  config: AppConfig,
  resolvedConfigPath: string,
  options?: LadybugDbInitOptions,
): Promise<string> {
  const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);
  await initLadybugDb(graphDbPath, graphDbOptions(config, options));
  return normalizePath(graphDbPath);
}

export interface SafeRebuildGraphDbHandle {
  graphDbPath: string;
  session: SafeRebuildLadybugSession;
}

export async function initSafeRebuildGraphDb(
  config: AppConfig,
  resolvedConfigPath: string,
): Promise<SafeRebuildGraphDbHandle> {
  const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);
  const session = await initSafeRebuildLadybugDb(
    graphDbPath,
    graphDbOptions(config),
  );
  return { graphDbPath: normalizePath(graphDbPath), session };
}

export async function reopenSafeRebuildGraphDb(
  config: AppConfig,
  resolvedConfigPath: string,
  session: SafeRebuildLadybugSession,
  options?: LadybugDbInitOptions,
): Promise<string> {
  const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);
  if (normalizePath(graphDbPath) !== session.dbPath) {
    throw new Error("Safe-rebuild reopen path does not match its family lease");
  }
  await reopenSafeRebuildLadybugDb(session, graphDbOptions(config, options));
  return normalizePath(graphDbPath);
}
