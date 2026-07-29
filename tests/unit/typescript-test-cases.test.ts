import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TypeScriptAdapter } from "../../dist/indexer/adapter/typescript.js";
import {
  detectTypeScriptTestCases,
} from "../../dist/indexer/typescript-test-cases.js";
import { sourceFingerprintForTestCase } from "../../dist/indexer/test-case-normalizer.js";

function projected(content: string, filePath = "tests/unit/sample.test.ts") {
  return detectTypeScriptTestCases({ content, filePath }).map((candidate) => ({
    mode: candidate.mode,
    name: candidate.name,
    nodeId: candidate.nodeId,
    sourceFingerprint: candidate.sourceFingerprint,
    constructRange: candidate.constructRange,
    testCase: candidate.testCase,
  }));
}

describe("detectTypeScriptTestCases", () => {
  it("detects nested node:test cases with static titles and modifiers", () => {
    const content = [
      'import test, { describe, it } from "node:test";',
      'describe("Code Mode", () => {',
      '  test.skip("rejects info and sdl.info as sdl.workflow actions", () => {});',
      '  describe("exclusive", () => {',
      '    it.only(`keeps sdl.info callable and discoverable in exclusive Code Mode`, () => {});',
      "  });",
      '  test.todo("future contract");',
      '  it.only.each([[1]])("parameterized contract", () => {});',
      "});",
    ].join("\n");

    const adapter = new TypeScriptAdapter();
    assert.deepEqual(
      adapter.detectTestCases({
        tree: null,
        content,
        filePath: "tests/unit/sample.test.ts",
        symbols: [],
      }),
      detectTypeScriptTestCases({
        content,
        filePath: "tests/unit/sample.test.ts",
      }),
    );

    const candidates = projected(content);
    assert.deepEqual(
      candidates.map(({ testCase }) => testCase),
      [
        {
          framework: "node:test",
          title: "rejects info and sdl.info as sdl.workflow actions",
          suitePath: ["Code Mode"],
          modifiers: ["skip"],
        },
        {
          framework: "node:test",
          title:
            "keeps sdl.info callable and discoverable in exclusive Code Mode",
          suitePath: ["Code Mode", "exclusive"],
          modifiers: ["only"],
        },
        {
          framework: "node:test",
          title: "future contract",
          suitePath: ["Code Mode"],
          modifiers: ["todo"],
        },
        {
          framework: "node:test",
          title: "parameterized contract",
          suitePath: ["Code Mode"],
          modifiers: ["only", "parameterized"],
        },
      ],
    );
    for (const candidate of candidates) {
      assert.equal(candidate.mode, "synthetic");
      assert.equal(candidate.name, candidate.testCase.title);
      assert.equal(candidate.nodeId, `sdl:test-case:${candidate.sourceFingerprint}`);
    }
    assert.deepEqual(projected(content), candidates);
  });

  it("detects imported Vitest/Jest aliases and unimported Jest globals", () => {
    const fixtures = [
      {
        content: [
          'import { describe as suite, test as spec, it } from "vitest";',
          'suite("Vitest suite", () => {',
          '  spec("vitest alias", () => {});',
          '  it.each([[1]])("vitest each", () => {});',
          "});",
        ].join("\n"),
        framework: "vitest",
        titles: ["vitest alias", "vitest each"],
      },
      {
        content: [
          'const { describe: suite, test: check } = require("@jest/globals");',
          'suite("Jest suite", () => check.only("jest alias", () => {}));',
        ].join("\n"),
        framework: "jest",
        titles: ["jest alias"],
      },
      {
        content: [
          'import { test as nodeCase } from "node:test";',
          'import { test as vitestCase } from "vitest";',
          'nodeCase("priority node", () => {});',
          'vitestCase("priority vitest", () => {});',
        ].join("\n"),
        framework: "node:test",
        titles: ["priority node", "priority vitest"],
      },
      {
        content: [
          'describe("global suite", () => {',
          '  test("global test", () => {});',
          '  it.skip("global it", () => {});',
          "});",
        ].join("\n"),
        framework: "jest",
        titles: ["global test", "global it"],
      },
    ];

    for (const fixture of fixtures) {
      const cases = projected(fixture.content);
      assert.deepEqual(
        cases.map(({ testCase }) => testCase.framework),
        fixture.titles.map(() => fixture.framework),
      );
      assert.deepEqual(
        cases.map(({ testCase }) => testCase.title),
        fixture.titles,
      );
    }
  });

  it("rejects dynamic titles and ordinary callback calls", () => {
    const content = [
      'test(`${dynamicTitle}`, () => {});',
      'test("dynamic " + title, () => {});',
      'contest("not a test", () => {});',
      'helper("not a test", () => {});',
    ].join("\n");

    assert.deepEqual(projected(content), []);
  });

  it("bounds titles and gives duplicate source slices deterministic fingerprints", () => {
    const longTitle = "😀".repeat(300);
    const content = [
      `test(${JSON.stringify(longTitle)}, () => same());`,
      'test("duplicate", () => first());',
      'test("duplicate", () => second());',
      'test("identical", () => same());',
      'test("identical", () => same());',
    ].join("\n");

    const first = projected(content);
    const second = projected(content);
    assert.deepEqual(second, first);
    assert.equal(Array.from(first[0]?.testCase.title ?? "").length, 256);
    assert.equal(new Set(first.map(({ sourceFingerprint }) => sourceFingerprint)).size, 5);
    [1, 1, 1, 1, 2].forEach((ordinal, index) => {
      const candidate = first[index];
      assert.ok(candidate);
      assert.equal(
        candidate.sourceFingerprint,
        sourceFingerprintForTestCase(content, candidate.constructRange, ordinal),
      );
    });
  });

  it("uses a cheap source hint before parsing", () => {
    assert.deepEqual(
      detectTypeScriptTestCases({
        content: "export const value = 1;",
        filePath: "src/value.ts",
      }),
      [],
    );
  });
});
