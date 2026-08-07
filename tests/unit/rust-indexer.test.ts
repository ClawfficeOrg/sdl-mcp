import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import {
  isRustEngineAvailable,
  parseFilesRust,
  hashContentRust,
  generateSymbolIdRust,
  computeClustersRust,
  traceProcessesRust,
  _resetRustIndexerForTests,
  getNativeContentParserCapability,
  parseContentRust,
} from "../../dist/indexer/rustIndexer.js";
import { _resetNativeAddonLoaderForTests } from "../../dist/native/addon-loader.js";

describe("rustIndexer — native addon disabled", () => {
  let originalEnv: string | undefined;

  before(() => {
    originalEnv = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(() => {
    if (originalEnv === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = originalEnv;
    }
  });

  it("isRustEngineAvailable returns false when addon is disabled", () => {
    const available = isRustEngineAvailable();
    assert.strictEqual(available, false);
  });

  it("parseFilesRust returns null when addon is disabled", () => {
    const result = parseFilesRust("test-repo", "/tmp/repo", [
      { path: "src/index.ts", size: 100, mtime: Date.now() },
    ]);
    assert.strictEqual(result, null);
  });

  it("hashContentRust returns null when addon is disabled", () => {
    const result = hashContentRust("console.log('hello')");
    assert.strictEqual(result, null);
  });

  it("generateSymbolIdRust returns null when addon is disabled", () => {
    const result = generateSymbolIdRust(
      "repo1",
      "src/foo.ts",
      "function",
      "bar",
      "fp1",
    );
    assert.strictEqual(result, null);
  });

  it("computeClustersRust returns null when addon is disabled", () => {
    const result = computeClustersRust(
      [{ symbolId: "A" }, { symbolId: "B" }],
      [{ fromSymbolId: "A", toSymbolId: "B" }],
      2,
    );
    assert.strictEqual(result, null);
  });

  it("traceProcessesRust returns null when addon is disabled", () => {
    const result = traceProcessesRust(
      [{ symbolId: "A", name: "main" }],
      [{ callerId: "A", calleeId: "B" }],
      10,
      [],
    );
    assert.strictEqual(result, null);
  });
});

describe("rustIndexer — parseFilesRust with unsupported languages", () => {
  it("returns results with parse errors for unsupported language files when addon is available", () => {
    // When addon is unavailable this is a no-op; when available it exercises
    // the unsupported-language fallback path.
    if (!isRustEngineAvailable()) return;

    const files = [
      { path: "src/main.kt", size: 50, mtime: Date.now() },
    ];
    const result = parseFilesRust("test-repo", "/tmp/repo", files);
    // Kotlin is unsupported in native extraction — should get a parse error result
    assert.ok(result !== null, "Should return results array");
    assert.strictEqual(result.length, 1);
    assert.ok(
      result[0].parseError !== null,
      "Unsupported language should have parse error",
    );
    assert.ok(
      result[0].parseError!.includes("Unsupported language"),
      "Parse error should mention unsupported language",
    );
  });
});

describe("rustIndexer — parseFilesRust with empty input", () => {
  it("returns empty array for empty file list when addon is available", () => {
    if (!isRustEngineAvailable()) return;

    const result = parseFilesRust("test-repo", "/tmp/repo", []);
    assert.ok(result !== null);
    assert.strictEqual(result.length, 0);
  });
});

describe("rustIndexer — env var parsing", () => {
  let originalEnv: string | undefined;

  after(() => {
    if (originalEnv === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = originalEnv;
    }
  });

  it("recognizes 'true' (case-insensitive) as disable flag", () => {
    originalEnv = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "TRUE";

    // Force fresh evaluation — isRustEngineAvailable calls loadNativeAddon
    // which checks the env var on every call when disabled.
    const available = isRustEngineAvailable();
    assert.strictEqual(available, false);
  });
});

describe("rustIndexer — native content capability", () => {
  let originalEnv: string | undefined;

  const diskAddon = (overrides: Record<string, unknown> = {}) => ({
    parseFiles: () => [],
    hashContentNative: () => "hash",
    generateSymbolIdNative: () => "symbol-id",
    ...overrides,
  });

  const installAddon = (addon: object) => {
    _resetNativeAddonLoaderForTests({ loadCandidate: () => addon });
    _resetRustIndexerForTests();
  };

  beforeEach(() => {
    originalEnv = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
  });

  afterEach(() => {
    _resetRustIndexerForTests();
    _resetNativeAddonLoaderForTests();
    if (originalEnv === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = originalEnv;
    }
  });

  for (const testCase of [
    {
      name: "current disk-only addon",
      addon: diskAddon(),
      expected: {
        available: false,
        reason: "parse-content-missing",
        expectedContract: "native:1",
      },
    },
    {
      name: "parseContent without a contract version",
      addon: diskAddon({ parseContent: () => undefined }),
      expected: {
        available: false,
        reason: "contract-version-missing",
        expectedContract: "native:1",
      },
    },
    {
      name: "contract version without parseContent",
      addon: diskAddon({ parserIdentityContractVersion: () => 1 }),
      expected: {
        available: false,
        reason: "parse-content-missing",
        expectedContract: "native:1",
      },
    },
    {
      name: "older contract version",
      addon: diskAddon({
        parseContent: () => undefined,
        parserIdentityContractVersion: () => 0,
      }),
      expected: {
        available: false,
        reason: "contract-version-mismatch",
        expectedContract: "native:1",
        reportedContract: 0,
      },
    },
    {
      name: "newer contract version",
      addon: diskAddon({
        parseContent: () => undefined,
        parserIdentityContractVersion: () => 2,
      }),
      expected: {
        available: false,
        reason: "contract-version-mismatch",
        expectedContract: "native:1",
        reportedContract: 2,
      },
    },
  ]) {
    it(`reports ${testCase.name} without disabling disk parsing`, () => {
      installAddon(testCase.addon);

      assert.strictEqual(isRustEngineAvailable(), true);
      assert.deepStrictEqual(getNativeContentParserCapability(), testCase.expected);
      assert.deepStrictEqual(
        parseContentRust({
          repoId: "repo",
          relPath: "src\\file.ts",
          language: "typescript",
          content: "export const value = 1;",
        }),
        testCase.expected,
      );
    });
  }

  it("normalizes relPath and preserves native parse errors as available results", () => {
    let receivedInput: Record<string, string> | undefined;
    installAddon(
      diskAddon({
        parserIdentityContractVersion: () => 1,
        parseContent: (input: Record<string, string>) => {
          receivedInput = input;
          return {
            relPath: input.relPath,
            contentHash: "content-hash",
            content: input.content,
            symbols: [],
            imports: [],
            calls: [],
            parseError: "synthetic parse warning",
          };
        },
      }),
    );

    assert.deepStrictEqual(getNativeContentParserCapability(), {
      available: true,
      contract: "native:1",
    });
    assert.deepStrictEqual(
      parseContentRust({
        repoId: "repo",
        relPath: "src\\file.ts",
        language: "typescript",
        content: "export const value = 1;",
      }),
      {
        available: true,
        contract: "native:1",
        result: {
          relPath: "src/file.ts",
          contentHash: "content-hash",
          content: "export const value = 1;",
          symbols: [],
          imports: [],
          calls: [],
          parseError: "synthetic parse warning",
        },
      },
    );
    assert.deepStrictEqual(receivedInput, {
      repoId: "repo",
      relPath: "src/file.ts",
      language: "typescript",
      content: "export const value = 1;",
    });
  });
});
