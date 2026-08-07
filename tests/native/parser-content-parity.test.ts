import assert from "node:assert";
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

test("native disk and content parsing have canonical parity", () => {
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

    const contentResult = parseContentRust({
      repoId: "test-repo",
      relPath,
      language: "js",
      content,
    });
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
