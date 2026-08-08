import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildSymbolRefSuggestionRecovery,
  getFileMatchLevel,
  resolveSymbolRef,
} from "../../dist/util/resolve-symbol-ref.js";

const candidate = (name: string, score: number) => ({
  symbolId: `id-${name}`,
  name,
  file: `src/${name}.ts`,
  kind: "function",
  exported: true,
  score,
});

class FakeQueryResult {
  private readonly rows: Record<string, unknown>[];

  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    return this.rows;
  }

  close(): void {}
}

function createFallbackOnlyConnection(): {
  conn: import("kuzu").Connection;
  observedQueries: string[];
} {
  const observedQueries: string[] = [];
  const names = [
    "A1BMissingOne",
    "A1BMissingTwo",
    "A1BMissingThree",
    "A1BMissingFour",
    "A1BMissingFive",
  ];
  const symbolRows = names.map((name, index) => ({
    symbolId: `symbol-fallback-${index}`,
    name,
    fileId: "file-fallback",
    file: "src/fallback.ts",
    kind: "function",
    exported: true,
  }));
  const fileRows = [{
    fileId: "file-fallback",
    repoId: "resolver-fake",
    relPath: "src/fallback.ts",
    contentHash: "hash",
    language: "typescript",
    byteSize: 1,
    lastIndexedAt: null,
    directory: "src",
  }];

  const conn = {
    async prepare(statement: string) {
      return {
        statement,
        isSuccess: () => true,
        getErrorMessage: () => "",
      };
    },
    async execute(
      _prepared: { statement: string },
      params: Record<string, unknown> = {},
    ) {
      if (Array.isArray(params.fileIds)) {
        return new FakeQueryResult(fileRows);
      }
      const query = String(params.query ?? "");
      observedQueries.push(query);
      const isFallbackQuery = query.toLowerCase() === "missing";
      return new FakeQueryResult(isFallbackQuery ? symbolRows : []);
    },
  } as unknown as import("kuzu").Connection;
  return { conn, observedQueries };
}

describe("symbol reference suggestion recovery", () => {
  it("uses an inclusive 0.35 suggestion threshold", () => {
    const recovery = buildSymbolRefSuggestionRecovery([
      candidate("Below", 0.34),
      candidate("At", 0.35),
      candidate("Above", 0.36),
    ]);

    assert.deepStrictEqual(
      recovery.candidates.map(({ name, score }) => ({ name, score })),
      [
        { name: "Above", score: 0.36 },
        { name: "At", score: 0.35 },
      ],
    );
    assert.strictEqual(
      recovery.hint,
      ' Did you mean: "Above" (src/Above.ts), "At" (src/At.ts)?',
    );
  });

  it("returns no more than three suggestions in text and structured data", () => {
    const recovery = buildSymbolRefSuggestionRecovery([
      candidate("First", 0.9),
      candidate("Second", 0.8),
      candidate("Third", 0.7),
      candidate("Fourth", 0.6),
    ]);

    assert.deepStrictEqual(
      recovery.candidates.map(({ name }) => name),
      ["First", "Second", "Third"],
    );
    assert.match(recovery.hint, /First.*Second.*Third/);
    assert.doesNotMatch(recovery.hint, /Fourth/);
  });

  it("routes initial-search-empty recovery through the shared policy", async () => {
    const harness = createFallbackOnlyConnection();
    const result = await resolveSymbolRef(harness.conn, "resolver-fake", {
      name: "A1BMissing",
    });

    assert.deepEqual(harness.observedQueries, [
      "a",
      "1",
      "bm",
      "issing",
      "missing",
    ]);
    assert.equal(result.status, "not_found");
    if (result.status !== "not_found") return;

    assert.equal(result.candidates.length, 3);
    assert.ok(result.candidates.every(({ score }) => score >= 0.35));
    const expectedHint = ` Did you mean: ${result.candidates
      .map(({ name, file }) => `"${name}" (${file})`)
      .join(", ")}?`;
    assert.ok(result.message.endsWith(expectedHint));
  });
});

// Regression tests for fuzzy extension-stripping file match.
// Covers the 2026-04-08 fix where "src/graph/slice" (no extension)
// should resolve to "src/graph/slice.ts" at level-2 fuzzy match.
//
// Signature: getFileMatchLevel(requestedFile, candidateFile)
// Returns: 3 exact / 2 suffix-or-ext-strip / 1 basename / 0 none

describe("getFileMatchLevel extension stripping", () => {
  it("returns level 3 for exact match", () => {
    assert.strictEqual(
      getFileMatchLevel("src/graph/slice.ts", "src/graph/slice.ts"),
      3,
    );
  });

  it("returns level 2 when requested file has no extension and candidate adds .ts", () => {
    // requested="src/graph/slice", candidate="src/graph/slice.ts"
    // Extension strip path: candidateNoExt===requested
    assert.strictEqual(
      getFileMatchLevel("src/graph/slice", "src/graph/slice.ts"),
      2,
    );
  });

  it("returns level 2 when no-ext requested is a suffix of candidate", () => {
    // requested="graph/slice", candidate="packages/core/src/graph/slice.ts"
    // candidateNoExt ends with "/graph/slice" → level 2
    assert.strictEqual(
      getFileMatchLevel("graph/slice", "packages/core/src/graph/slice.ts"),
      2,
    );
  });

  it("returns level 2 for direct suffix match (pre-existing behavior)", () => {
    // requested="src/graph/slice.ts", candidate="packages/core/src/graph/slice.ts"
    // candidate endsWith "/src/graph/slice.ts" → level 2 (no extension strip needed)
    assert.strictEqual(
      getFileMatchLevel("src/graph/slice.ts", "packages/core/src/graph/slice.ts"),
      2,
    );
  });

  it("returns level 1 for basename-only match", () => {
    // Different directories, same basename
    assert.strictEqual(
      getFileMatchLevel("other/dir/slice.ts", "src/graph/slice.ts"),
      1,
    );
  });

  it("returns 0 for unrelated paths", () => {
    assert.strictEqual(
      getFileMatchLevel("src/db/queries.ts", "src/graph/slice.ts"),
      0,
    );
  });

  it("returns 0 for undefined requested file", () => {
    assert.strictEqual(
      getFileMatchLevel(undefined, "src/graph/slice.ts"),
      0,
    );
  });

  it("does not match different basenames after extension strip", () => {
    // requested="src/graph/sliced" (no ext), candidate="src/graph/slice.ts"
    // candidateNoExt="src/graph/slice" != requested → level 0
    assert.strictEqual(
      getFileMatchLevel("src/graph/sliced", "src/graph/slice.ts"),
      0,
    );
  });

  it("handles dots in directory components without misclassifying as extension", () => {
    // requested="src.v2/graph/slice" — the ".v2" is in a directory, not the last component.
    // The regex /\.[a-zA-Z0-9]+$/ checks only the END, so requestedHasExt=false.
    // candidateNoExt="src.v2/graph/slice" equals requested → level 2.
    assert.strictEqual(
      getFileMatchLevel("src.v2/graph/slice", "src.v2/graph/slice.ts"),
      2,
    );
  });
});
