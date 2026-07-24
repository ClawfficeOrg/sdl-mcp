import { describe, it } from "node:test";
import assert from "node:assert";

import * as toolSchemas from "../../dist/mcp/tools.js";

interface RuntimeSchema {
  parse(value: unknown): unknown;
}

const EMPTY_KIND_COUNTS = {
  function: 0,
  class: 0,
  interface: 0,
  type: 0,
  method: 0,
  variable: 0,
  module: 0,
  constructor: 0,
};

function requireSchema(name: string): RuntimeSchema {
  const schema = (toolSchemas as Record<string, unknown>)[name] as
    | RuntimeSchema
    | undefined;
  assert.ok(schema, `expected ${name} to be exported`);
  return schema;
}

function responseArtifact(toolName: string) {
  return {
    responseMode: "handle",
    kind: "responseArtifact",
    handle: `response-${toolName}`,
    action: "response.get",
    metadata: {
      handle: `response-${toolName}`,
      repoId: "repo",
      toolName,
      originalBytes: 4096,
      etag: `${toolName}-etag`,
      contentKind: "json",
    },
  };
}

describe("MCP output schemas", () => {
  it("parses full and not-modified repository overviews", () => {
    const schema = requireSchema("RepoOverviewResponseSchema");
    schema.parse({
      repoId: "repo",
      versionId: "v1",
      generatedAt: "2026-07-24T00:00:00.000Z",
      stats: {
        fileCount: 0,
        symbolCount: 0,
        edgeCount: 0,
        exportedSymbolCount: 0,
        byKind: EMPTY_KIND_COUNTS,
        byEdgeType: { call: 0, import: 0, config: 0 },
        avgSymbolsPerFile: 0,
        avgEdgesPerSymbol: 0,
      },
      directories: [],
      tokenMetrics: {
        fullCardsEstimate: 0,
        overviewTokens: 10,
        compressionRatio: 0,
      },
      etag: "overview-etag",
    });
    schema.parse({ notModified: true, etag: "overview-etag" });
  });

  it("parses approved, denied, and artifact code-window results", () => {
    const schema = requireSchema("CodeNeedWindowResponseSchema");
    schema.parse({
      approved: true,
      status: "approvedRaw",
      contentKind: "raw",
      symbolId: "sym-1",
      file: "src/example.ts",
      range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
      code: "export function example() {}",
      whyApproved: ["Policy approved"],
      estimatedTokens: 8,
    });
    schema.parse({
      approved: false,
      status: "denied",
      whyDenied: ["Identifiers are required"],
    });
    schema.parse(responseArtifact("sdl.code.needWindow"));
  });

  it("parses inline and artifact file-read results", () => {
    const schema = requireSchema("FileReadResponseSchema");
    schema.parse({
      filePath: "README.md",
      content: "# SDL-MCP",
      bytes: 9,
      totalLines: 1,
      returnedLines: 1,
      truncated: false,
      hint: "Use targeting for large reads.",
    });
    schema.parse(responseArtifact("sdl.file.read"));
  });

  it("parses file-write results", () => {
    requireSchema("FileWriteResponseSchema").parse({
      filePath: "notes.txt",
      bytesWritten: 7,
      linesWritten: 1,
      mode: "replacePattern",
      backupPath: "notes.txt.bak",
      replacementCount: 1,
      snippets: {
        before: "1 | before",
        after: "1 | after",
        beforeStartLine: 1,
        beforeEndLine: 1,
        afterStartLine: 1,
        afterEndLine: 1,
      },
      indexUpdate: {
        applied: true,
        symbolsMatched: 1,
        symbolsAdded: 0,
        symbolsRemoved: 0,
        edgesUpserted: 0,
      },
    });
  });
});
