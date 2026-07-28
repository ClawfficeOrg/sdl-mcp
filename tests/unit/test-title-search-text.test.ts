import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractStaticTestTitleSearchText } from "../../dist/indexer/test-title-search-text.js";

const TEST_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

describe("extractStaticTestTitleSearchText", () => {
  it("collects normalized static test titles in source order", () => {
    const source = [
      'describe("registration   contract", () => {});',
      "it.only(`keeps sdl.info callable`, () => {});",
      'test.skip("rejects sdl.info as sdl.workflow action", () => {});',
      'test.todo("future static title");',
    ].join("\n");

    assert.equal(
      extractStaticTestTitleSearchText(source, "tests/unit/sample.test.ts"),
      [
        "registration contract",
        "keeps sdl.info callable",
        "rejects sdl.info as sdl.workflow action",
        "future static title",
      ].join("\n"),
    );
  });

  it("accepts only supported direct callees and static title arguments", () => {
    const source = [
      'describe("describe title", () => {});',
      "it(`it title`, () => {});",
      'test.only("only title", () => {});',
      'describe.skip("skip title", () => {});',
      'it.todo("todo title");',
      'test["only"]("computed property", () => {});',
      'suite("non-test call", () => {});',
      'object.test("nested base", () => {});',
      'test.only.each("nested property chain", () => {});',
      'test.concurrent("unsupported property", () => {});',
      'const alias = test; alias("alias", () => {});',
      'test(`${dynamicTitle}`, () => {});',
      'test("dynamic " + title, () => {});',
      'test(getTitle(), () => {});',
      'test("", () => {});',
      'test(`   `, () => {});',
    ].join("\n");

    assert.equal(
      extractStaticTestTitleSearchText(source, "tests/unit/sample.test.ts"),
      [
        "describe title",
        "it title",
        "only title",
        "skip title",
        "todo title",
      ].join("\n"),
    );
  });

  it("collapses JavaScript whitespace to one ASCII space", () => {
    const source = "test(`  collapses\\tJavaScript\\n\\u00a0 whitespace  `, () => {});";

    assert.equal(
      extractStaticTestTitleSearchText(source, "tests/unit/sample.test.ts"),
      "collapses JavaScript whitespace",
    );
  });

  it("truncates by Unicode code point before exact case-sensitive deduplication", () => {
    const astral = "😀";
    const sharedPrefix = astral.repeat(256);
    const source = [
      `test(${JSON.stringify(`${sharedPrefix}a`)}, () => {});`,
      `test(${JSON.stringify(`${sharedPrefix}b`)}, () => {});`,
      'test("Case", () => {});',
      'test("case", () => {});',
    ].join("\n");

    const titles = extractStaticTestTitleSearchText(
      source,
      "tests/unit/sample.test.ts",
    ).split("\n");

    assert.deepEqual(titles, [sharedPrefix, "Case", "case"]);
    assert.equal(Array.from(titles[0] ?? "").length, 256);
  });

  it("retains at most 64 titles and 2,048 title code points", () => {
    const titleCountSource = Array.from(
      { length: 70 },
      (_, index) => `test("title ${index}", () => {});`,
    ).join("\n");
    const retainedTitles = extractStaticTestTitleSearchText(
      titleCountSource,
      "tests/unit/sample.test.ts",
    ).split("\n");

    assert.equal(retainedTitles.length, 64);
    assert.equal(retainedTitles.at(-1), "title 63");

    const astral = "😀";
    const fullTitles = Array.from(
      { length: 7 },
      (_, index) => `${index}${astral.repeat(255)}`,
    );
    const source = [
      ...fullTitles.map((title) => `test(${JSON.stringify(title)}, () => {});`),
      'test("short", () => {});',
      `test(${JSON.stringify(`z${astral.repeat(255)}`)}, () => {});`,
      'test("must not be retained", () => {});',
    ].join("\n");

    const boundedTitles = extractStaticTestTitleSearchText(
      source,
      "tests/unit/sample.test.ts",
    ).split("\n");
    const totalTitleCodePoints = boundedTitles.reduce(
      (total, title) => total + Array.from(title).length,
      0,
    );

    assert.equal(totalTitleCodePoints, 2_048);
    assert.equal(Array.from(boundedTitles.at(-1) ?? "").length, 251);
    assert.equal(boundedTitles.includes("must not be retained"), false);
    for (const title of boundedTitles) {
      assert.ok(Array.from(title).length <= 256);
    }
  });

  it("is byte-identical across repeated calls and supported extensions", () => {
    const source = [
      'describe("registration contract", () => {});',
      'test.only("keeps sdl.info callable", () => {});',
    ].join("\n");
    const expected = "registration contract\nkeeps sdl.info callable";

    for (const extension of TEST_EXTENSIONS) {
      const filePath = `tests/unit/sample.test${extension}`;
      const first = extractStaticTestTitleSearchText(source, filePath);
      const second = extractStaticTestTitleSearchText(source, filePath);

      assert.equal(first, expected);
      assert.equal(second, first);
      assert.deepEqual(Buffer.from(second), Buffer.from(first));
    }
  });
});
