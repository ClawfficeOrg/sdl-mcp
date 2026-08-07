import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  getNativeContentParserCapability,
  isRustEngineAvailable,
  parseContentRust,
  parseFilesRust,
  type RustParseResult,
} from "../../dist/indexer/rustIndexer.js";

function canonicalParseResult(result: RustParseResult) {
  return {
    relPath: result.relPath,
    contentHash: result.contentHash,
    content: result.content,
    symbols: result.symbols.map((symbol) => ({
      symbolId: symbol.symbolId,
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      astFingerprint: symbol.astFingerprint,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
      decorators: symbol.decorators,
      testCase: symbol.testCase,
      summary: symbol.summary,
      invariantsJson: symbol.invariantsJson,
      sideEffectsJson: symbol.sideEffectsJson,
      roleTagsJson: symbol.roleTagsJson,
      searchText: symbol.searchText,
    })),
    imports: result.imports.map((item) => ({
      specifier: item.specifier,
      isRelative: item.isRelative,
      isExternal: item.isExternal,
      imports: item.imports,
      defaultImport: item.defaultImport,
      namespaceImport: item.namespaceImport,
      isReExport: item.isReExport,
    })),
    calls: result.calls.map((call) => ({
      callerNodeId: call.callerNodeId,
      calleeIdentifier: call.calleeIdentifier,
      isResolved: call.isResolved,
      callType: call.callType,
      calleeSymbolId: call.calleeSymbolId,
      candidateCount: call.candidateCount,
      range: call.range,
    })),
    parseError: result.parseError,
  };
}

test("native disk and content parsing have canonical parity", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "sdl-native-content-"));
  const relPath = "scripts/fixture.mjs";
  const absolutePath = join(repoRoot, relPath);
  const content = [
    'import { helper } from "./dependency.mjs";',
    "export function greet(name) {",
    "  return helper(name);",
    "}",
    "",
  ].join("\n");

  try {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");

    assert.strictEqual(
      isRustEngineAvailable(),
      true,
      "native disk parser must be available after npm run build:native",
    );
    assert.deepStrictEqual(getNativeContentParserCapability(), {
      available: true,
      contract: "native:1",
    });

    const diskResults = parseFilesRust("test-repo", repoRoot, [
      {
        path: relPath,
        size: statSync(absolutePath).size,
        mtime: statSync(absolutePath).mtimeMs,
      },
    ]);
    assert.ok(diskResults, "native disk parse must return a result");
    assert.strictEqual(diskResults.length, 1);
    const diskResult = diskResults[0];
    assert.ok(diskResult, "native disk parse result must be present");

    const contentPending = parseContentRust({
      repoId: "test-repo",
      relPath,
      language: "js",
      content,
    });
    const contentResult = await contentPending;
    assert.strictEqual(contentResult.available, true);
    if (!contentResult.available) {
      assert.fail(`native content parser unavailable: ${contentResult.reason}`);
    }

    assert.deepStrictEqual(
      canonicalParseResult(contentResult.result),
      canonicalParseResult(diskResult),
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native content parsing survives deeply nested sub-limit source", () => {
  const moduleUrl = new URL(
    "../../dist/indexer/rustIndexer.js",
    import.meta.url,
  ).href;
  const script = [
    `import { parseContentRust } from ${JSON.stringify(moduleUrl)};`,
    "const depth = 75_000;",
    'const content = `export const value = ${"(".repeat(depth)}0${")".repeat(depth)};\\n`;',
    'if (Buffer.byteLength(content) >= 1_500_000) throw new Error("fixture too large");',
    "let eventLoopTurn = false;",
    "setImmediate(() => { eventLoopTurn = true; });",
    "const pending = parseContentRust({",
    '  repoId: "test-repo",',
    '  relPath: "fixture.mjs",',
    '  language: "js",',
    "  content,",
    "});",
    "const parsed = await pending;",
    'if (!eventLoopTurn) throw new Error("native content parsing blocked the event loop");',
    'if (!parsed.available) throw new Error(`native content parser unavailable: ${parsed.reason}`);',
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );

  assert.strictEqual(
    child.status,
    0,
    [child.error?.message, child.stdout, child.stderr]
      .filter(Boolean)
      .join("\n"),
  );

test("native content admission preserves unrelated libuv work", () => {
  const moduleUrl = new URL(
    "../../dist/indexer/rustIndexer.js",
    import.meta.url,
  ).href;
  const script = [
    'import { pbkdf2 } from "node:crypto";',
    'import { promisify } from "node:util";',
    `import { parseContentRust } from ${JSON.stringify(moduleUrl)};`,
    "const depth = 75_000;",
    'const content = `export const value = ${"(".repeat(depth)}0${")".repeat(depth)};\\n`;',
    "const order = [];",
    "const parses = Array.from({ length: 4 }, (_, index) =>",
    "  parseContentRust({",
    '    repoId: "test-repo",',
    "    relPath: `fixture-${index}.mjs`,",
    '    language: "js",',
    "    content,",
    '  }).then(() => { order.push("parse"); }),',
    ");",
    'const crypto = promisify(pbkdf2)("password", "salt", 1, 16, "sha256")',
    '  .then(() => { order.push("crypto"); });',
    "await Promise.all([crypto, ...parses]);",
    'if (order[0] !== "crypto") throw new Error(`libuv work was starved: ${order.join(",")}`);',
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: { ...process.env, UV_THREADPOOL_SIZE: "2" },
      timeout: 60_000,
    },
  );

  assert.strictEqual(
    child.status,
    0,
    [child.error?.message, child.stdout, child.stderr]
      .filter(Boolean)
      .join("\n"),
  );
});
});
