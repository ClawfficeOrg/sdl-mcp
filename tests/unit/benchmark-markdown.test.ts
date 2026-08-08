import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeMarkdownTableCell } from "../../dist/benchmark/markdown.js";

describe("escapeMarkdownTableCell", () => {
  it("escapes pipes that would create Markdown table columns", () => {
    assert.equal(
      escapeMarkdownTableCell("left|right"),
      String.raw`left\|right`,
    );
  });

  it("preserves literal backslashes", () => {
    assert.equal(
      escapeMarkdownTableCell(String.raw`left\right`),
      String.raw`left\\right`,
    );
  });

  it("escapes an existing backslash before a pipe", () => {
    assert.equal(
      escapeMarkdownTableCell(String.raw`left\|right`),
      String.raw`left\\\|right`,
    );
  });
});
