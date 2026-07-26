import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { beginGraphIntegrityVersion } from "../../dist/db/ladybug-derived-state.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import { handleSliceBuild } from "../../dist/mcp/tools/slice.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-mcp-confidence-filtering-test-db.lbug");

describe("MCP confidence-aware filtering", () => {
  const repoId = "mcp-confidence-repo";

  before(async () => {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(TEST_DB_PATH);
    const conn = await getLadybugConn();
    const now = "2026-03-05T14:00:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "integration",
      prevVersionHash: null,
      versionHash: "v1-hash",
    });
    await beginGraphIntegrityVersion(conn, repoId, "v1", "0".repeat(64), true);

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId,
      relPath: "src/app.ts",
      contentHash: "hash-1",
      language: "ts",
      byteSize: 150,
      lastIndexedAt: now,
    });

    const symbols = [
      { symbolId: "sym-entry", name: "entry" },
      { symbolId: "sym-high", name: "highConfidence" },
      { symbolId: "sym-low", name: "lowConfidence" },
      { symbolId: "sym-isolated", name: "isolated" },
      { symbolId: "sym-budget-root", name: "budgetRoot" },
      { symbolId: "sym-budget-import", name: "budgetImport" },
    ];

    for (const symbol of symbols) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId: symbol.symbolId,
        repoId,
        fileId: "file-1",
        kind: "function",
        name: symbol.name,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 4,
        rangeEndCol: 0,
        astFingerprint: `${symbol.symbolId}-fp`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    await ladybugDb.insertEdges(conn, [
      {
        repoId,
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-high",
        edgeType: "call",
        weight: 1,
        confidence: 0.94,
        resolution: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
        provenance: "ts-compiler",
        createdAt: now,
      },
      {
        repoId,
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-low",
        edgeType: "call",
        weight: 1,
        confidence: 0.33,
        resolution: "global-fallback",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: "heuristic",
        createdAt: now,
      },
      {
        repoId,
        fromSymbolId: "sym-budget-root",
        toSymbolId: "sym-budget-import",
        edgeType: "import",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: "static",
        createdAt: now,
      },
    ]);
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("threads minCallConfidence through symbol and slice MCP handlers", async () => {
    const cardResponse = await handleSymbolGetCard({
      repoId,
      symbolId: "sym-entry",
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.ok(!("notModified" in cardResponse));
    assert.deepStrictEqual(cardResponse.card.deps.calls, ["highConfidence"]);
    assert.equal(cardResponse.card.callResolution?.calls.length, 1);

    const sliceResponse = await handleSliceBuild({
      repoId,
      entrySymbols: ["sym-entry"],
      wireFormat: "standard",
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
      minConfidence: 0,
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.ok("slice" in sliceResponse);
    assert.ok(!("relationshipNote" in sliceResponse));
    const slice = sliceResponse.slice;
    assert.ok("cards" in slice, "Expected standard wire format with cards");
    const entryCard = slice.cards.find(
      (card: { symbolId: string }) => card.symbolId === "sym-entry",
    );
    assert.ok(entryCard);
    assert.deepStrictEqual(entryCard?.deps.calls, [
      { symbolId: "sym-high", confidence: 0.94 },
    ]);
    assert.deepStrictEqual(entryCard?.callResolution?.calls, [
      {
        symbolId: "sym-high",
        label: "highConfidence",
        confidence: 0.94,
        resolutionReason: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
      },
    ]);
  });

  it("omits relationship guidance for inferred empty slices", async () => {
    const response = await handleSliceBuild({
      repoId,
      taskText: "isolated",
      wireFormat: "standard",
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
    });

    assert.ok("slice" in response);
    assert.ok(!("relationshipNote" in response));
  });

  it("omits relationship guidance when an explicit slice has frontier spillover", async () => {
    const response = await handleSliceBuild({
      repoId,
      entrySymbols: ["sym-budget-root"],
      wireFormat: "standard",
      budget: { maxCards: 1, maxEstimatedTokens: 10_000 },
    });

    assert.ok("slice" in response);
    assert.ok(typeof response.slice !== "string");
    assert.strictEqual(response.slice.truncation?.truncated, true);
    assert.ok(
      response.slice.frontier?.some(
        (item: { symbolId: string }) => item.symbolId === "sym-budget-import",
      ),
    );
    assert.ok(!("relationshipNote" in response));
  });

  it("guides relationship inspection for an edge-empty slice", async () => {
    const request = {
      repoId,
      entrySymbols: ["sym-isolated"],
      wireFormat: "compact" as const,
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
    };
    const response = await handleSliceBuild(request);
    const repeated = await handleSliceBuild(request);

    assert.ok("slice" in response);
    assert.strictEqual(
      response.relationshipNote,
      "No usable graph path was found from the selected starts. Inspect each start symbol's dependencies, then retry with a connected symbol in entrySymbols.",
    );
    assert.ok("slice" in repeated);
    assert.strictEqual(
      response.relationshipNote,
      repeated.relationshipNote,
      "relationship guidance must be byte-stable across repeated calls",
    );
  });
});
