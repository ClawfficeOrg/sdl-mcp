import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDraftSource,
  type DraftSourceParserDeps,
} from "../../dist/live-index/draft-source-parser.js";
import {
  BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
  NATIVE_PARSER_CONTRACT,
  type ParserContract,
} from "../../dist/indexer/parser-provenance.js";

const REPO_ROOT = "F:/Claude/projects/sdl-mcp/sdl-mcp";
const ABSOLUTE_PATH = `${REPO_ROOT}/src/example.ts`;
const REPO_RELATIVE_PATH = "src/example.ts";

function parserInput(contract: ParserContract) {
  return {
    repoId: "repo",
    repoRelativePath: "src\\example.ts",
    content: "export const answer = 42;",
    contract,
  };
}

function unavailableNativeDeps(reason = "addon-unavailable") {
  return {
    getNativeContentParserCapability: () => ({
      available: false as const,
      reason: reason as never,
      expectedContract: "native:1" as const,
    }),
    parseContentRust: () => {
      throw new Error("native parser must not run");
    },
    getAdapterForExtension: () => {
      throw new Error("adapter parser must not run");
    },
    getAdapterParserContract: () => undefined,
  } satisfies Partial<DraftSourceParserDeps>;
}

function assertTypedError(
  error: unknown,
  code: string,
  requiredContract: string,
) {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: unknown }).code, code);
  assert.equal(
    (error as { repoRelativePath?: unknown }).repoRelativePath,
    REPO_RELATIVE_PATH,
  );
  assert.equal(
    (error as { requiredContract?: unknown }).requiredContract,
    requiredContract,
  );
  assert.equal(
    (error as { recoveryAction?: unknown }).recoveryAction,
    "rebuild",
  );
  assert.doesNotMatch(
    JSON.stringify(error),
    new RegExp(REPO_ROOT.replaceAll("/", "\\\\/")),
  );
  assert.doesNotMatch(
    error.message,
    new RegExp(REPO_ROOT.replaceAll("/", "\\\\/")),
  );
}

test("rejects an unavailable recorded native engine without exposing an absolute path", async () => {
  await assert.rejects(
    () =>
      parseDraftSource(
        parserInput(NATIVE_PARSER_CONTRACT),
        unavailableNativeDeps(),
      ),
    (error: unknown) => {
      assertTypedError(error, "PARSER_ENGINE_UNAVAILABLE", "native:1");
      return true;
    },
  );
});

test("rejects a recorded native contract that the installed engine does not provide", async () => {
  const incompatibleContract: ParserContract = {
    ...NATIVE_PARSER_CONTRACT,
    engineContract: "native:2",
  };

  await assert.rejects(
    () =>
      parseDraftSource(
        parserInput(incompatibleContract),
        unavailableNativeDeps("contract-version-mismatch"),
      ),
    (error: unknown) => {
      assertTypedError(error, "PARSER_CONTRACT_MISMATCH", "native:2");
      return true;
    },
  );
});

test("dispatches a builtin TypeScript contract to its recorded adapter", async () => {
  const tree = { kind: "typescript-tree" };
  const symbols = [{ nodeId: "answer:1:0", name: "answer" }];
  const imports = [{ source: "./dep" }];
  const calls = [{ callerNodeId: "answer:1:0", calleeIdentifier: "dep" }];
  let receivedPath: string | undefined;
  const adapter = {
    parse(content: string, filePath: string) {
      assert.equal(content, "export const answer = 42;");
      receivedPath = filePath;
      return tree;
    },
    extractSymbols() {
      return symbols;
    },
    extractImports() {
      return imports;
    },
    extractCalls() {
      return calls;
    },
  };

  const result = await parseDraftSource(
    parserInput(BUILTIN_TYPESCRIPT_PARSER_CONTRACT),
    {
      getNativeContentParserCapability: () => {
        throw new Error("native parser must not run");
      },
      parseContentRust: () => {
        throw new Error("native parser must not run");
      },
      getAdapterForExtension: () => adapter as never,
      getAdapterParserContract: () => BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
    },
  );

  assert.equal(receivedPath, REPO_RELATIVE_PATH);
  assert.equal(result.contract, BUILTIN_TYPESCRIPT_PARSER_CONTRACT);
  assert.equal(result.tree, tree);
  assert.deepEqual(result.symbols, symbols);
  assert.deepEqual(result.imports, imports);
  assert.deepEqual(result.calls, calls);
});

test("dispatches a contract-bearing plugin to its recorded adapter", async () => {
  const pluginContract: ParserContract = {
    engine: "typescript",
    engineContract: "typescript:1",
    adapterKey: JSON.stringify({
      plugin: "example",
      language: "foo",
      version: 1,
    }),
    language: "foo",
  };
  const adapter = {
    parse: () => ({ kind: "plugin-tree" }),
    extractSymbols: () => [],
    extractImports: () => [],
    extractCalls: () => [],
  };

  const result = await parseDraftSource(parserInput(pluginContract), {
    getNativeContentParserCapability: () => {
      throw new Error("native parser must not run");
    },
    parseContentRust: () => {
      throw new Error("native parser must not run");
    },
    getAdapterForExtension: () => adapter as never,
    getAdapterParserContract: () => pluginContract,
  });

  assert.equal(result.contract, pluginContract);
  assert.equal(
    (result.tree as { kind?: unknown } | undefined)?.kind,
    "plugin-tree",
  );
});

test("rejects a native parse failure without falling back to the TypeScript adapter", async () => {
  let adapterCalled = false;

  await assert.rejects(
    () =>
      parseDraftSource(parserInput(NATIVE_PARSER_CONTRACT), {
        getNativeContentParserCapability: () => ({
          available: true as const,
          contract: "native:1" as const,
        }),
        parseContentRust: () => ({
          available: true as const,
          contract: "native:1" as const,
          result: {
            symbols: [],
            imports: [],
            calls: [],
            parseError: `native parse failed at ${ABSOLUTE_PATH}`,
          } as never,
        }),
        getAdapterForExtension: () => {
          adapterCalled = true;
          throw new Error("adapter fallback is forbidden");
        },
        getAdapterParserContract: () => BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
      }),
    (error: unknown) => {
      assertTypedError(error, "PARSER_ENGINE_UNAVAILABLE", "native:1");
      return true;
    },
  );

  assert.equal(adapterCalled, false);
});
