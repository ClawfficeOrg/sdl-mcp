import { describe, it } from "node:test";
import assert from "node:assert";
import { attachDisplayFooter } from "../../dist/server.js";

describe("attachDisplayFooter", () => {
  it("adds _displayFooter to object payloads", () => {
    const input = { ok: true };
    const output = attachDisplayFooter(input, "footer text") as Record<
      string,
      unknown
    >;

    assert.strictEqual(output.ok, true);
    assert.strictEqual(output._displayFooter, "footer text");
    assert.ok(
      !("_displayFooter" in input),
      "should not mutate original object",
    );
  });

  it("merges with existing _displayFooter", () => {
    const input = { ok: true, _displayFooter: "existing" };
    const output = attachDisplayFooter(input, "new") as Record<string, unknown>;

    assert.strictEqual(output._displayFooter, "existing\n\nnew");
  });

  it("returns non-object payloads unchanged", () => {
    assert.strictEqual(attachDisplayFooter("x", "footer"), "x");
    assert.strictEqual(attachDisplayFooter(42, "footer"), 42);
    assert.strictEqual(attachDisplayFooter(null, "footer"), null);
  });

  it("returns arrays unchanged", () => {
    const arr = [1, 2, 3];
    const output = attachDisplayFooter(arr, "footer");
    assert.strictEqual(output, arr);
  });

  it("works correctly with canonical context results", () => {
    const context = {
      status: "complete",
      taskType: "explain",
      retrieval: { level: "lexical", lanes: [] },
      evidence: [],
      edges: [],
      omitted: { total: 0, byReason: { budget: 0 }, highestRanked: [] },
      nextActions: [],
      etag: "etag-1",
    };
    const output = attachDisplayFooter(
      context,
      "📊 1k / 5k tokens",
    ) as Record<string, unknown>;

    assert.strictEqual(output.status, "complete");
    assert.strictEqual(output._displayFooter, "📊 1k / 5k tokens");
    assert.deepStrictEqual(output.evidence, []);
  });
});
