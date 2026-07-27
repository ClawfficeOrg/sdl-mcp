import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const windowsRuntimePath = resolve(
  repoRoot,
  "dist/db/ladybug-windows-fts-runtime.js",
);
const { isWindowsFtsRuntimeUnavailable, withWindowsFtsRuntime } = await import(
  pathToFileURL(windowsRuntimePath).href
);

let failed = false;

// Keep the Win32 FTS DLL handles alive for the complete in-process test stream.
const result = await withWindowsFtsRuntime(async () => {
  const tests = run({
    files: [resolve(repoRoot, "tests/benchmark/context-quality.test.ts")],
    cwd: repoRoot,
    isolation: "none",
    concurrency: false,
  });
  tests.on("test:fail", () => {
    failed = true;
  });

  const reporter = spec();
  tests.pipe(reporter).pipe(process.stdout, { end: false });
  await finished(reporter);
});

if (isWindowsFtsRuntimeUnavailable(result)) {
  throw new Error(`Windows FTS runtime is unavailable: ${result.reason}`);
}

const exitCode = failed ? 1 : 0;
if (process.env.SDL_CONTEXT_QUALITY_EXIT_PATH) {
  writeFileSync(
    process.env.SDL_CONTEXT_QUALITY_EXIT_PATH,
    `${exitCode}\n`,
    "utf8",
  );
}
process.exitCode = exitCode;
