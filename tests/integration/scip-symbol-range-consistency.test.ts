import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import { handleCodeNeedWindow, handleGetSkeleton } from "../../dist/mcp/tools/code.js";
import {
  getSearchEditPlanStore,
  resetSearchEditPlanStore,
} from "../../dist/mcp/tools/search-edit/plan-store.js";
import { handleSymbolEdit } from "../../dist/mcp/tools/symbol-edit/index.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import type {
  CodeNeedWindowResponse,
  GetSkeletonResponse,
  SymbolEditPreviewResponse,
  SymbolGetCardResponse,
} from "../../dist/mcp/tools.js";
import type { ScipDocument } from "../../dist/scip/types.js";

const REPO_ID = "scip-range-consistency";
const REL_PATH = "src/config.ts";
const SYMBOL = "scip-typescript npm fixture 1.0.0 src/config/SETTINGS.";
const DECLARATION = [
  "export const SETTINGS = {",
  "  enabled: true,",
  "  nested: {",
  "    value: 1,",
  "  },",
  "};",
].join("\n");
const SOURCE = [
  "// unrelated setup",
  "export const OTHER = 1;",
  "",
  "// indexed declaration",
  DECLARATION,
].join("\n");
const RANGE = { startLine: 5, startCol: 0, endLine: 10, endCol: 2 };

let repoRoot = "";

afterEach(async () => {
  resetSearchEditPlanStore();
  await closeLadybugDb();
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = "";
});

describe("SCIP declaration range consistency", { concurrency: false }, () => {
  it("uses the persisted declaration span for cards, code views, and edit preview", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sdl-scip-range-"));
    await mkdir(join(repoRoot, "src"), { recursive: true });
    const absPath = join(repoRoot, REL_PATH);
    await writeFile(absPath, SOURCE, "utf8");
    await writeFile(join(repoRoot, "package.json"), "{}", "utf8");
    await initLadybugDb(join(repoRoot, "graph.lbug"));

    const document: ScipDocument = {
      language: "typescript",
      relativePath: REL_PATH,
      occurrences: [{
        range: { startLine: 4, startCol: 13, endLine: 4, endCol: 21 },
        symbol: SYMBOL,
        symbolRoles: 1,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      }],
      symbols: [{
        symbol: SYMBOL,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "SETTINGS",
      }],
    };
    const neededLines = collectNeededSourceLines([document]).get(REL_PATH)!;
    const sourceLines = selectNeededLines(SOURCE, neededLines);
    assert.equal(sourceLines.has(0), false);
    assert.equal(sourceLines.keys().next().value, 4);
    const fact = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-range",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [document],
      sourceLinesByPath: new Map([[REL_PATH, sourceLines]]),
    }).symbols[0];
    assert.deepEqual(fact.range, RANGE);

    const conn = await getLadybugConn();
    const fileStats = await stat(absPath);
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoRoot,
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file-config",
      repoId: REPO_ID,
      relPath: REL_PATH,
      language: "typescript",
      contentHash: createHash("sha256").update(SOURCE).digest("hex"),
      byteSize: fileStats.size,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: fact.symbolId,
      repoId: REPO_ID,
      fileId: "file-config",
      kind: fact.symbolKind,
      name: fact.name,
      exported: true,
      visibility: "exported",
      language: "typescript",
      rangeStartLine: RANGE.startLine,
      rangeStartCol: RANGE.startCol,
      rangeEndLine: RANGE.endLine,
      rangeEndCol: RANGE.endCol,
      astFingerprint: "fp-settings-range",
      signatureJson: JSON.stringify({ name: fact.name }),
      summary: "Fixture settings",
      invariantsJson: "[]",
      sideEffectsJson: "[]",
      updatedAt: now,
    });

    const card = (await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: fact.symbolId,
      refsMode: "off",
    })) as SymbolGetCardResponse;
    const skeleton = (await handleGetSkeleton({
      repoId: REPO_ID,
      symbolId: fact.symbolId,
      maxLines: 20,
      refsMode: "off",
    })) as GetSkeletonResponse;
    const window = (await handleCodeNeedWindow({
      repoId: REPO_ID,
      symbolId: fact.symbolId,
      identifiersToFind: ["SETTINGS"],
      reason: "Verify the indexed declaration range",
      expectedLines: 6,
      maxLines: 20,
      maxTokens: 1000,
      responseMode: "inline",
      granularity: "symbol",
    })) as CodeNeedWindowResponse;
    const edit = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolId: fact.symbolId,
      operation: {
        kind: "replaceSymbol",
        content: DECLARATION.replace("enabled: true", "enabled: false"),
      },
    })) as SymbolEditPreviewResponse;
    const storedPlan = getSearchEditPlanStore().get(edit.planHandle);

    assert.equal(edit.operation, "replaceSymbol");
    assert.deepEqual(
      storedPlan?.symbolEdit?.preconditions.symbol.range,
      RANGE,
    );
    assert.equal(storedPlan?.symbolEdit?.operation, "replaceSymbol");
    assert.match(edit.fileEntries[0]?.snippets.before ?? "", / 5 \| export const SETTINGS/);
    assert.match(edit.fileEntries[0]?.snippets.before ?? "", />6 \|   enabled: true,/);
    assert.deepEqual(card.card.range, RANGE);
    assert.deepEqual(skeleton.range, RANGE);
    assert.deepEqual(window.range, RANGE);
    assert.match(edit.planHandle, /^se-/);
  });
});
