import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function symbolRow(
  symbolId: string,
  fileId: string,
  name: string,
) {
  return {
    symbolId,
    repoId: "repo",
    fileId,
    kind: "function",
    name,
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: `${symbolId}-fp`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    roleTagsJson: null,
    searchText: name,
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("Context code evidence snapshot identity", () => {
  it("renders overlay skeleton and hot path from captured draft content", async (t) => {
    const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        ...ladybugQueries,
        getSymbol: async () => null,
      },
    });
    const skeletonModule = await import(
      "../../dist/code/skeleton.js?captured-overlay-source"
    );
    const hotPathModule = await import(
      "../../dist/code/hotpath.js?captured-overlay-source"
    );
    const fileId = "overlay-file";
    const symbolId = "overlay-focus";
    const capturedContent =
      "export function OverlayFocus() {\n  return oldNeedle;\n}";
    const snapshot = {
      repoId: "repo",
      touchedFileIds: new Set([fileId]),
      symbolsById: new Map([
        [symbolId, symbolRow(symbolId, fileId, "OverlayFocus")],
      ]),
      filesById: new Map([
        [
          fileId,
          {
            fileId,
            repoId: "repo",
            relPath: "src/overlay-focus.ts",
            contentHash: "overlay-hash",
            language: "typescript",
            byteSize: capturedContent.length,
            lastIndexedAt: null,
            directory: "src",
          },
        ],
      ]),
      outgoingEdgesBySymbolId: new Map(),
      contentByFileId: new Map([[fileId, capturedContent]]),
    };

    const preparedSkeleton = await skeletonModule.prepareSymbolSkeleton(
      {} as Connection,
      "repo",
      symbolId,
      snapshot,
    );
    const preparedHotPath = await hotPathModule.prepareHotPath(
      {} as Connection,
      "repo",
      symbolId,
      snapshot,
    );
    assert.ok(preparedSkeleton);
    assert.ok(preparedHotPath);

    // A newer live draft exists, but this request must keep its captured bytes.
    const newerSnapshot = {
      ...snapshot,
      contentByFileId: new Map([
        [
          fileId,
          "export function OverlayFocus() {\n  return newNeedle;\n}",
        ],
      ]),
    };
    assert.notStrictEqual(newerSnapshot.contentByFileId, snapshot.contentByFileId);

    const skeleton = await skeletonModule.renderPreparedSymbolSkeleton(
      preparedSkeleton,
    );
    const hotPath = await hotPathModule.renderPreparedHotPath(
      preparedHotPath,
      ["oldNeedle"],
    );
    assert.ok(skeleton);
    assert.ok(hotPath);
    assert.match(hotPath.excerpt, /oldNeedle/);
    assert.doesNotMatch(hotPath.excerpt, /newNeedle/);
  });

  it("centers prepared module evidence on exact qualified literals", async () => {
    const hotPathModule = await import("../../dist/code/hotpath.js");
    const capturedContent = [
      "// module header",
      "export const moduleStart = true;",
      "const first = 1;",
      "const second = 2;",
      "const third = 3;",
      'const infoLiteral = "sdl.info";',
      "const fourth = 4;",
      "const fifth = 5;",
      'const workflowLiteral = "sdl.workflow";',
      "export const moduleEnd = true;",
    ].join("\n");
    const symbol = {
      ...symbolRow("qualified-module", "qualified-file", "qualified-module"),
      kind: "module",
      rangeStartLine: 2,
      rangeEndLine: 10,
    };
    const prepared = {
      symbol,
      filePath: "src/qualified-module.ts",
      relativePath: "src/qualified-module.ts",
      extension: "ts",
      sourceKind: "overlay",
      capturedContentHash: hashContent(capturedContent),
      capturedContent,
    };

    const hotPath = await hotPathModule.renderPreparedHotPath(
      prepared as never,
      ["sdl.info", "sdl.workflow"],
      { contextLines: 0, maxLines: 4, maxTokens: 200 },
    );

    assert.ok(hotPath);
    assert.match(hotPath.excerpt, /sdl\.info/);
    assert.match(hotPath.excerpt, /sdl\.workflow/);
    assert.deepEqual(hotPath.matchedIdentifiers, [
      "sdl.info",
      "sdl.workflow",
    ]);
    assert.deepEqual(hotPath.matchedLineNumbers, [6, 9]);
    assert.equal(hotPath.actualRange.startLine, 6);
    assert.doesNotMatch(hotPath.excerpt, /moduleStart/);
  });

  it("excludes qualified literals outside the selected symbol range", async () => {
    const hotPathModule = await import("../../dist/code/hotpath.js");
    const capturedContent = [
      "// file header",
      'const outsideBefore = "sdl.info";',
      "",
      "export function selectedSymbol() {",
      "  return localValue;",
      "}",
      "",
      'const outsideAfter = "sdl.workflow";',
    ].join("\n");
    const symbol = {
      ...symbolRow("selected-symbol", "selected-file", "selectedSymbol"),
      rangeStartLine: 4,
      rangeEndLine: 6,
    };
    const prepared = {
      symbol,
      filePath: "src/selected-symbol.ts",
      relativePath: "src/selected-symbol.ts",
      extension: "ts",
      sourceKind: "overlay",
      capturedContentHash: hashContent(capturedContent),
      capturedContent,
    };

    const hotPath = await hotPathModule.renderPreparedHotPath(
      prepared as never,
      ["sdl.info", "sdl.workflow"],
      { contextLines: 0, maxLines: 4, maxTokens: 200 },
    );

    assert.ok(hotPath);
    assert.doesNotMatch(hotPath.excerpt, /sdl\./);
    assert.deepEqual(hotPath.matchedIdentifiers, []);
    assert.deepEqual(hotPath.matchedLineNumbers, [4]);
    assert.deepEqual(hotPath.actualRange, {
      startLine: 4,
      startCol: 0,
      endLine: 4,
      endCol: "export function selectedSymbol() {".length,
    });
  });

  it("fails closed when a durable file changes after preparation", async () => {
    const skeletonModule = await import("../../dist/code/skeleton.js");
    const hotPathModule = await import("../../dist/code/hotpath.js");
    const directory = await mkdtemp(join(tmpdir(), "context-source-snapshot-"));
    const filePath = join(directory, "focus.ts");
    const original =
      "export function focus() {\n  return originalNeedle;\n}";
    const changed =
      "export function focus() {\n  return changedNeedle;\n}";
    await writeFile(filePath, original, "utf8");
    const symbol = symbolRow("durable-focus", "durable-file", "focus");
    const prepared = {
      symbol,
      filePath,
      relativePath: "src/focus.ts",
      extension: "ts",
      sourceKind: "durable",
      capturedContentHash: hashContent(original),
    };

    try {
      await writeFile(filePath, changed, "utf8");
      assert.equal(
        await skeletonModule.renderPreparedSymbolSkeleton(
          prepared as never,
        ),
        null,
      );
      assert.equal(
        await hotPathModule.renderPreparedHotPath(
          prepared as never,
          ["changedNeedle"],
        ),
        null,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when durable source already differs from the DB snapshot", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "context-source-db-skew-"));
    const filePath = join(directory, "focus.ts");
    const currentContent =
      "export function focus() {\n  return currentNeedle;\n}";
    const indexedContent =
      "export function focus() {\n  return indexedNeedle;\n}";
    const fileId = "durable-file";
    const symbolId = "durable-focus";
    const symbol = symbolRow(symbolId, fileId, "focus");
    await writeFile(filePath, currentContent, "utf8");

    const ladybugQueries = await import("../../dist/db/ladybug-queries.js");
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        ...ladybugQueries,
        getSymbol: async () => symbol,
        getFilesByIds: async () =>
          new Map([
            [
              fileId,
              {
                fileId,
                repoId: "repo",
                relPath: "focus.ts",
                contentHash: hashContent(indexedContent),
              },
            ],
          ]),
        getRepo: async () => ({
          repoId: "repo",
          rootPath: directory,
        }),
      },
    });
    const skeletonModule = await import(
      "../../dist/code/skeleton.js?durable-db-skew"
    );
    const hotPathModule = await import(
      "../../dist/code/hotpath.js?durable-db-skew"
    );

    try {
      assert.equal(
        await skeletonModule.prepareSymbolSkeleton(
          {} as Connection,
          "repo",
          symbolId,
        ),
        null,
      );
      assert.equal(
        await hotPathModule.prepareHotPath(
          {} as Connection,
          "repo",
          symbolId,
        ),
        null,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
