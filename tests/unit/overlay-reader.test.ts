import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type {
  EdgeForSlice,
  EdgeRow,
  FileRow,
  SymbolRow,
} from "../../dist/db/ladybug-queries.js";
import {
  getDefaultOverlayStore,
  resetDefaultLiveIndexCoordinator,
} from "../../dist/live-index/coordinator.js";
import {
  getOverlaySnapshot,
  clearSnapshotCache,
  getOverlaySymbol,
  mergeEdgeMapWithOverlay,
  mergeSymbolRowsWithOverlay,
  type OverlaySnapshot,
} from "../../dist/live-index/overlay-reader.js";
import { hydrateContextBundles } from "../../dist/context/hydrate.js";

const repoId = "overlay-repo";
const filePath = "src/overlay.ts";
const fileId = `${repoId}:${filePath}`;
const symbolId = `${repoId}:${filePath}:function:overlayFn:fp-overlay`;

function makeFileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    fileId,
    repoId,
    relPath: filePath,
    contentHash: "file-hash",
    language: "typescript",
    byteSize: 128,
    lastIndexedAt: null,
    directory: "src",
    ...overrides,
  };
}

function makeSymbolRow(overrides: Partial<SymbolRow> = {}): SymbolRow {
  return {
    symbolId,
    repoId,
    fileId,
    kind: "function",
    name: "overlayFn",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 5,
    rangeEndCol: 0,
    astFingerprint: "fp-overlay",
    signatureJson: null,
    summary: "overlay summary",
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: "overlayFn overlay summary",
    updatedAt: "2026-03-18T12:00:00.000Z",
    ...overrides,
  };
}

function makeEdgeRow(overrides: Partial<EdgeRow> = {}): EdgeRow {
  return {
    repoId,
    fromSymbolId: symbolId,
    toSymbolId: "target-symbol",
    edgeType: "call",
    weight: 1,
    confidence: 0.95,
    resolution: "exact",
    resolverId: "pass1-generic",
    resolutionPhase: "pass1",
    provenance: "call:target",
    createdAt: "2026-03-18T12:00:00.000Z",
    ...overrides,
  };
}

function seedOverlayEntry(edges: EdgeRow[] = [makeEdgeRow()]): void {
  const store = getDefaultOverlayStore();
  store.upsertDraft({
    repoId,
    eventType: "change",
    filePath,
    content: "export function overlayFn() { return 1; }",
    language: "typescript",
    version: 1,
    dirty: true,
    timestamp: "2026-03-18T12:00:00.000Z",
  });
  store.setParseResult(
    repoId,
    filePath,
    1,
    {
      version: 1,
      file: makeFileRow(),
      symbols: [makeSymbolRow()],
      edges,
      references: [],
    },
    "2026-03-18T12:00:01.000Z",
  );
}

describe("overlay-reader", () => {
  beforeEach(() => {
    resetDefaultLiveIndexCoordinator();
    clearSnapshotCache();
  });

  it("getOverlaySnapshot returns empty shape when overlay has no drafts", () => {
    const snapshot = getOverlaySnapshot(repoId);

    assert.strictEqual(snapshot.repoId, repoId);
    assert.deepStrictEqual(Array.from(snapshot.touchedFileIds), []);
    assert.strictEqual(snapshot.symbolsById.size, 0);
    assert.strictEqual(snapshot.filesById.size, 0);
    assert.strictEqual(snapshot.outgoingEdgesBySymbolId.size, 0);
  });

  it("getOverlaySnapshot returns cached object for unchanged version", () => {
    const first = getOverlaySnapshot(repoId);
    const second = getOverlaySnapshot(repoId);

    assert.strictEqual(first, second);
  });

  it("does not reuse a cached snapshot after coordinator reset", () => {
    seedOverlayEntry();
    const store = getDefaultOverlayStore();
    const firstVersion = store.getSnapshotVersion(repoId);
    const first = getOverlaySnapshot(repoId);
    const replacementSymbolId = `${symbolId}-replacement`;

    resetDefaultLiveIndexCoordinator();
    store.upsertDraft({
      repoId,
      eventType: "change",
      filePath,
      content: "export function replacementFn() { return 2; }",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: "2026-03-18T12:01:00.000Z",
    });
    store.setParseResult(
      repoId,
      filePath,
      1,
      {
        version: 1,
        file: makeFileRow({ contentHash: "replacement-file-hash" }),
        symbols: [
          makeSymbolRow({
            symbolId: replacementSymbolId,
            name: "replacementFn",
          }),
        ],
        edges: [],
        references: [],
      },
      "2026-03-18T12:01:01.000Z",
    );

    const secondVersion = store.getSnapshotVersion(repoId);
    const second = getOverlaySnapshot(repoId);

    assert.ok(secondVersion > firstVersion);
    assert.notStrictEqual(second, first);
    assert.ok(second.symbolsById.has(replacementSymbolId));
    assert.ok(!second.symbolsById.has(symbolId));
  });

  it("clearSnapshotCache forces snapshot recompute", () => {
    const first = getOverlaySnapshot(repoId);
    clearSnapshotCache();
    const second = getOverlaySnapshot(repoId);

    assert.notStrictEqual(first, second);
  });

  it("getOverlaySnapshot includes parsed overlay symbols/files/edges", () => {
    seedOverlayEntry();

    const snapshot = getOverlaySnapshot(repoId);
    assert.deepStrictEqual(Array.from(snapshot.touchedFileIds), [fileId]);
    assert.strictEqual(snapshot.symbolsById.get(symbolId)?.name, "overlayFn");
    assert.strictEqual(snapshot.filesById.get(fileId)?.relPath, filePath);
    assert.strictEqual(
      snapshot.outgoingEdgesBySymbolId.get(symbolId)?.length,
      1,
    );
  });

  it("captures draft content by snapshot version across interleaved updates", () => {
    seedOverlayEntry();
    const first = getOverlaySnapshot(repoId);

    const nextContent = "export function overlayFn() { return 2; }";
    const store = getDefaultOverlayStore();
    store.upsertDraft({
      repoId,
      eventType: "change",
      filePath,
      content: nextContent,
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-03-18T12:00:02.000Z",
    });
    store.setParseResult(
      repoId,
      filePath,
      2,
      {
        version: 2,
        file: makeFileRow({ contentHash: "file-hash-2" }),
        symbols: [makeSymbolRow({ astFingerprint: "fp-overlay-2" })],
        edges: [makeEdgeRow()],
        references: [],
      },
      "2026-03-18T12:00:03.000Z",
    );
    const second = getOverlaySnapshot(repoId);

    assert.equal(
      first.contentByFileId?.get(fileId),
      "export function overlayFn() { return 1; }",
    );
    assert.equal(second.contentByFileId?.get(fileId), nextContent);
  });

  it("records authoritative empty edges for captured symbols", () => {
    seedOverlayEntry([]);
    const snapshot = getOverlaySnapshot(repoId);
    const staleEdge: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "stale-target",
      edgeType: "call",
      weight: 1,
      confidence: 1,
    };

    assert.deepEqual(snapshot.outgoingEdgesBySymbolId.get(symbolId), []);
    assert.deepEqual(
      mergeEdgeMapWithOverlay(
        snapshot,
        [symbolId],
        new Map([[symbolId, [staleEdge]]]),
      ).get(symbolId),
      [],
    );
  });

  it("omits stale durable edges from hydrated captured overlays", async () => {
    seedOverlayEntry([]);
    const snapshot = getOverlaySnapshot(repoId);
    const staleEdge: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "stale-target",
      edgeType: "call",
      weight: 1,
      confidence: 1,
    };
    const selected = [symbolId, "stale-target"].map((selectedSymbolId, index) => ({
      candidate: {
        symbolId: selectedSymbolId,
        path: `src/${selectedSymbolId}.ts`,
        rank: index + 1,
        tier: 0 as const,
        lanes: ["exactIdentifier" as const],
        estimates: {},
      },
      rungs: ["skeleton" as const],
    }));
    const hydrated = await hydrateContextBundles(
      {
        conn: {} as never,
        repoId,
        versionId: "v1",
        selected,
        identifiers: [],
        overlaySnapshot: snapshot,
      },
      {
        loadCards: async () => ({
          cards: [],
          sliceDepsBySymbol: new Map(),
        }),
        loadEdges: async () => new Map([[symbolId, [staleEdge]]]),
        loadSkeleton: async () => ({
          skeleton: "function captured() {}",
          actualRange: {
            startLine: 1,
            startCol: 0,
            endLine: 1,
            endCol: 22,
          },
          estimatedTokens: 4,
          originalLines: 1,
          truncated: false,
          skeletonLinesConsumed: 1,
        }),
      },
    );

    assert.deepEqual(hydrated.edges, []);
  });

  it("getOverlaySymbol returns symbol, file, and outgoing edges when found", () => {
    seedOverlayEntry();
    const snapshot = getOverlaySnapshot(repoId);

    const result = getOverlaySymbol(snapshot, symbolId);
    assert.ok(result);
    assert.strictEqual(result.symbol.symbolId, symbolId);
    assert.strictEqual(result.file.fileId, fileId);
    assert.strictEqual(result.outgoingEdges.length, 1);
  });

  it("getOverlaySymbol returns null for unknown symbol", () => {
    const snapshot = getOverlaySnapshot(repoId);
    const result = getOverlaySymbol(snapshot, "missing-symbol");
    assert.strictEqual(result, null);
  });

  it("mergeEdgeMapWithOverlay lets overlay edges override durable edges", () => {
    const overlayEdge: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "overlay-target",
      edgeType: "import",
      weight: 0.6,
      confidence: 0.9,
    };
    const durableEdge: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "durable-target",
      edgeType: "call",
      weight: 1,
      confidence: 0.99,
    };

    const snapshot: OverlaySnapshot = {
      repoId,
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([[symbolId, makeSymbolRow()]]),
      filesById: new Map([[fileId, makeFileRow()]]),
      outgoingEdgesBySymbolId: new Map([[symbolId, [overlayEdge]]]),
    };

    const merged = mergeEdgeMapWithOverlay(
      snapshot,
      [symbolId],
      new Map([[symbolId, [durableEdge]]]),
    );

    assert.deepStrictEqual(merged.get(symbolId), [overlayEdge]);
  });

  it("mergeEdgeMapWithOverlay applies minCallConfidence only to call edges", () => {
    const overlayCallLow: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "call-low",
      edgeType: "call",
      weight: 1,
      confidence: 0.4,
    };
    const overlayImport: EdgeForSlice = {
      fromSymbolId: symbolId,
      toSymbolId: "import-keep",
      edgeType: "import",
      weight: 0.6,
      confidence: 0.1,
    };

    const snapshot: OverlaySnapshot = {
      repoId,
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([[symbolId, makeSymbolRow()]]),
      filesById: new Map([[fileId, makeFileRow()]]),
      outgoingEdgesBySymbolId: new Map([
        [symbolId, [overlayCallLow, overlayImport]],
      ]),
    };

    const merged = mergeEdgeMapWithOverlay(
      snapshot,
      [symbolId],
      new Map(),
      0.8,
    );
    assert.deepStrictEqual(merged.get(symbolId), [overlayImport]);
  });

  it("mergeSymbolRowsWithOverlay prefers overlay symbol rows", () => {
    const overlaySymbol = makeSymbolRow({ summary: "overlay summary" });
    const durableSymbol = makeSymbolRow({ summary: "durable summary" });

    const snapshot: OverlaySnapshot = {
      repoId,
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([[symbolId, overlaySymbol]]),
      filesById: new Map([[fileId, makeFileRow()]]),
      outgoingEdgesBySymbolId: new Map(),
    };

    const merged = mergeSymbolRowsWithOverlay(
      snapshot,
      [symbolId],
      new Map([[symbolId, durableSymbol]]),
    );

    assert.strictEqual(merged.get(symbolId)?.summary, "overlay summary");
  });
});
