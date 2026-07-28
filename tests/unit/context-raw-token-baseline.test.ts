import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  calculateContextRawEquivalentTokens,
  collectContextRawTokenSources,
  estimateContextRawEquivalentTokens,
} from "../../dist/mcp/tools/context.js";

function evidence(symbolId: string, path: string): Record<string, unknown> {
  return {
    rung: "card",
    symbolId,
    path,
    rank: 1,
    tier: 0,
    lanes: ["exactIdentifier"],
    content: { name: "example" },
  };
}

describe("sdl.context v2 raw token baseline", () => {
  it("collects source files and symbols from canonical evidence", () => {
    const symbolId = "a".repeat(64);
    const otherSymbolId = "b".repeat(64);
    const sources = collectContextRawTokenSources({
      evidence: [
        evidence(symbolId, "src/mcp/tools/context.ts"),
        evidence(otherSymbolId, "README.md"),
      ],
    });

    assert.deepEqual([...sources.symbolIds].sort(), [
      symbolId,
      otherSymbolId,
    ]);
    assert.deepEqual([...sources.relPaths].sort(), [
      "README.md",
      "src/mcp/tools/context.ts",
    ]);
    assert.equal(sources.evidenceCount, 2);
  });

  it("does not apply per-result fallback to resolved evidence", () => {
    assert.equal(
      calculateContextRawEquivalentTokens({
        fileRawTokens: 125,
        evidenceCount: 3,
        resolvedEvidenceCount: 3,
      }),
      125,
    );
  });

  it("adds the floor only for unresolved evidence", () => {
    assert.equal(
      calculateContextRawEquivalentTokens({
        fileRawTokens: 125,
        evidenceCount: 4,
        resolvedEvidenceCount: 2,
      }),
      725,
    );
  });

  it("counts repeated evidence while deduplicating source files", () => {
    const item = evidence("c".repeat(64), "src/foo.ts");
    const sources = collectContextRawTokenSources({
      evidence: [item, item],
    });

    assert.equal(sources.evidenceCount, 2);
    assert.deepEqual([...sources.relPaths], ["src/foo.ts"]);
  });

  it("ignores removed v1 response fields", async () => {
    const rawTokens = await estimateContextRawEquivalentTokens("missing-repo", {
      finalEvidence: [
        { type: "searchResult", reference: "search:1", summary: "legacy" },
      ],
      actionsTaken: [{ evidence: [{ reference: "search:2" }] }],
      metrics: { totalTokens: 10_000 },
    });

    assert.equal(rawTokens, 0);
  });

  it("uses a per-result floor when canonical evidence cannot resolve", async () => {
    const rawTokens = await estimateContextRawEquivalentTokens("missing-repo", {
      evidence: [
        evidence("missing-a", "src/missing-a.ts"),
        evidence("missing-b", "src/missing-b.ts"),
        evidence("missing-c", "src/missing-c.ts"),
      ],
    });

    assert.equal(rawTokens, 900);
  });

  it("uses DB-resolved canonical evidence files", async () => {
    const repoId = "context-v2-raw-token-baseline-db-test";
    const graphDbPath = mkdtempSync(
      join(tmpdir(), "sdl-context-v2-raw-baseline-db-"),
    );
    const now = new Date().toISOString();

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    try {
      const conn = await getLadybugConn();
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: graphDbPath,
        configJson: "{}",
        createdAt: now,
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "file-context",
        repoId,
        relPath: "src/mcp/tools/context.ts",
        contentHash: "hash-context",
        language: "ts",
        byteSize: 4_000,
        lastIndexedAt: now,
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "file-readme",
        repoId,
        relPath: "README.md",
        contentHash: "hash-readme",
        language: "markdown",
        byteSize: 800,
        lastIndexedAt: now,
      });

      const rawTokens = await estimateContextRawEquivalentTokens(repoId, {
        evidence: [
          evidence("missing-a", "src/mcp/tools/context.ts"),
          evidence("missing-b", "README.md"),
        ],
      });

      assert.equal(rawTokens, 1_200);
    } finally {
      await closeLadybugDb();
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });
});
