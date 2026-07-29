import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { RepoConfigSchema } from "../../dist/config/types.js";
import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import {
  getAdapterForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";
import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";
import { processFileFromRustResult } from "../../dist/indexer/parser/rust-process-file.js";
import type { SymbolRow } from "../../dist/db/ladybug-queries.js";
import { logger } from "../../dist/util/logger.js";

describe("Native parser chaos", () => {
  const runner = resolve(process.cwd(), "tests/fixtures/native-addon/run-parse-files.mjs");
  const okAddon = resolve(process.cwd(), "tests/fixtures/native-addon/minimal-ok.cjs");
  const legacyAddon = resolve(process.cwd(), "tests/fixtures/native-addon/minimal-legacy.cjs");
  const throwsAddon = resolve(process.cwd(), "tests/fixtures/native-addon/throws.cjs");
  const badCountAddon = resolve(process.cwd(), "tests/fixtures/native-addon/bad-count.cjs");

  const run = (
    addonPath: string,
    envOverrides: Record<string, string> = {},
  ): unknown => {
    const proc = spawnSync(process.execPath, [runner], {
      env: {
        ...process.env,
        SDL_MCP_NATIVE_ADDON_PATH: addonPath,
        SDL_MCP_DISABLE_NATIVE_ADDON: "",
        ...envOverrides,
      },
      encoding: "utf8",
    });

    assert.strictEqual(
      proc.status,
      0,
      proc.stderr || proc.stdout || "child process failed",
    );

    const stdout = proc.stdout.trim();
    return stdout === "" ? null : JSON.parse(stdout);
  };

  it("returns results when native addon succeeds", () => {
    const result = run(okAddon);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.relPath, "src/foo.ts");
    assert.strictEqual(result[0]?.symbols.length, 1);
    assert.strictEqual(result[0]?.symbols[0]?.symbolId, "stub-symbol");
    assert.strictEqual(
      result[0]?.symbols[0]?.roleTagsJson,
      JSON.stringify(["handler", "entrypoint"]),
    );
    assert.strictEqual(
      result[0]?.symbols[0]?.searchText,
      "handle login requests handler entrypoint auth request",
    );
  });

  it("defaults missing enrichment fields from older native addons", () => {
    const result = run(legacyAddon);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.symbols.length, 1);
    assert.strictEqual(result[0]?.symbols[0]?.symbolId, "legacy-symbol");
    assert.strictEqual(result[0]?.symbols[0]?.roleTagsJson, "[]");
    assert.strictEqual(result[0]?.symbols[0]?.searchText, "");
  });

  it("returns null when native addon throws", () => {
    const result = run(throwsAddon);
    assert.strictEqual(result, null);
  });

  it("returns null when native addon returns mismatched result count", () => {
    const result = run(badCountAddon);
    assert.strictEqual(result, null);
  });

  it("returns null when native addon loading is explicitly disabled", () => {
    const result = run(okAddon, {
      SDL_MCP_DISABLE_NATIVE_ADDON: "1",
    });
    assert.strictEqual(result, null);
  });

  it("marks languages without native extraction support as unsupported", () => {
    const cases = [
      ["src/App.kt", "kt"],
    ] as const;

    for (const [filePath, language] of cases) {
      const result = run(okAddon, {
        TEST_FILE_PATH: filePath,
      });
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]?.relPath, filePath);
      assert.strictEqual(result[0]?.symbols.length, 0);
      assert.strictEqual(
        result[0]?.parseError,
        `Unsupported language: ${language}`,
      );
    }
  });



  it("normalizes retained native content before row construction", async () => {
    loadBuiltInAdapters();
    const root = mkdtempSync(join(tmpdir(), "sdl-native-test-cases-"));
    const dbPath = join(root, "graph.lbug");
    const captured: SymbolRow[] = [];
    class CapturingAccumulator extends BatchPersistAccumulator {
      override addSymbols(rows: SymbolRow[]): void {
        captured.push(...rows);
        super.addSymbols(rows);
      }
    }

    try {
      await initLadybugDb(dbPath);
      const content = readFileSync(
        join(
          process.cwd(),
          "tests",
          "fixtures",
          "semantic-test-cases",
          "sample.test.ts",
        ),
        "utf8",
      );
      const adapter = getAdapterForExtension(".ts");
      assert.ok(adapter);
      const tree = adapter.parse(content, "src/embedded-cases.ts");
      assert.ok(tree);
      const rawSymbols = adapter.extractSymbols(
        tree,
        content,
        "src/embedded-cases.ts",
      );
      const rawCalls = adapter.extractCalls(
        tree,
        content,
        "src/embedded-cases.ts",
        rawSymbols,
      );
      await processFileFromRustResult({
        repoId: "native-test-cases",
        repoRoot: root,
        fileMeta: {
          path: "src/embedded-cases.ts",
          size: Buffer.byteLength(content, "utf8"),
          mtime: Date.now(),
          contentHash: "2".repeat(64),
        },
        rustResult: {
          relPath: "src/embedded-cases.ts",
          contentHash: "2".repeat(64),
          content,
          symbols: rawSymbols.map((symbol, index) => ({
            ...symbol,
            symbolId: `native-test-cases:${index}`,
            astFingerprint: `native-${index}`,
            summary: "",
            invariantsJson: "[]",
            sideEffectsJson: "[]",
            roleTagsJson: "[]",
            decorators: [],
            searchText: symbol.name,
          })),
          imports: adapter.extractImports(
            tree,
            content,
            "src/embedded-cases.ts",
          ),
          calls: rawCalls,
          parseError: null,
        },
        languages: ["ts"],
        mode: "full",
        symbolIndex: new Map(),
        pendingCallEdges: [],
        createdCallEdges: new Set(),
        tsResolver: null,
        config: RepoConfigSchema.parse({
          repoId: "native-test-cases",
          rootPath: root,
          languages: ["ts"],
        }),
        allSymbolsByName: new Map(),
        skipCallResolution: true,
        batchAccumulator: new CapturingAccumulator(10_000, {
          autoDrain: false,
        }),
      });

      const cases = captured.filter((symbol) => symbol.testCaseJson !== null);
      assert.equal(cases.length, 2);
      assert.notEqual(cases[0]?.symbolId, cases[1]?.symbolId);
      assert.ok(
        cases.every(
          (symbol) =>
            symbol.astFingerprint.length > 0 &&
            symbol.testCaseJson ===
              '{"framework":"jest","title":"duplicate case","suitePath":["outer suite"]}',
        ),
      );
    } finally {
      await closeLadybugDb().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains Python parse failures while preserving native rows", async () => {
    loadBuiltInAdapters();
    const root = mkdtempSync(join(tmpdir(), "sdl-native-python-parse-"));
    const captured: SymbolRow[] = [];
    const warnings: string[] = [];
    const adapter = getAdapterForExtension(".py");
    assert.ok(adapter?.detectTestCases);
    const parse = adapter.parse;
    const warn = logger.warn;
    adapter.parse = () => {
      throw new Error("synthetic Python parse failure");
    };
    class CapturingAccumulator extends BatchPersistAccumulator {
      override addSymbols(rows: SymbolRow[]): void {
        captured.push(...rows);
        super.addSymbols(rows);
      }
    }

    try {
      await initLadybugDb(join(root, "graph.lbug"));
      logger.warn = (message: string) => {
        warnings.push(message);
      };
      const content = "def ordinary_helper():\n    return 1\n";
      await processFileFromRustResult({
        repoId: "native-python-parse",
        repoRoot: root,
        fileMeta: {
          path: "src/helpers.py",
          size: Buffer.byteLength(content, "utf8"),
          mtime: Date.now(),
          contentHash: "3".repeat(64),
        },
        rustResult: {
          relPath: "src/helpers.py",
          contentHash: "3".repeat(64),
          content,
          symbols: [
            {
              nodeId: "python:ordinary-helper",
              symbolId: "native-python-parse:ordinary-helper",
              kind: "function",
              name: "ordinary_helper",
              signature: "def ordinary_helper()",
              exported: false,
              range: {
                startLine: 1,
                startCol: 0,
                endLine: 2,
                endCol: 12,
              },
              astFingerprint: "native-python-fingerprint",
              summary: "",
              invariantsJson: "[]",
              sideEffectsJson: "[]",
              roleTagsJson: "[]",
              decorators: [],
              searchText: "ordinary_helper",
            },
          ],
          imports: [],
          calls: [],
          parseError: null,
        },
        languages: ["py"],
        mode: "full",
        symbolIndex: new Map(),
        pendingCallEdges: [],
        createdCallEdges: new Set(),
        tsResolver: null,
        config: RepoConfigSchema.parse({
          repoId: "native-python-parse",
          rootPath: root,
          languages: ["py"],
        }),
        allSymbolsByName: new Map(),
        skipCallResolution: true,
        batchAccumulator: new CapturingAccumulator(10_000, {
          autoDrain: false,
        }),
      });

      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.symbolId, "native-python-parse:ordinary-helper");
      assert.equal(captured[0]?.testCaseJson, null);
      assert.deepEqual(warnings, [
        "src/helpers.py: test-case detection failed",
      ]);
    } finally {
      adapter.parse = parse;
      logger.warn = warn;
      await closeLadybugDb().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

});
