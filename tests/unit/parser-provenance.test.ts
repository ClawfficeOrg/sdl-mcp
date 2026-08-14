import assert from "node:assert/strict";
import test from "node:test";

import { ParserAdapterContractError } from "../../dist/domain/errors.js";
import {
  BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
  assertParserContractCompatible,
  createPluginParserContract,
  selectParserContract,
} from "../../dist/indexer/parser-provenance.js";

test("selects native for .mjs only with the exact content-parser capability", () => {
  const input = {
    repoRelativePath: "src/example.mjs",
    language: "typescript",
    adapterContract: BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
  };

  assert.deepEqual(
    selectParserContract({
      ...input,
      nativeCapability: { available: true, contract: "native:1" },
    }),
    {
      engine: "native",
      engineContract: "native:1",
      adapterKey: "native:native:1",
      language: "typescript",
    },
  );
  assert.deepEqual(
    selectParserContract({
      ...input,
      nativeCapability: {
        available: false,
        reason: "contract-version-mismatch",
        expectedContract: "native:1",
        reportedContract: 2,
      },
    }),
    BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
  );
  assert.deepEqual(
    selectParserContract({
      ...input,
      nativeCapability: {
        available: false,
        reason: "addon-unavailable",
        expectedContract: "native:1",
      },
    }),
    BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
  );
});

test("does not select native outside JavaScript module semantics", () => {
  assert.deepEqual(
    selectParserContract({
      repoRelativePath: "src/example.ts",
      language: "typescript",
      nativeCapability: { available: true, contract: "native:1" },
      adapterContract: BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
    }),
    BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
  );
});

test("defines one explicit built-in TypeScript parser contract", () => {
  assert.deepEqual(BUILTIN_TYPESCRIPT_PARSER_CONTRACT, {
    engine: "typescript",
    engineContract: "typescript:1",
    adapterKey: "builtin:typescript:typescript:1",
    language: "typescript",
  });
});

test("plugin adapter keys include every identity component", () => {
  const identity = {
    pluginIdentity: "example-plugin",
    pluginPackageVersion: "1.2.3",
    adapterIdentity: "example-typescript",
    adapterContractVersion: "4",
    language: "typescript",
  };
  const baseline = createPluginParserContract(identity);
  assert.ok(baseline);
  assert.equal(
    baseline.adapterKey,
    JSON.stringify([
      "plugin",
      "example-plugin",
      "1.2.3",
      "example-typescript",
      "4",
    ]),
  );

  for (const changed of [
    { ...identity, pluginIdentity: "other-plugin" },
    { ...identity, pluginPackageVersion: "1.2.4" },
    { ...identity, adapterIdentity: "other-adapter" },
    { ...identity, adapterContractVersion: "5" },
  ]) {
    const current = createPluginParserContract(changed);
    assert.ok(current);
    assert.notEqual(current.adapterKey, baseline.adapterKey);
    assert.throws(
      () =>
        assertParserContractCompatible(baseline, current, "src/example.custom"),
      (error: unknown) =>
        error instanceof ParserAdapterContractError &&
        error.code === "PARSER_ADAPTER_CONTRACT_ERROR" &&
        error.repoRelativePath === "src/example.custom" &&
        error.requiredContract === baseline.adapterKey &&
        error.recoveryAction === "fileFallback" &&
        /Reindex only if AST\/provenance-dependent behavior is required; otherwise use a file-based fallback\./.test(
          error.message,
        ),
    );
  }
});

test("contract-less plugin metadata stays absent", () => {
  assert.equal(
    createPluginParserContract({
      pluginIdentity: "legacy-plugin",
      pluginPackageVersion: "1.0.0",
      language: "legacy",
    }),
    undefined,
  );
});
