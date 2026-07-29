import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BuildRowsParams } from "../../src/indexer/parser/types.js";

const TEST_CONTENT = [
  'describe("registration   contract", () => {});',
  'it.only("keeps sdl.info callable", () => {});',
  "export function helper() {}",
].join("\n");

function detail(
  nodeId: string,
  kind: "function" | "module" = "function",
): BuildRowsParams["symbolDetails"][number] {
  return {
    extractedSymbol: {
      nodeId,
      kind,
      name: nodeId,
      exported: true,
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
    },
    astFingerprint: nodeId,
    symbolId: `sym:${nodeId}`,
  };
}

function testBuildRowsParams(
  symbolDetails: BuildRowsParams["symbolDetails"] = [
    detail("module", "module"),
    detail("helper"),
  ],
): BuildRowsParams {
  const nameToSymbolIds = new Map<string, string[]>();
  for (const symbolDetail of symbolDetails) {
    nameToSymbolIds.set(symbolDetail.extractedSymbol.name, [
      symbolDetail.symbolId,
    ]);
  }

  return {
    repoId: "test-repo",
    relPath: "tests/unit/sample.test.ts",
    fileId: "test-file",
    filePath: "tests/unit/sample.test.ts",
    content: TEST_CONTENT,
    ext: "ts",
    languages: ["ts"],
    symbolDetails,
    nodeIdToSymbolId: new Map(
      symbolDetails.map((symbolDetail) => [
        symbolDetail.extractedSymbol.nodeId,
        symbolDetail.symbolId,
      ]),
    ),
    nameToSymbolIds,
    existingSymbolsById: new Map(),
    importResolution: {
      targets: [],
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
    },
    calls: [],
    edgeSourceNodeIds: new Set(),
    languageId: "typescript",
    skipCallResolution: true,
  };
}

describe("buildSymbolAndEdgeRows import fanout", () => {
  it("collapses high-fanout C++ pass-1 imports to module symbols", async () => {
    const { selectImportEdgeSourceNodeIds } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const selected = selectImportEdgeSourceNodeIds({
      symbolDetails: [
        detail("module", "module"),
        detail("fn1"),
        detail("fn2"),
      ],
      edgeSourceNodeIds: new Set(["module", "fn1", "fn2"]),
      importTargetCount: 200,
      languageId: "cpp",
      skipCallResolution: true,
    });

    assert.deepEqual(Array.from(selected), ["module"]);
  });

  it("keeps ordinary non-C++ import fanout unchanged", async () => {
    const { selectImportEdgeSourceNodeIds } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const sourceIds = new Set(["module", "fn1", "fn2"]);
    const selected = selectImportEdgeSourceNodeIds({
      symbolDetails: [
        detail("module", "module"),
        detail("fn1"),
        detail("fn2"),
      ],
      edgeSourceNodeIds: sourceIds,
      importTargetCount: 200,
      languageId: "typescript",
      skipCallResolution: true,
    });

    assert.equal(selected, sourceIds);
  });

  it("keeps module search text canonical for fallback and native rows", async () => {
    const { buildSymbolAndEdgeRows } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const fallbackParams = testBuildRowsParams();
    const fallback = await buildSymbolAndEdgeRows(fallbackParams);
    const fallbackModule = fallback.symbolsToUpsert.find(
      (symbol) => symbol.kind === "module",
    );
    const fallbackFunction = fallback.symbolsToUpsert.find(
      (symbol) => symbol.kind === "function",
    );

    assert.ok(fallbackModule);
    assert.ok(fallbackFunction);
    const nativeParams = testBuildRowsParams(
      fallbackParams.symbolDetails.map((symbolDetail) =>
        symbolDetail.extractedSymbol.kind === "module"
          ? {
              ...symbolDetail,
              nativeSearchText: fallbackModule.searchText,
            }
          : symbolDetail,
      ),
    );
    const native = await buildSymbolAndEdgeRows(nativeParams);
    const nativeModule = native.symbolsToUpsert.find(
      (symbol) => symbol.kind === "module",
    );
    const nativeFunction = native.symbolsToUpsert.find(
      (symbol) => symbol.kind === "function",
    );

    assert.ok(nativeModule);
    assert.ok(nativeFunction);
    for (const module of [fallbackModule, nativeModule]) {
      assert.equal(module.searchText.includes("registration contract"), false);
      assert.equal(module.searchText.includes("keeps sdl.info callable"), false);
    }
    assert.equal(nativeModule.searchText, fallbackModule.searchText);
    assert.equal(nativeFunction.searchText, fallbackFunction.searchText);
    assert.deepEqual(
      native.symbolsToUpsert.map((symbol) => symbol.symbolId),
      fallback.symbolsToUpsert.map((symbol) => symbol.symbolId),
    );
    assert.deepEqual(native.edgesToInsert, fallback.edgesToInsert);

    const withoutModule = await buildSymbolAndEdgeRows(
      testBuildRowsParams([detail("helper")]),
    );
    assert.equal(withoutModule.symbolsToUpsert.length, 1);
    assert.equal(
      withoutModule.symbolsToUpsert[0]?.searchText,
      fallbackFunction.searchText,
    );
  });
});
