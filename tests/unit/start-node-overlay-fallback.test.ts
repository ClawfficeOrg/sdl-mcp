import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeLegacyTaskTextCandidateIds } from "../../dist/graph/slice/start-node-resolver.js";
import type { OverlaySnapshot } from "../../dist/live-index/overlay-reader.js";

function makeSnapshot(
  touchedFileIds: string[] = [],
  overlaySymbols: Array<{
    symbolId: string;
    fileId: string;
    name: string;
  }> = [],
): OverlaySnapshot {
  return {
    repoId: "repo",
    touchedFileIds: new Set(touchedFileIds),
    symbolsById: new Map(
      overlaySymbols.map(({ symbolId, fileId, name }) => [
        symbolId,
        {
          symbolId,
          repoId: "repo",
          fileId,
          name,
          summary: null,
          searchText: name,
        },
      ]),
    ),
    filesById: new Map(
      overlaySymbols.map(({ fileId }) => [
        fileId,
        {
          fileId,
          repoId: "repo",
          relPath: "src/focus.ts",
        },
      ]),
    ),
    outgoingEdgesBySymbolId: new Map(),
    contentByFileId: new Map(),
  } as unknown as OverlaySnapshot;
}

describe("legacy taskText overlay fallback", () => {
  it("preserves durable lexical result order when no overlay matches", () => {
    const ids = mergeLegacyTaskTextCandidateIds(
      [
        { symbolId: "durable-a", fileId: "file-a" },
        { symbolId: "durable-b", fileId: "file-b" },
      ],
      makeSnapshot(),
      "repo",
      "focus",
      5,
    );

    assert.deepEqual(ids, ["durable-a", "durable-b"]);
  });

  it("adds captured overlay matches and excludes shadowed durable rows", () => {
    const ids = mergeLegacyTaskTextCandidateIds(
      [
        { symbolId: "stale-durable", fileId: "touched-file" },
        { symbolId: "durable-visible", fileId: "durable-file" },
      ],
      makeSnapshot(
        ["touched-file"],
        [
          {
            symbolId: "overlay-only",
            fileId: "touched-file",
            name: "overlayOnlyTaskSeed",
          },
        ],
      ),
      "repo",
      "overlayOnlyTaskSeed",
      5,
    );

    assert.deepEqual(ids, ["overlay-only", "durable-visible"]);
  });
});
