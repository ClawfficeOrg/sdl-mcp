import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSearchResults } from "../../dist/live-index/overlay-merge.js";

describe("mergeSearchResults", () => {
  it("prefers overlay rows over durable rows with the same symbol id", () => {
    const merged = mergeSearchResults(
      [
        {
          symbolId: "sym-1",
          name: "alpha",
          fileId: "file-1",
          kind: "function",
          filePath: "src/example.ts",
          sourceRanks: { fts: 1 },
        },
      ],
      [
        {
          symbolId: "sym-1",
          name: "alphaDraft",
          fileId: "file-1",
          kind: "function",
          filePath: "src/example.ts",
          sourceRanks: { overlay: 1 },
        },
      ],
      "alphaDraft",
      10,
    );

    assert.deepStrictEqual(
      merged.map((row) => row.name),
      ["alphaDraft"],
    );
    assert.deepStrictEqual(merged[0]?.sourceRanks, { fts: 1, overlay: 1 });
  });

  it("uses symbol id as the final deterministic tie-breaker", () => {
    const makeRow = (symbolId: string) => ({
      symbolId,
      name: "same",
      fileId: "file-1",
      kind: "function",
      filePath: "src/example.ts",
    });

    const forward = mergeSearchResults(
      [makeRow("sym-b"), makeRow("sym-a")],
      [],
      "same",
      10,
    );
    const reverse = mergeSearchResults(
      [makeRow("sym-a"), makeRow("sym-b")],
      [],
      "same",
      10,
    );

    assert.deepStrictEqual(
      forward.map((row) => row.symbolId),
      ["sym-a", "sym-b"],
    );
    assert.deepStrictEqual(
      reverse.map((row) => row.symbolId),
      ["sym-a", "sym-b"],
    );
  });
});
