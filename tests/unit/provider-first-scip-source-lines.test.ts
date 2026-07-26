import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ScipDocument } from "../../dist/scip/types.js";

const REL_PATH = "src/config.ts";
const SYMBOL = "scip-typescript npm fixture 1.0.0 src/config/SETTINGS.";
const START_LINE = 40;
const DECLARATION = [
  "export const SETTINGS = {",
  "  enabled: true,",
  "  nested: {",
  "    value: 1,",
  "  },",
  "};",
];

describe("provider-first SCIP source-line loading", () => {
  it("loads a bounded TypeScript variable declaration tail into the sparse normalization map", () => {
    const document: ScipDocument = {
      language: "typescript",
      relativePath: REL_PATH,
      occurrences: [{
        range: {
          startLine: START_LINE,
          startCol: 13,
          endLine: START_LINE,
          endCol: 21,
        },
        symbol: SYMBOL,
        symbolRoles: 1,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      }],
      symbols: [{
        symbol: SYMBOL,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "SETTINGS",
      }],
    };
    const sourceText = [
      ...Array.from({ length: START_LINE }, () => "// filler"),
      ...DECLARATION,
    ].join("\n");

    const neededLines = collectNeededSourceLines([document]).get(REL_PATH);
    assert.ok(neededLines);
    assert.equal(neededLines.size, 200);
    assert.equal(neededLines.has(START_LINE + 199), true);

    const selectedLines = selectNeededLines(sourceText, neededLines);
    assert.deepEqual([...selectedLines.keys()], [40, 41, 42, 43, 44, 45]);

    const fact = normalizeScipProviderFacts({
      repoId: "provider-first-scip-source-lines",
      generationId: "gen-source-lines",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [document],
      sourceLinesByPath: new Map([[REL_PATH, selectedLines]]),
    }).symbols[0];

    assert.deepEqual(fact.range, {
      startLine: 41,
      startCol: 0,
      endLine: 46,
      endCol: 2,
    });
  });
});

describe("provider-first SCIP ambiguous Type source-line loading", () => {
  it("loads only the definition line needed to refine an ambiguous TypeScript Type", () => {
    const ambiguous =
      "scip-typescript npm fixture 1.0.0 src/types/Config#";
    const explicitClass =
      "scip-typescript npm fixture 1.0.0 src/types/Explicit#";
    const definition = (
      symbol: string,
      line: number,
      startCol: number,
      endCol: number,
    ): ScipDocument["occurrences"][number] => ({
      range: { startLine: line, startCol, endLine: line, endCol },
      symbol,
      symbolRoles: 1,
      overrideDocumentation: [],
      syntaxKind: 0,
      diagnostics: [],
    });
    const document: ScipDocument = {
      language: "typescript",
      relativePath: "src/types.ts",
      occurrences: [
        definition(ambiguous, 20, 17, 23),
        definition(explicitClass, 21, 13, 21),
      ],
      symbols: [
        {
          symbol: ambiguous,
          documentation: [],
          relationships: [],
          kind: 0,
          displayName: "Config",
        },
        {
          symbol: explicitClass,
          documentation: [],
          relationships: [],
          kind: 5,
          displayName: "Explicit",
        },
      ],
    };
    const sourceText = [
      ...Array.from({ length: 20 }, () => "// filler"),
      "export interface Config {}",
      "export class Explicit {}",
    ].join("\n");

    const neededLines = collectNeededSourceLines([document]).get("src/types.ts");
    assert.ok(neededLines);
    assert.deepEqual([...neededLines], [20]);
    const selectedLines = selectNeededLines(sourceText, neededLines);
    assert.deepEqual([...selectedLines.keys()], [20]);
    assert.equal(selectedLines.has(0), false);

    const facts = normalizeScipProviderFacts({
      repoId: "provider-first-scip-interface-lines",
      generationId: "gen-interface-lines",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [document],
      sourceLinesByPath: new Map([["src/types.ts", selectedLines]]),
    });
    assert.equal(
      facts.symbols.find((symbol) => symbol.providerSymbolId === ambiguous)
        ?.symbolKind,
      "interface",
    );
    assert.equal(
      facts.symbols.find((symbol) => symbol.providerSymbolId === explicitClass)
        ?.symbolKind,
      "class",
    );
  });
});
