import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { generateSymbolId } from "../../dist/indexer/fingerprints.js";
import { getAdapterForExtension } from "../../dist/indexer/adapter/registry.js";
import { buildSymbolDetails } from "../../dist/indexer/parser/symbol-mapping.js";
import {
  applyTestCaseCandidates,
  sourceFingerprintForTestCase,
} from "../../dist/indexer/test-case-normalizer.js";
import { hashContent } from "../../dist/util/hashing.js";
import type { TestCaseCandidate } from "../../dist/indexer/adapter/LanguageAdapter.js";
import type { ExtractedCall } from "../../dist/indexer/treesitter/extractCalls.js";
import type { SymbolWithNodeId } from "../../dist/indexer/worker.js";

type Range = SymbolWithNodeId["range"];

const facet = { framework: "node:test", title: "keeps working" } as const;

function range(startLine: number, startCol: number, endLine: number, endCol: number): Range {
  return { startLine, startCol, endLine, endCol };
}

function symbol(
  nodeId: string,
  name: string,
  symbolRange: Range,
  kind: SymbolWithNodeId["kind"] = "function",
): SymbolWithNodeId {
  return {
    nodeId,
    kind,
    name,
    exported: false,
    range: symbolRange,
    astFingerprint: `${nodeId}-fingerprint`,
  };
}

function call(callerNodeId: string, callRange: Range): ExtractedCall {
  return {
    callerNodeId,
    calleeIdentifier: "work",
    isResolved: false,
    callType: "function",
    range: callRange,
  };
}

function syntheticCandidate(params: {
  name: string;
  constructRange: Range;
  sourceFingerprint: string;
}): TestCaseCandidate {
  return {
    mode: "synthetic",
    kind: "function",
    name: params.name,
    nodeId: `sdl:test-case:${params.sourceFingerprint}`,
    constructRange: params.constructRange,
    sourceFingerprint: params.sourceFingerprint,
    testCase: { ...facet, title: params.name },
  };
}

describe("applyTestCaseCandidates", () => {
  it("attaches only the facet and preserves the existing symbol ID", () => {
    const original = symbol("ordinary-node", "test_named", range(2, 0, 4, 1));
    const inputSymbols = [original];
    const before = buildSymbolDetails({
      symbolsWithNodeIds: [original],
      tree: null,
      repoId: "repo",
      fileMeta: { path: "tests/example.py", size: 10, mtime: 0 },
    })[0];

    const result = applyTestCaseCandidates({
      relPath: "tests/example.py",
      symbols: inputSymbols,
      calls: [],
      candidates: [
        {
          mode: "attach",
          targetName: "test_named",
          targetKinds: ["function"],
          constructRange: range(2, 0, 5, 0),
          testCase: { framework: "pytest", title: "test_named" },
        },
      ],
    });
    const after = buildSymbolDetails({
      symbolsWithNodeIds: result.symbols,
      tree: null,
      repoId: "repo",
      fileMeta: { path: "tests/example.py", size: 10, mtime: 0 },
    })[0];

    assert.deepEqual(result.diagnostics, []);
    assert.notStrictEqual(result.symbols, inputSymbols);
    assert.deepEqual(result.symbols, [
      { ...original, testCase: { framework: "pytest", title: "test_named" } },
    ]);
    assert.equal(after.symbolId, before.symbolId);
    assert.equal(
      after.symbolId,
      generateSymbolId("repo", "tests/example.py", "function", "test_named", original.astFingerprint),
    );
  });

  it("drops missing and ambiguous attachments with sorted relative diagnostics", () => {
    const symbols = [
      symbol("first", "duplicate", range(10, 0, 12, 1)),
      symbol("second", "duplicate", range(10, 0, 13, 1)),
    ];
    const result = applyTestCaseCandidates({
      relPath: "tests/example.ts",
      symbols,
      calls: [],
      candidates: [
        {
          mode: "attach",
          targetName: "missing",
          targetKinds: ["function"],
          constructRange: range(20, 0, 21, 1),
          testCase: facet,
        },
        {
          mode: "attach",
          targetName: "duplicate",
          targetKinds: ["function"],
          constructRange: range(10, 0, 14, 1),
          testCase: facet,
        },
      ],
    });

    assert.deepEqual(result.symbols, symbols);
    assert.notStrictEqual(result.symbols, symbols);
    assert.deepEqual(result.diagnostics, [
      'tests/example.ts: test-case attach "duplicate" matched 2 symbols',
      'tests/example.ts: test-case attach "missing" matched 0 symbols',
    ]);
  });

  it("orders conflicting identical attachments by canonical facet content", () => {
    const ordinary = symbol("ordinary", "test_named", range(2, 0, 4, 1));
    const first: TestCaseCandidate = {
      mode: "attach",
      targetName: "test_named",
      targetKinds: ["function"],
      constructRange: range(2, 0, 4, 1),
      testCase: { framework: "PyTest", title: " alpha " },
    };
    const second: TestCaseCandidate = {
      ...first,
      testCase: { framework: "unittest", title: "beta" },
    };
    const run = (candidates: TestCaseCandidate[]) =>
      applyTestCaseCandidates({
        relPath: "tests/example.py",
        symbols: [ordinary],
        calls: [],
        candidates,
      });

    const forward = run([first, second]);
    const reversed = run([second, first]);
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward.diagnostics, []);
    assert.deepEqual(forward.symbols[0].testCase, {
      framework: "unittest",
      title: "beta",
    });
  });

  it("uses half-open attachment ranges and assigns zero-width points", () => {
    const symbols = [
      symbol("left", "test_named", range(1, 0, 1, 5)),
      symbol("right", "test_named", range(1, 5, 1, 10)),
    ];
    const result = applyTestCaseCandidates({
      relPath: "tests/example.py",
      symbols,
      calls: [],
      candidates: [
        {
          mode: "attach",
          targetName: "test_named",
          targetKinds: ["function"],
          constructRange: range(1, 0, 1, 5),
          testCase: { framework: "pytest", title: "left" },
        },
        {
          mode: "attach",
          targetName: "test_named",
          targetKinds: ["function"],
          constructRange: range(1, 5, 1, 5),
          testCase: { framework: "pytest", title: "right" },
        },
      ],
    });

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.symbols.map((candidate) => candidate.testCase?.title),
      ["left", "right"],
    );
  });

  it("synthesizes one internal function over the complete construct", () => {
    const candidate = syntheticCandidate({
      name: "anonymous case",
      constructRange: range(3, 2, 7, 4),
      sourceFingerprint: "source-fingerprint",
    });
    const result = applyTestCaseCandidates({
      relPath: "tests/example.ts",
      symbols: [],
      calls: [],
      candidates: [candidate],
    });

    assert.deepEqual(result.symbols, [
      {
        nodeId: "sdl:test-case:source-fingerprint",
        kind: "function",
        name: "anonymous case",
        exported: false,
        range: range(3, 2, 7, 4),
        astFingerprint: "source-fingerprint",
        testCase: candidate.testCase,
      },
    ]);
  });

  it("keeps duplicate-title fingerprints and generated IDs stable", () => {
    const firstSlice = 'test("same", () => one());';
    const secondSlice = 'test("same", () => two());';
    const repeatedSlice = 'test("same", () => same());';
    const content = `${firstSlice}\n${secondSlice}\n${repeatedSlice}\n${repeatedSlice}`;
    const ranges = [
      range(1, 0, 1, firstSlice.length),
      range(2, 0, 2, secondSlice.length),
      range(3, 0, 3, repeatedSlice.length),
      range(4, 0, 4, repeatedSlice.length),
    ];
    const fingerprints = [
      sourceFingerprintForTestCase(content, ranges[0], 1),
      sourceFingerprintForTestCase(content, ranges[1], 1),
      sourceFingerprintForTestCase(content, ranges[2], 1),
      sourceFingerprintForTestCase(content, ranges[3], 2),
    ];
    const candidates = ranges.map((constructRange, index) =>
      syntheticCandidate({
        name: "same",
        constructRange,
        sourceFingerprint: fingerprints[index],
      }),
    );

    assert.notEqual(fingerprints[0], fingerprints[1]);
    assert.notEqual(fingerprints[2], fingerprints[3]);
    assert.equal(
      fingerprints[2],
      hashContent(`sdl-test-case-v1\0${repeatedSlice}\0${1}`),
    );
    assert.equal(
      fingerprints[3],
      hashContent(`sdl-test-case-v1\0${repeatedSlice}\0${2}`),
    );

    const run = () =>
      applyTestCaseCandidates({
        relPath: "tests/duplicates.ts",
        symbols: [],
        calls: [],
        candidates: [...candidates].reverse(),
      });
    const first = run();
    const second = run();
    assert.deepEqual(first, second);

    const ids = buildSymbolDetails({
      symbolsWithNodeIds: first.symbols,
      tree: null,
      repoId: "repo",
      fileMeta: { path: "tests/duplicates.ts", size: content.length, mtime: 0 },
    }).map(({ symbolId }) => symbolId);
    assert.equal(new Set(ids).size, 4);
  });

  it("assigns calls to the smallest enclosing ordinary or synthetic function", () => {
    const outer = symbol("outer", "outer", range(1, 0, 20, 1));
    const nested = symbol("nested", "nested", range(8, 2, 10, 3));
    const candidate = syntheticCandidate({
      name: "case",
      constructRange: range(5, 0, 15, 1),
      sourceFingerprint: "case-fingerprint",
    });
    const result = applyTestCaseCandidates({
      relPath: "tests/example.ts",
      symbols: [outer, nested],
      calls: [call("outer", range(6, 2, 6, 8)), call("outer", range(9, 4, 9, 10))],
      candidates: [candidate],
    });

    assert.deepEqual(
      result.calls.map(({ callerNodeId }) => callerNodeId),
      [candidate.nodeId, nested.nodeId],
    );
  });

  it("breaks equal-size ownership ties by ordinary status and then node ID", () => {
    const tiedRange = range(2, 0, 6, 1);
    const result = applyTestCaseCandidates({
      relPath: "tests/example.ts",
      symbols: [symbol("z-ordinary", "z", tiedRange), symbol("a-ordinary", "a", tiedRange)],
      calls: [call("global", range(3, 2, 3, 8))],
      candidates: [
        syntheticCandidate({
          name: "case",
          constructRange: tiedRange,
          sourceFingerprint: "000-synthetic",
        }),
      ],
    });

    assert.equal(result.calls[0].callerNodeId, "a-ordinary");
  });
});

describe("sourceFingerprintForTestCase", () => {
  it("hashes the exact source slice with the versioned one-based ordinal", () => {
    const sourceSlice = 'test("works", () => {});';
    const content = `before();\n  ${sourceSlice}\nafter();`;
    assert.equal(
      sourceFingerprintForTestCase(content, range(2, 2, 2, 2 + sourceSlice.length), 3),
      hashContent(`sdl-test-case-v1\0${sourceSlice}\0${3}`),
    );
  });

  it("converts tree-sitter UTF-8 byte columns before slicing Unicode source", () => {
    const prefix = "  π";
    const sourceSlice = 'test("😀 works", () => {});';
    const content = `before();\n${prefix}${sourceSlice}\nafter();`;
    const startCol = Buffer.byteLength(prefix, "utf8");
    const endCol = Buffer.byteLength(prefix + sourceSlice, "utf8");

    assert.equal(
      sourceFingerprintForTestCase(content, range(2, startCol, 2, endCol), 1),
      hashContent(`sdl-test-case-v1\0${sourceSlice}\0${1}`),
    );
  });
});

describe("buildSymbolDetails", () => {
  it("preserves a non-empty worker fingerprint when a tree is available", () => {
    const source = "function preserved() { return 1; }\n";
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);
    const tree = adapter.parse(source, "src/example.ts");
    assert.ok(tree);
    const extracted = adapter
      .extractSymbols(tree, source, "src/example.ts")
      .find(({ name }) => name === "preserved");
    assert.ok(extracted);

    const [detail] = buildSymbolDetails({
      symbolsWithNodeIds: [{ ...extracted, astFingerprint: "worker-fingerprint" }],
      tree,
      repoId: "repo",
      fileMeta: { path: "src/example.ts", size: source.length, mtime: 0 },
    });

    assert.equal(detail.astFingerprint, "worker-fingerprint");
  });
});
