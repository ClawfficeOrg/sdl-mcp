import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProviderSymbolId } from "../../dist/indexer/provider-first/ids.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ScipDocument } from "../../dist/scip/types.js";

const REPO_ID = "provider-first-scip-typescript";
const PROVIDER_ID = "scip-typescript";
const PROVIDER_VERSION = "1.0.0";
const REL_PATH = "src/config.ts";
const INTERFACE_SYMBOL =
  "scip-typescript npm fixture 1.0.0 src/config/Config#";
const VARIABLE_SYMBOL =
  "scip-typescript npm fixture 1.0.0 src/config/SETTINGS.";
const DECLARATION_RANGE = {
  startLine: 4,
  startCol: 0,
  endLine: 9,
  endCol: 2,
};

const SOURCE_LINES = [
  "export interface Config {",
  "  enabled: boolean;",
  "}",
  "export const SETTINGS = {",
  "  enabled: true,",
  "  nested: {",
  "    value: 1,",
  "  },",
  "};",
];

function definition(
  symbol: string,
  line: number,
  startCol: number,
  endCol: number,
): ScipDocument["occurrences"][number] {
  return {
    range: { startLine: line, startCol, endLine: line, endCol },
    symbol,
    symbolRoles: 1,
    overrideDocumentation: [],
    syntaxKind: 0,
    diagnostics: [],
  };
}

function normalizeFixture() {
  const document: ScipDocument = {
    language: "typescript",
    relativePath: REL_PATH,
    occurrences: [
      definition(INTERFACE_SYMBOL, 0, 17, 23),
      definition(VARIABLE_SYMBOL, 3, 13, 21),
    ],
    symbols: [
      {
        symbol: INTERFACE_SYMBOL,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "Config",
      },
      {
        symbol: VARIABLE_SYMBOL,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "SETTINGS",
      },
    ],
  };

  return normalizeScipProviderFacts({
    repoId: REPO_ID,
    generationId: "gen-typescript",
    providerId: PROVIDER_ID,
    providerVersion: PROVIDER_VERSION,
    documents: [document],
    sourceTextByPath: new Map([[REL_PATH, SOURCE_LINES.join("\n")]]),
  });
}

describe("provider-first SCIP TypeScript normalization", () => {
  it("refines an ambiguous Type descriptor to interface from source", () => {
    const interfaceFact = normalizeFixture().symbols.find(
      (symbol) => symbol.providerSymbolId === INTERFACE_SYMBOL,
    );

    assert.equal(interfaceFact?.symbolKind, "interface");
  });

  it("uses one declaration-wide range for a multiline variable and its identity", () => {
    const variableFact = normalizeFixture().symbols.find(
      (symbol) => symbol.providerSymbolId === VARIABLE_SYMBOL,
    );

    assert.deepEqual(variableFact?.range, DECLARATION_RANGE);
    assert.equal(
      variableFact?.symbolId,
      createProviderSymbolId({
        repoId: REPO_ID,
        providerType: "scip",
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        providerSymbolId: VARIABLE_SYMBOL,
        sourcePath: REL_PATH,
        range: DECLARATION_RANGE,
      }),
    );
  });
});


describe("provider-first SCIP TypeScript variable statement ranges", () => {
  it("uses compiler syntax for semicolonless declarations with literal and comment delimiters", () => {
    const symbol =
      "scip-typescript npm fixture 1.0.0 src/complex/COMPLEX.";
    const sourceLines = [
      "export const COMPLEX = {",
      "  text: \"};\",",
      "  template: `value } ; ${ { nested: true } }`,",
      "  // } ;",
      "  value: \"(\",",
      "}",
      "export const NEXT = 1;",
    ];
    const document: ScipDocument = {
      language: "typescript",
      relativePath: "src/complex.ts",
      occurrences: [definition(symbol, 0, 13, 20)],
      symbols: [{
        symbol,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "COMPLEX",
      }],
    };

    const fact = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-complex",
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      documents: [document],
      sourceTextByPath: new Map([
        ["src/complex.ts", sourceLines.join("\n")],
      ]),
    }).symbols[0];

    assert.deepEqual(fact.range, {
      startLine: 1,
      startCol: 0,
      endLine: 6,
      endCol: 1,
    });
  });

  it("ignores syntax diagnostics strictly after the target statement", () => {
    const symbol =
      "scip-typescript npm fixture 1.0.0 src/complex/TARGET.";
    const sourceLines = [
      "export const TARGET = {",
      "  value: 1,",
      "};",
      ...Array.from({ length: 195 }, (_, index) =>
        `export const VALUE_${index} = ${index};`),
      "export const BROKEN = {",
    ];
    const document: ScipDocument = {
      language: "typescript",
      relativePath: "src/trailing-error.ts",
      occurrences: [definition(symbol, 0, 13, 19)],
      symbols: [{
        symbol,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "TARGET",
      }],
    };

    const fact = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-trailing-error",
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      documents: [document],
      sourceTextByPath: new Map([
        ["src/trailing-error.ts", sourceLines.join("\n")],
      ]),
    }).symbols[0];

    assert.deepEqual(fact.range, {
      startLine: 1,
      startCol: 0,
      endLine: 3,
      endCol: 2,
    });
  });

  it("keeps the SCIP range when the bounded declaration fragment is incomplete", () => {
    const symbol =
      "scip-typescript npm fixture 1.0.0 src/complex/TOO_LONG.";
    const sourceLines = [
      "export const TOO_LONG = {",
      ...Array.from({ length: 199 }, (_, index) =>
        `  value${index}: ${index},`),
      "};",
    ];
    const document: ScipDocument = {
      language: "typescript",
      relativePath: "src/too-long.ts",
      occurrences: [definition(symbol, 0, 13, 21)],
      symbols: [{
        symbol,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "TOO_LONG",
      }],
    };

    const fact = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-too-long",
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      documents: [document],
      sourceTextByPath: new Map([
        ["src/too-long.ts", sourceLines.join("\n")],
      ]),
    }).symbols[0];

    assert.deepEqual(fact.range, {
      startLine: 1,
      startCol: 13,
      endLine: 1,
      endCol: 21,
    });
  });
});
