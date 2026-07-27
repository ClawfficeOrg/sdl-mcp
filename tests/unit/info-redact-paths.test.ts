import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { basename, join } from "path";

import { handleInfo, redactInfoPaths } from "../../dist/mcp/tools/info.js";

// ---------------------------------------------------------------------------
// Regression guard for the info.ts path disclosure fix. Confirms that passing
// { redactPaths: true } replaces config/LadybugDB/native paths with basenames
// and logging paths with a stable marker, so HTTP-transport or multi-tenant
// deployments can avoid leaking the server's filesystem layout.
// ---------------------------------------------------------------------------

describe("handleInfo path redaction", () => {
  it("returns absolute paths by default (backward compatible)", async () => {
    const report = await handleInfo();
    // Should have at least a config.path string
    assert.equal(typeof report.config.path, "string");
    // Most deployments will have a config path that is either absolute or
    // the default relative path; either way, the key must be present.
    assert.ok("path" in report.config);
  });

  it("redacts config, LadybugDB, and native paths to basenames", async () => {
    const full = await handleInfo();
    const redacted = await handleInfo({ redactPaths: true });

    // config.path is always present as a string. Basenames have no slashes
    // and no Windows drive letters, and never contain a path separator that
    // is not at the end of the string.
    assert.equal(redacted.config.path, basename(full.config.path));
    assert.equal(redacted.logging.path, full.logging.path === null ? null : "<redacted>");
    assert.equal(redacted.ladybug.activePath, full.ladybug.activePath === null ? null : basename(full.ladybug.activePath));
    assert.equal(redacted.native.sourcePath, full.native.sourcePath === null ? null : basename(full.native.sourcePath));

    // The basename should not contain path separators.
    assert.ok(!redacted.config.path.includes("/"));
    assert.ok(!redacted.config.path.includes("\\"));
  });

  it("redacts a non-null logging path to a stable marker", async () => {
    const report = await handleInfo();
    const redacted = redactInfoPaths({
      ...report,
      logging: { ...report.logging, path: "C:\\logs\\sdl-mcp-2026-07-26-1234.log" },
    });

    assert.equal(redacted.logging.path, "<redacted>");
  });

  it("preserves a null logging path", async () => {
    const report = await handleInfo();
    const redacted = redactInfoPaths({
      ...report,
      logging: { ...report.logging, path: null },
    });

    assert.equal(redacted.logging.path, null);
  });

  it("redacts the exact fallback warning while preserving unrelated warnings", async () => {
    const report = await handleInfo();
    const path = "C:\\logs\\sdl-mcp-2026-07-26-1234.log";
    const fallbackWarning = `Log path fallback in use: ${path}`;
    const redacted = redactInfoPaths({
      ...report,
      logging: { ...report.logging, path, fallbackUsed: true },
      warnings: [fallbackWarning, "Unrelated warning"],
    });

    assert.deepEqual(redacted.warnings, [
      "Log path fallback in use: <redacted>",
      "Unrelated warning",
    ]);
  });

  it("redacts a missing config path from the complete response", async () => {
    const previousConfig = process.env.SDL_CONFIG;
    const missingConfigPath = join(
      tmpdir(),
      `sdl-info-redaction-missing-${process.pid}`,
      "private",
      "sdl.config.json",
    );
    try {
      process.env.SDL_CONFIG = missingConfigPath;
      const redacted = await handleInfo({ redactPaths: true });

      assert.equal(redacted.config.path, basename(missingConfigPath));
      assert.equal(
        JSON.stringify(redacted).includes(missingConfigPath),
        false,
      );
      assert.deepEqual(redacted.misconfigurations, [
        `Config file not found: ${basename(missingConfigPath)}`,
      ]);
    } finally {
      if (previousConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousConfig;
    }
  });

  it("leaves non-path fields untouched when redactPaths: true", async () => {
    const full = await handleInfo();
    const redacted = await handleInfo({ redactPaths: true });
    assert.equal(redacted.version, full.version);
    assert.equal(redacted.runtime.node, full.runtime.node);
    assert.equal(redacted.runtime.platform, full.runtime.platform);
    assert.equal(redacted.config.exists, full.config.exists);
    assert.equal(redacted.ladybug.available, full.ladybug.available);
  });
});
