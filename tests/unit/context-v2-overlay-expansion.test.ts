import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import * as contextEngine from "../../dist/context/engine.js";
import { getTaskProfile } from "../../dist/context/profiles.js";

function overlaySnapshot() {
  const file = {
    fileId: "overlay-file",
    repoId: "repo",
    relPath: "src/overlay-focus.ts",
    contentHash: "overlay-hash",
    language: "typescript",
    byteSize: 80,
    lastIndexedAt: null,
    directory: "src",
  };
  const symbol = {
    symbolId: "overlay-focus",
    repoId: "repo",
    fileId: file.fileId,
    kind: "function",
    name: "OverlayFocus",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: "overlay-fingerprint",
    signatureJson: null,
    summary: "overlay focus",
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: "OverlayFocus overlay focus",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  return {
    repoId: "repo",
    touchedFileIds: new Set([file.fileId]),
    symbolsById: new Map([[symbol.symbolId, symbol]]),
    filesById: new Map([[file.fileId, file]]),
    outgoingEdgesBySymbolId: new Map([
      [
        "durable-root",
        [
          {
            fromSymbolId: "durable-root",
            toSymbolId: symbol.symbolId,
            edgeType: "call",
            weight: 1,
            confidence: 1,
          },
        ],
      ],
    ]),
    contentByFileId: new Map([
      [
        file.fileId,
        "export function OverlayFocus() {\n  return 1;\n}",
      ],
    ]),
  };
}

describe("Context V2 captured overlay expansion", () => {
  it("resolves overlay-only explicit and focus-path symbols from one snapshot", async () => {
    const snapshot = overlaySnapshot();
    const resolveMentions = Reflect.get(
      contextEngine,
      "resolveOverlayMentionSymbolIds",
    );
    const resolvePaths = Reflect.get(
      contextEngine,
      "resolveFocusPathSymbolHits",
    );
    assert.equal(typeof resolveMentions, "function");
    assert.equal(typeof resolvePaths, "function");
    if (
      typeof resolveMentions !== "function" ||
      typeof resolvePaths !== "function"
    ) {
      return;
    }

    assert.deepEqual(
      resolveMentions(snapshot, ["overlay-focus", "OverlayFocus"]),
      ["overlay-focus"],
    );
    const hits = await resolvePaths(
      {} as Connection,
      "repo",
      ["src/overlay-focus.ts"],
      snapshot,
      {
        getFileByRepoPath: async () => null,
        getFilesByPrefix: async () => [],
        getSymbolsByFile: async () => [],
      },
    );
    assert.deepEqual(hits, [
      {
        path: "src/overlay-focus.ts",
        symbolId: "overlay-focus",
      },
    ]);
  });

  it("passes profile beam behavior and the captured overlay to expansion", async () => {
    const expand = Reflect.get(contextEngine, "defaultExpand");
    assert.equal(typeof expand, "function");
    if (typeof expand !== "function") return;

    const snapshot = overlaySnapshot();
    let capturedRequest: unknown;
    let capturedSnapshot: unknown;
    const result = await expand(
      {
        request: {
          repoId: "repo",
          taskType: "review",
          taskText: "review OverlayFocus",
          budget: { maxTokens: 2_000 },
        },
        profile: getTaskProfile("review"),
        candidates: [
          {
            symbolId: "durable-root",
            path: "src/root.ts",
            rank: 1,
            tier: 0,
            lanes: ["exactIdentifier"],
            estimates: { card: 10, skeleton: 20, hotPath: 30 },
          },
        ],
        runtime: {
          conn: {} as Connection,
          overlaySnapshot: snapshot,
        },
      },
      async (
        _conn: unknown,
        _repoId: unknown,
        _startNodes: unknown,
        _budget: unknown,
        request: unknown,
        _edgeWeights: unknown,
        _minConfidence: unknown,
        _signal: unknown,
        _trace: unknown,
        overlay: unknown,
      ) => {
        capturedRequest = request;
        capturedSnapshot = overlay;
        return {
          sliceCards: new Set(["durable-root", "overlay-focus"]),
          frontier: [],
          wasTruncated: false,
          droppedCandidates: 0,
          maxFrontierSize: 1,
        };
      },
    );

    assert.deepEqual(capturedRequest, {
      entrySymbols: ["durable-root"],
      taskText: "review OverlayFocus",
      direction: "out",
      maxDepth: null,
    });
    assert.strictEqual(capturedSnapshot, snapshot);
    assert.equal(result[1]?.symbolId, "overlay-focus");
    assert.equal(result[1]?.path, "src/overlay-focus.ts");
  });
});
