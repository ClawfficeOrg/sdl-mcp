import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTestCaseFacet,
  parseTestCaseFacetJson,
  serializeTestCaseFacet,
  TEST_CASE_MODIFIER_ORDER,
} from "../../dist/util/test-case.js";

const suitePath = Array.from({ length: 18 }, (_, index) => ` suite ${index} `);

const expectedFacet = {
  framework: "node:test",
  title: "keeps sdl.info callable",
  suitePath: Array.from({ length: 16 }, (_, index) => `suite ${index + 2}`),
  modifiers: ["skip", "only", "parameterized"],
};

test("normalizes semantic test-case metadata deterministically", () => {
  assert.deepEqual(
    normalizeTestCaseFacet({
      framework: "Node:Test",
      title: "  keeps   sdl.info callable  ",
      suitePath,
      category: "test",
      modifiers: ["only", "skip", "only", "parameterized"],
    }),
    expectedFacet,
  );
});

test("serializes keys in canonical order and parses the result", () => {
  const serialized = serializeTestCaseFacet({
    framework: "Node:Test",
    title: "  keeps   sdl.info callable  ",
    suitePath,
    category: "test",
    modifiers: ["only", "skip", "only", "parameterized"],
  });

  assert.equal(
    serialized,
    `{"framework":"node:test","title":"keeps sdl.info callable","suitePath":[${Array.from(
      { length: 16 },
      (_, index) => `"suite ${index + 2}"`,
    ).join(",")}],"modifiers":["skip","only","parameterized"]}`,
  );
  assert.deepEqual(parseTestCaseFacetJson(serialized), expectedFacet);
});

test("uses framework, title, suitePath, category, modifiers key order", () => {
  assert.equal(
    serializeTestCaseFacet({
      framework: "vitest",
      title: "bench",
      suitePath: ["suite"],
      category: "benchmark",
      modifiers: ["todo"],
    }),
    '{"framework":"vitest","title":"bench","suitePath":["suite"],"category":"benchmark","modifiers":["todo"]}',
  );
});

test("rejects blank required fields", () => {
  assert.equal(normalizeTestCaseFacet({ framework: "node:test", title: " \n\t " }), undefined);
  assert.equal(normalizeTestCaseFacet({ framework: " \n\t ", title: "works" }), undefined);
  assert.equal(serializeTestCaseFacet({ framework: "node:test", title: "   " }), undefined);
});

test("bounds normalized text by Unicode code points", () => {
  const normalized = normalizeTestCaseFacet({
    framework: " Node:Test ",
    title: `  ${"😀".repeat(300)}   tail  `,
    suitePath: [` ${"🪲".repeat(300)}   tail `],
  });

  assert.ok(normalized);
  assert.equal(normalized.framework, "node:test");
  assert.equal(normalized.title, "😀".repeat(256));
  assert.equal(normalized.suitePath?.[0], "🪲".repeat(256));
  assert.equal([...normalized.title].length, 256);
  assert.equal([...(normalized.suitePath?.[0] ?? "")].length, 256);
});

test("collapses repeated whitespace and drops empty suite segments", () => {
  assert.deepEqual(
    normalizeTestCaseFacet({
      framework: " node:test ",
      title: " keeps\n\t working ",
      suitePath: [" first ", " \t ", "\n", " second   suite "],
    }),
    {
      framework: "node:test",
      title: "keeps working",
      suitePath: ["first", "second suite"],
    },
  );
});

test("omits the default test category", () => {
  assert.deepEqual(
    normalizeTestCaseFacet({ framework: "node:test", title: "works", category: "test" }),
    { framework: "node:test", title: "works" },
  );
});

test("rejects unknown categories and modifiers", () => {
  assert.equal(
    normalizeTestCaseFacet({ framework: "node:test", title: "works", category: "unit" }),
    undefined,
  );
  assert.equal(
    normalizeTestCaseFacet({ framework: "node:test", title: "works", modifiers: ["focus"] }),
    undefined,
  );
});

test("emits modifiers in fixed order", () => {
  assert.deepEqual(TEST_CASE_MODIFIER_ORDER, ["skip", "todo", "only", "parameterized"]);
  assert.deepEqual(
    normalizeTestCaseFacet({
      framework: "node:test",
      title: "works",
      modifiers: ["parameterized", "only", "todo", "skip", "todo"],
    }),
    {
      framework: "node:test",
      title: "works",
      modifiers: ["skip", "todo", "only", "parameterized"],
    },
  );
});

test("parsing rejects malformed JSON and invalid field shapes", () => {
  assert.equal(parseTestCaseFacetJson("{"), undefined);
  assert.equal(parseTestCaseFacetJson(null), undefined);
  assert.equal(parseTestCaseFacetJson(undefined), undefined);

  for (const value of [
    "null",
    "[]",
    '{"framework":1,"title":"works"}',
    '{"framework":"node:test","title":[]}',
    '{"framework":"node:test","title":"works","suitePath":"suite"}',
    '{"framework":"node:test","title":"works","suitePath":[1]}',
    '{"framework":"node:test","title":"works","category":1}',
    '{"framework":"node:test","title":"works","modifiers":"skip"}',
    '{"framework":"node:test","title":"works","modifiers":[1]}',
  ]) {
    assert.equal(parseTestCaseFacetJson(value), undefined, value);
  }
});
