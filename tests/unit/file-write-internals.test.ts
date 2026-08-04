import test from "node:test";
import assert from "node:assert/strict";

import { syncLiveIndex } from "../../dist/mcp/tools/file-write-internals.js";

test("skips non-source files without database access", async () => {
  const result = await syncLiveIndex(
    "repo-does-not-need-to-exist",
    "notes.txt",
    "plain text",
  );

  assert.equal(result, undefined);
});
