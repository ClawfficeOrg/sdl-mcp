import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { copyFileWithTransientRetry } from "../../scripts/copy-file-with-retry.mjs";

describe("copyFileWithTransientRetry", () => {
  it("retries only transient Windows copy locks within a fixed bound", async () => {
    let attempts = 0;
    await copyFileWithTransientRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("locked");
        Object.assign(error, { code: attempts === 1 ? "EBUSY" : "EPERM" });
        throw error;
      }
    }, "source.js", "target.js");
    assert.equal(attempts, 3);
  });

  it("does not retry non-transient copy failures", async () => {
    let attempts = 0;
    await assert.rejects(
      copyFileWithTransientRetry(async () => {
        attempts += 1;
        const error = new Error("missing");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }, "source.js", "target.js"),
      { code: "ENOENT" },
    );
    assert.equal(attempts, 1);
  });

  it("rethrows the final transient error after four attempts", async () => {
    let attempts = 0;
    const locked = Object.assign(new Error("still locked"), { code: "EBUSY" });
    await assert.rejects(
      copyFileWithTransientRetry(async () => {
        attempts += 1;
        throw locked;
      }, "source.js", "target.js"),
      (error) => error === locked,
    );
    assert.equal(attempts, 4);
  });
});
