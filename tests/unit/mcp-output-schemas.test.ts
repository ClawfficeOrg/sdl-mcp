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

const EDIT_SNIPPETS = {
  before: "1 | before",
  after: "1 | after",
  beforeStartLine: 1,
  beforeEndLine: 1,
  afterStartLine: 1,
  afterEndLine: 1,
};

const EDIT_FILE_ENTRY = {
  file: "src/example.ts",
  matchCount: 1,
  editMode: "replacePattern",
  snippets: EDIT_SNIPPETS,
  indexedSource: true,
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
      snippets: EDIT_SNIPPETS,
      indexUpdate: {
        applied: true,
        symbolsMatched: 1,
        symbolsAdded: 0,
        symbolsRemoved: 0,
        edgesUpserted: 0,
      },
    });
  });

  it("parses symbol-edit preview and apply results", () => {
    const schema = requireSchema("SymbolEditResponseSchema");
    schema.parse({
      mode: "preview",
      planHandle: "se-symbol",
      symbolId: "sym-1",
      symbolName: "example",
      operation: "replaceBody",
      file: "src/example.ts",
      writeTarget: "file",
      requiresApply: true,
      expiresAt: "2026-07-24T01:00:00.000Z",
      validation: {
        parseBefore: true,
        parseAfter: true,
        targetSymbolResolved: true,
      },
      fileEntries: [EDIT_FILE_ENTRY],
    });
    schema.parse({
      mode: "apply",
      planHandle: "se-symbol",
      symbolId: "sym-1",
      symbolName: "example",
      operation: "replaceBody",
      file: "src/example.ts",
      writeTarget: "draft",
      validation: {
        parseBefore: true,
        parseAfter: true,
        targetSymbolResolved: true,
      },
      filesAttempted: 1,
      filesWritten: 1,
      filesSkipped: 0,
      filesFailed: 0,
      results: [
        {
          file: "src/example.ts",
          status: "written",
          bytes: 24,
          indexUpdate: { applied: true, symbolsMatched: 1 },
        },
      ],
      rollback: { triggered: false, restoredFiles: [] },
      draftUpdate: {
        accepted: true,
        overlayVersion: 2,
        parseScheduled: true,
        warnings: [],
      },
    });
  });

  it("parses search-edit preview, apply, and artifact results", () => {
    const schema = requireSchema("SearchEditResponseSchema");
    const fileEntry = {
      ...EDIT_FILE_ENTRY,
      astMatches: [
        {
          target: { name: "target", nodeType: "identifier", text: "before" },
          captures: [
            { name: "target", nodeType: "identifier", text: "before" },
          ],
        },
      ],
      operationIds: ["rename"],
      operations: [
        { id: "rename", matchCount: 1, editMode: "replacePattern" },
      ],
    };
    schema.parse({
      mode: "preview",
      planHandle: "se-search",
      defaultCreateBackup: true,
      applyArgs: {
        mode: "apply",
        repoId: "repo",
        planHandle: "se-search",
        createBackup: true,
      },
      filesMatched: 1,
      matchesFound: 1,
      filesEligible: 1,
      filesSkipped: [],
      filesSkippedTotal: 0,
      filesSkippedByReason: [],
      fileEntries: [fileEntry],
      requiresApply: true,
      expiresAt: "2026-07-24T01:00:00.000Z",
      partial: false,
      retrievalEvidence: {
        sources: ["fts"],
        topRanksPerSource: { fts: [1] },
        candidateCountPerSource: { fts: 1 },
      },
    });
    schema.parse({
      mode: "apply",
      planHandle: "se-search",
      filesAttempted: 1,
      filesWritten: 1,
      filesSkipped: 0,
      filesFailed: 0,
      results: [{ file: "src/example.ts", status: "written", bytes: 24 }],
      fileEntries: [fileEntry],
      rollback: { triggered: false, restoredFiles: [] },
    });
    schema.parse(responseArtifact("sdl.search.edit"));
  });

  it("parses disabled and enabled semantic enrichment refresh results", () => {
    const schema = requireSchema("SemanticEnrichmentRefreshResponseSchema");
    schema.parse({
      ok: true,
      repoId: "repo",
      enabled: false,
      dryRun: true,
      installPolicy: "never",
      selections: [],
      runs: [],
      scipResults: [],
      skipped: [
        {
          providerType: "semanticEnrichment",
          reason: "semanticEnrichment.enabled is false",
        },
      ],
    });
    schema.parse({
      ok: true,
      repoId: "repo",
      enabled: true,
      dryRun: false,
      installPolicy: "verified",
      selections: [
        {
          languageId: "typescript",
          selected: {
            providerType: "scip",
            providerId: "scip",
            canAffectPass2: true,
          },
          skipped: [
            { providerType: "lsp", reason: "not selected; scip has priority" },
          ],
        },
      ],
      runs: [
        {
          runId: "run-1",
          repoId: "repo",
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          startedAt: "2026-07-24T00:00:00.000Z",
          finishedAt: "2026-07-24T00:00:01.000Z",
          documentsProcessed: 1,
          symbolsMatched: 2,
          edgesCreated: 3,
          edgesUpgraded: 0,
          edgesReplaced: 0,
          edgesSkipped: 0,
          diagnosticsCount: 0,
          precisionScore: 1,
          cacheHit: false,
          canAffectPass2: true,
          selected: true,
        },
      ],
      scipResults: [
        {
          status: "ingested",
          decoderBackend: "rust",
          documentsProcessed: 1,
          documentsSkipped: 0,
          symbolsMatched: 2,
          externalSymbolsCreated: 0,
          edgesCreated: 3,
          edgesUpgraded: 0,
          edgesReplaced: 0,
          unresolvedOccurrences: 0,
          skippedSymbols: 0,
          truncated: false,
          durationMs: 12,
          perFileCoverage: [
            { relPath: "src/example.ts", total: 2, matched: 2, unresolved: 0 },
          ],
        },
      ],
      skipped: [],
    });
  });

  it("parses compact and full semantic enrichment status results", () => {
    const schema = requireSchema("SemanticEnrichmentStatusResponseSchema");
    schema.parse({
      ok: true,
      repoId: "repo",
      enabled: true,
      autoRunOnIndexRefresh: false,
      installPolicy: "never",
      selections: {
        totalLanguages: 1,
        selectedLanguages: 1,
        skippedProviders: 1,
        languagesWithSelection: ["typescript"],
      },
      lastRuns: [
        {
          runId: "run-1",
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          startedAt: "2026-07-24T00:00:00.000Z",
          finishedAt: "2026-07-24T00:00:01.000Z",
          symbolsMatched: 2,
          edgesCreated: 3,
          diagnosticsCount: 1,
          diagnosticsBySeverity: {
            error: 0,
            warning: 1,
            information: 0,
            hint: 0,
          },
          precisionScore: 1,
          precisionMeasurement: "measured",
          precisionBasis: "operational-composite",
        },
      ],
    });
    schema.parse({
      ok: true,
      repoId: "repo",
      enabled: true,
      autoRunOnIndexRefresh: false,
      installPolicy: "never",
      selections: [
        {
          languageId: "typescript",
          selected: {
            providerType: "scip",
            providerId: "scip",
            canAffectPass2: true,
          },
          skipped: [],
        },
      ],
      lastRuns: [
        {
          runId: "run-1",
          repoId: "repo",
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          startedAt: "2026-07-24T00:00:00.000Z",
          documentsProcessed: 1,
          symbolsMatched: 2,
          edgesCreated: 3,
          edgesUpgraded: 0,
          edgesReplaced: 0,
          edgesSkipped: 0,
          diagnosticsCount: 1,
          precisionMeasurement: "unavailable",
        },
      ],
    });
  });
});
