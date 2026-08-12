#!/usr/bin/env node
/** Delegate checking to the generator so extraction logic has one owner. */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    resolve(process.cwd(), "scripts/generate-tool-inventory.ts"),
    "--check",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
