import type { AppConfig } from "../config/types.js";
import { normalizePath } from "../util/paths.js";
import { resolveGraphDbPath } from "./graph-db-path.js";
import {
  initLadybugDb,
  type LadybugDbInitOptions,
} from "./ladybug.js";

export { resolveGraphDbPath } from "./graph-db-path.js";

export async function initGraphDb(
  config: AppConfig,
  resolvedConfigPath: string,
  options?: LadybugDbInitOptions,
): Promise<string> {
  const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);
  await initLadybugDb(graphDbPath, {
    ...options,
    bufferPoolBytes:
      config.graphDatabase?.bufferPoolBytes ?? options?.bufferPoolBytes,
  });
  return normalizePath(graphDbPath);
}
