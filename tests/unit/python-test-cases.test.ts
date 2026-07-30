import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PythonAdapter } from "../../dist/indexer/adapter/python.js";

const CONTENT = [
  "import pytest",
  "import unittest",
  "",
  "@pytest.mark.parametrize('value', [1, 2])",
  "def test_parameterized(value):",
  "    pass",
  "",
  "@pytest.mark.skipif(True, reason='later')",
  "async def test_async_case():",
  "    pass",
  "",
  "def helper_test():",
  "    pass",
  "",
  "class TestPytest:",
  "    @pytest.mark.skip(reason='later')",
  "    def test_method(self):",
  "        pass",
  "",
  "    def ordinary_method(self):",
  "        pass",
  "",
  "class TestUnit(unittest.TestCase):",
  "    @unittest.skipUnless(True, 'later')",
  "    def test_contract(self):",
  "        pass",
].join("\n");

function detect(treeIsRetained = true) {
  const adapter = new PythonAdapter();
  const tree = adapter.parse(CONTENT, "tests/test_sample.py");
  assert.ok(tree);
  const symbols = adapter.extractSymbols(tree, CONTENT, "tests/test_sample.py");
  const candidates = adapter.detectTestCases?.({
    tree: treeIsRetained ? tree : null,
    content: CONTENT,
    filePath: "tests/test_sample.py",
    symbols,
  });
  assert.ok(candidates);
  return candidates;
}

describe("PythonAdapter.detectTestCases", () => {
  it("attaches pytest and unittest facets to existing test declarations", () => {
    const candidates = detect();

    assert.deepEqual(
      candidates.map((candidate) => ({
        mode: candidate.mode,
        targetName: candidate.mode === "attach" ? candidate.targetName : null,
        targetKinds:
          candidate.mode === "attach" ? candidate.targetKinds : null,
        testCase: candidate.testCase,
      })),
      [
        {
          mode: "attach",
          targetName: "test_parameterized",
          targetKinds: ["function"],
          testCase: {
            framework: "pytest",
            title: "test_parameterized",
            modifiers: ["parameterized"],
          },
        },
        {
          mode: "attach",
          targetName: "test_async_case",
          targetKinds: ["function"],
          testCase: {
            framework: "pytest",
            title: "test_async_case",
            modifiers: ["skip"],
          },
        },
        {
          mode: "attach",
          targetName: "TestPytest.test_method",
          targetKinds: ["method"],
          testCase: {
            framework: "pytest",
            title: "test_method",
            suitePath: ["TestPytest"],
            modifiers: ["skip"],
          },
        },
        {
          mode: "attach",
          targetName: "TestUnit.test_contract",
          targetKinds: ["method"],
          testCase: {
            framework: "unittest",
            title: "test_contract",
            suitePath: ["TestUnit"],
            modifiers: ["skip"],
          },
        },
      ],
    );
    assert.equal(candidates.every((candidate) => candidate.mode === "attach"), true);
  });

  it("uses the hinted one-time fallback parse when the retained tree is absent", () => {
    assert.deepEqual(detect(false), detect(true));
  });

  it("deletes only internally parsed fallback trees", () => {
    const adapter = new PythonAdapter();
    const retainedTree = adapter.parse(CONTENT, "tests/test_sample.py");
    assert.ok(retainedTree);
    const symbols = adapter.extractSymbols(retainedTree, CONTENT, "tests/test_sample.py");
    let retainedDeleteCount = 0;
    (retainedTree as unknown as { delete: () => void }).delete = () => {
      retainedDeleteCount++;
    };
    const parse = adapter.parse.bind(adapter);
    let fallbackDeleteCount = 0;
    adapter.parse = (...args) => {
      const fallbackTree = parse(...args);
      assert.ok(fallbackTree);
      (fallbackTree as unknown as { delete: () => void }).delete = () => {
        fallbackDeleteCount++;
      };
      return fallbackTree;
    };

    try {
      adapter.detectTestCases?.({
        tree: retainedTree,
        content: CONTENT,
        filePath: "tests/test_sample.py",
        symbols,
      });
      assert.equal(retainedDeleteCount, 0);

      adapter.detectTestCases?.({
        tree: null,
        content: CONTENT,
        filePath: "tests/test_sample.py",
        symbols,
      });
      assert.equal(fallbackDeleteCount, 1);
    } finally {
      (retainedTree as unknown as { delete: () => void }).delete();
    }
  });

  it("caps detection at the first 64 test declarations", () => {
    const adapter = new PythonAdapter();
    const content = Array.from(
      { length: 65 },
      (_, index) => `def test_${String(index).padStart(2, "0")}():\n    pass`,
    ).join("\n\n");
    const tree = adapter.parse(content, "tests/test_many.py");
    assert.ok(tree);
    const symbols = adapter.extractSymbols(tree, content, "tests/test_many.py");

    const candidates = adapter.detectTestCases?.({
      tree,
      content,
      filePath: "tests/test_many.py",
      symbols,
    });

    assert.equal(candidates?.length, 64);
    assert.equal(candidates?.at(-1)?.testCase.title, "test_63");
  });

  it("does not parse null-tree content without a test declaration hint", () => {
    const adapter = new PythonAdapter();
    adapter.parse = () => {
      throw new Error("content without a test hint must not be parsed");
    };
    assert.deepEqual(
      adapter.detectTestCases?.({
        tree: null,
        content: "def helper_test():\n    pass\n",
        filePath: "src/helper.py",
        symbols: [],
      }),
      [],
    );
  });
});
