import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";

import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getEmbeddingProvider,
  refreshSymbolEmbeddings,
  type EmbeddingProvider,
} from "../../dist/indexer/embeddings.js";
import { refreshFileSummaryEmbeddings } from "../../dist/indexer/file-summary-embeddings.js";
import { AppConfigSchema } from "../../dist/config/types.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  prepareReopenedJinaHnsw,
  resolveConfiguredJinaHnswSpec,
  validateReopenedJinaHnsw,
} from "../../dist/indexer/jina-hnsw-finalization.js";
import {
  readDeterministicSymbolVectorProbe,
  readRepoSymbolVectorProbe,
  readSymbolNumericVector,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import {
  AGENTFEEDBACK_VECTOR_INDEX_NAMES,
  FILESUMMARY_VECTOR_INDEX_NAMES,
  createVectorIndex,
  dropVectorIndex,
  queryVectorIndexProbe,
  showIndexesStrict,
} from "../../dist/retrieval/index-lifecycle.js";
import {
  getLoggerDiagnostics,
  setConsoleMirroring,
} from "../../dist/util/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Semantic Embedding Pipeline", () => {
  const testDir = join(__dirname, "test-semantic-embedding");
  const graphDbPath = join(testDir, "graph");
  const repoId = "embed-test-repo";
  const jinaModel = "jina-embeddings-v2-base-code";

  const symbols: ladybugDb.SymbolRow[] = [
    {
      symbolId: "sym-auth",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "authenticateUser",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 10,
      rangeEndCol: 1,
      astFingerprint: "fp-auth",
      signatureJson: JSON.stringify(
        "(username: string, password: string) => Promise<User>",
      ),
      summary: "Authenticate a user with username and password credentials",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
    {
      symbolId: "sym-fetch",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "fetchUserData",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 15,
      rangeStartCol: 0,
      rangeEndLine: 25,
      rangeEndCol: 1,
      astFingerprint: "fp-fetch",
      signatureJson: JSON.stringify("(userId: string) => Promise<UserData>"),
      summary: "Fetch user profile data from the database",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
    {
      symbolId: "sym-render",
      repoId,
      fileId: "file2",
      kind: "function",
      name: "renderDashboard",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 20,
      rangeEndCol: 1,
      astFingerprint: "fp-render",
      signatureJson: JSON.stringify("(data: DashboardData) => JSX.Element"),
      summary: "Render the main dashboard UI component",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "/fake/embed-repo",
      configJson: JSON.stringify({
        repoId,
        rootPath: "/fake/embed-repo",
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file1",
      repoId,
      relPath: "src/auth.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 500,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file2",
      repoId,
      relPath: "src/dashboard.ts",
      contentHash: "hash2",
      language: "ts",
      byteSize: 800,
      lastIndexedAt: now,
    });

    for (const sym of symbols) {
      await ladybugDb.upsertSymbol(conn, sym);
    }
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createRecordingProvider(): {
    provider: EmbeddingProvider;
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      calls,
      provider: {
        async embed(texts: string[]): Promise<number[][]> {
          calls.push([...texts]);
          return texts.map((text, index) =>
            makeDeterministicVector(text, calls.length, index),
          );
        },
        getDimension(): number {
          return 768;
        },
        isMockFallback(): boolean {
          return false;
        },
      },
    };
  }

  function makeDeterministicVector(
    text: string,
    callNumber: number,
    index: number,
  ): number[] {
    const vector = new Array<number>(768).fill(0);
    vector[0] = ((text.length % 97) + 1) / 100;
    vector[1] = callNumber / 100;
    vector[2] = (index + 1) / 100;
    return vector;
  }

  async function upsertStandardFileSummaries(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    updatedAt = "2026-05-05T00:00:00Z",
  ): Promise<void> {
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt,
      },
      {
        fileId: "file2",
        repoId,
        summary:
          "File: src/dashboard.ts\nLanguage: ts\nExports: renderDashboard",
        searchText: "file: src/dashboard.ts exports: renderDashboard",
        updatedAt,
      },
    ]);
  }

  interface FileSummaryEmbeddingState {
    fileId: string;
    summary: string | null;
    searchText: string | null;
    summaryUpdatedAt: string | null;
    vector: string | null;
    cardHash: string | null;
    embeddingUpdatedAt: string | null;
    vectorArray: unknown;
  }

  async function readFileSummaryEmbeddingRows(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    fileIds: string[],
  ): Promise<Map<string, FileSummaryEmbeddingState>> {
    const rows = await ladybugDb.queryAll<FileSummaryEmbeddingState>(
      conn,
      `MATCH (fs:FileSummary)
       WHERE fs.fileId IN $fileIds
       RETURN fs.fileId AS fileId,
              fs.summary AS summary,
              fs.searchText AS searchText,
              fs.updatedAt AS summaryUpdatedAt,
              fs.embeddingJinaCode AS vector,
              fs.embeddingJinaCodeCardHash AS cardHash,
              fs.embeddingJinaCodeUpdatedAt AS embeddingUpdatedAt,
              fs.embeddingJinaCodeVec AS vectorArray`,
      { fileIds },
    );
    return new Map(rows.map((row) => [row.fileId, row]));
  }

  function assertStoredVectorArray(value: unknown, fileId: string): void {
    assert.ok(Array.isArray(value), `${fileId} should store a vector array`);
    assert.strictEqual(value.length, 768);
    assert.ok(
      value.some((entry) => typeof entry === "number" && entry !== 0),
      `${fileId} vector array should contain provider values`,
    );
  }

  it("mock provider generates embeddings with expected dimension", async () => {
    const provider = getEmbeddingProvider("mock");
    const embeddings = await provider.embed([
      "authenticate user login",
      "render dashboard view",
    ]);
    assert.strictEqual(embeddings.length, 2);
    assert.strictEqual(embeddings[0].length, 64);
    assert.strictEqual(embeddings[1].length, 64);
  });

  it("refreshSymbolEmbeddings skips persistence for mock-fallback embeddings", async () => {
    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      symbols,
    });

    assert.strictEqual(result.embedded, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.degraded, true);

    // Mock fallback vectors are intentionally not persisted to Symbol node
    // properties because they do not map to a supported embedding model.
    const conn = await getLadybugConn();
    for (const sym of symbols) {
      const embedding = await ladybugDb.getSymbolEmbedding(conn, sym.symbolId);
      assert.strictEqual(
        embedding,
        null,
        `Mock fallback embedding should not persist for ${sym.symbolId}`,
      );
    }
  });

  it("refreshSymbolEmbeddings continues to skip mock-fallback vectors across runs", async () => {
    // First run: mock fallback vectors are not persisted.
    const first = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      symbols,
    });
    assert.strictEqual(first.embedded, 0);
    assert.strictEqual(first.skipped, 0);
    assert.strictEqual(first.degraded, true);

    // Second run with the same inputs should behave identically.
    const second = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      symbols,
    });
    assert.strictEqual(second.embedded, 0);
    assert.strictEqual(second.skipped, 0);
    assert.strictEqual(second.degraded, true);
  });

  it("does not report mock-degraded symbol batches as completed progress", async () => {
    let mockFallback = false;
    const progress: Array<{ current: number; total: number }> = [];
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts): Promise<number[][]> {
        mockFallback = true;
        return texts.map(() => new Array<number>(64).fill(0));
      },
      getDimension(): number {
        return 768;
      },
      isMockFallback(): boolean {
        return mockFallback;
      },
    };

    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: "jina-embeddings-v2-base-code",
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider,
      onProgress: ({ current, total }) => progress.push({ current, total }),
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      degraded: true,
    });
    assert.ok(progress.length > 0);
    assert.ok(progress.every(({ current, total }) => current < total));
  });

  it("refreshSymbolEmbeddings persists vectors through a real rebuild cycle", async () => {
    const { provider: recordingProvider } = createRecordingProvider();
    let embeddingCallsStarted = 0;
    let releaseConcurrentCalls!: () => void;
    const concurrentCallsStarted = new Promise<void>((resolve) => {
      releaseConcurrentCalls = resolve;
    });
    const provider: EmbeddingProvider = {
      ...recordingProvider,
      async embed(texts): Promise<number[][]> {
        if (++embeddingCallsStarted === 2) releaseConcurrentCalls();
        await concurrentCallsStarted;
        return recordingProvider.embed(texts);
      },
    };
    const timings = new Map<string, number>();
    const timingCalls: string[] = [];
    const progressSubstages: Array<string | undefined> = [];
    const memorySnapshots: Array<{
      phase: string;
      snapshot: Record<string, number>;
    }> = [];

    const refreshParams = {
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: provider,
      jinaHnswSpec: {
        model: jinaModel,
        indexName: "configured_jina_hnsw",
        vectorProperty: "embeddingJinaCodeVec",
        dimension: 768,
        efc: 321,
      },
      batchSize: 1,
      concurrency: 2,
      onProgress: ({ substage }) => progressSubstages.push(substage),
      recordTiming: (phaseName, durationMs) => {
        timingCalls.push(phaseName);
        timings.set(phaseName, (timings.get(phaseName) ?? 0) + durationMs);
      },
      recordMemorySnapshot: (
        phase: string,
        snapshot: Record<string, number>,
      ) => memorySnapshots.push({ phase, snapshot }),
    } as Parameters<typeof refreshSymbolEmbeddings>[0] & {
      recordMemorySnapshot: (
        phase: string,
        snapshot: Record<string, number>,
      ) => void;
    };
    const previousConsoleMirroring = getLoggerDiagnostics().consoleMirroring;
    const originalStderrWrite = process.stderr.write;
    const createLogs: string[] = [];
    process.stderr.write = ((data: string | Uint8Array) => {
      createLogs.push(String(data));
      return true;
    }) as typeof process.stderr.write;
    setConsoleMirroring(true);
    let result: Awaited<ReturnType<typeof refreshSymbolEmbeddings>>;
    try {
      result = await refreshSymbolEmbeddings(refreshParams);
    } finally {
      setConsoleMirroring(previousConsoleMirroring);
      process.stderr.write = originalStderrWrite;
    }

    assert.deepStrictEqual(result, {
      embedded: symbols.length,
      skipped: 0,
    });
    assert.ok(
      progressSubstages.includes("symbolVectorIndex"),
      "the rebuild must expose HNSW construction after embedding progress",
    );
    assert.match(
      createLogs.join(""),
      /Vector index 'configured_jina_hnsw' created[\s\S]*efc=321/,
      "the configured efc must reach the real createVectorIndex boundary",
    );

    const conn = await getLadybugConn();
    for (const symbol of symbols) {
      const embedding = await ladybugDb.getSymbolEmbeddingFromNode(
        conn,
        symbol.symbolId,
        jinaModel,
      );
      assert.ok(embedding, `${symbol.symbolId} should persist an embedding`);
      assert.ok(embedding.vector.length > 0);
      assert.ok(embedding.cardHash.length > 0);
    }

    for (const phaseName of [
      "inference",
      "persistence.finalFlush",
      "hnsw.drop",
      "hnsw.create",
      "checkpoint.pre",
      "checkpoint.post",
    ]) {
      assert.equal(
        typeof timings.get(phaseName),
        "number",
        `expected ${phaseName} timing`,
      );
    }
    assert.equal(
      timingCalls.filter((phaseName) => phaseName === "inference").length,
      Math.ceil(symbols.length / 2),
      "overlapping inference batches should emit one wall-time interval per concurrency window",
    );
    assert.deepEqual(
      memorySnapshots.map(({ phase }) => phase),
      ["beforeInference", "afterInference", "beforeHnsw", "afterHnsw"],
    );
    for (const { snapshot } of memorySnapshots) {
      for (const field of [
        "rssBytes",
        "heapUsedBytes",
        "externalBytes",
        "arrayBuffersBytes",
        "systemFreeBytes",
        "systemTotalBytes",
      ]) {
        assert.equal(typeof snapshot[field], "number", `expected ${field}`);
        assert.ok(snapshot[field] >= 0, `expected non-negative ${field}`);
      }
    }
  });

  it("persists Jina vectors without creating HNSW when creation is deferred", async () => {
    const { provider } = createRecordingProvider();
    const timings: string[] = [];
    const progressMessages: Array<string | undefined> = [];

    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: provider,
      jinaHnswSpec: {
        model: jinaModel,
        indexName: "symbol_vec_jina_code_v2",
        vectorProperty: "embeddingJinaCodeVec",
        dimension: 768,
        efc: 200,
      },
      deferVectorIndexCreate: true,
      recordTiming: (phaseName) => timings.push(phaseName),
      onProgress: ({ message }) => progressMessages.push(message),
    });

    assert.deepStrictEqual(result, { embedded: symbols.length, skipped: 0 });
    const conn = await getLadybugConn();
    assert.equal(
      (await showIndexesStrict(conn)).some(
        (index) => index.name === "symbol_vec_jina_code_v2",
      ),
      false,
    );
    assert.equal(timings.includes("hnsw.create"), false);
    assert.equal(progressMessages.includes("ready"), false);
    assert.equal(
      progressMessages.includes("deferred until cold reopen"),
      true,
    );
    for (const symbol of symbols) {
      assert.ok(
        await ladybugDb.getSymbolEmbeddingFromNode(
          conn,
          symbol.symbolId,
          jinaModel,
        ),
      );
    }
  });

  it("finalizes configured Jina HNSW through real normal-family cold reopens", async () => {
    const { provider } = createRecordingProvider();
    const nomicModel = "nomic-embed-text-v1.5";
    const config = AppConfigSchema.parse({
      repos: [{ repoId, rootPath: "/fake/embed-repo" }],
      graphDatabase: { path: graphDbPath },
      policy: {},
      semantic: {
        enabled: true,
        provider: "local",
        model: jinaModel,
        retrieval: {
          vector: {
            enabled: true,
            efc: 321,
            indexes: {
              [jinaModel]: { indexName: "configured_jina_hnsw" },
              [nomicModel]: { indexName: "configured_nomic_hnsw" },
            },
          },
        },
      },
      scip: { enabled: false },
    });
    const spec = resolveConfiguredJinaHnswSpec(config);
    assert.ok(spec);
    const configPath = join(testDir, "sdlmcp.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    let conn = await getLadybugConn();
    const vector = makeDeterministicVector("non-jina bootstrap", 1, 0);
    await upsertStandardFileSummaries(conn);
    await ladybugDb.upsertAgentFeedback(conn, {
      feedbackId: "feedback-bootstrap",
      repoId,
      versionId: "version-bootstrap",
      sliceHandle: "slice-bootstrap",
      usefulSymbolsJson: "[]",
      missingSymbolsJson: "[]",
      taskTagsJson: null,
      taskType: "review",
      taskText: "verify exact vector index deferral",
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    await ladybugDb.setSymbolEmbeddingOnNode(
      conn,
      symbols[0]!.symbolId,
      nomicModel,
      JSON.stringify(vector),
      "nomic-card",
      vector,
    );
    await ladybugDb.exec(
      conn,
      `MATCH (f:FileSummary {fileId: $fileId})
       SET f.embeddingJinaCodeVec = $vector,
           f.embeddingNomicVec = $vector`,
      { fileId: "file1", vector },
    );
    await ladybugDb.exec(
      conn,
      `MATCH (f:AgentFeedback {feedbackId: $feedbackId})
       SET f.embeddingJinaCodeVec = $vector,
           f.embeddingNomicVec = $vector`,
      { feedbackId: "feedback-bootstrap", vector },
    );

    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: provider,
      jinaHnswSpec: spec,
      deferVectorIndexCreate: true,
    });

    const previousGraphEnv = new Map(
      [
        "SDL_CONFIG",
        "SDL_CONFIG_PATH",
        "SDL_GRAPH_DB_PATH",
        "SDL_GRAPH_DB_DIR",
        "SDL_DB_PATH",
      ].map(
        (name) => [name, process.env[name]] as const,
      ),
    );
    for (const name of previousGraphEnv.keys()) delete process.env[name];
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    try {
      const graphInit = await import("../../dist/db/initGraphDb.js");
      await closeLadybugDb({ strict: true });
      await graphInit.initGraphDb(config, configPath);
      conn = await getLadybugConn();
      const expectedVectorIndexes = [
        { table: "Symbol", name: spec.indexName },
        { table: "Symbol", name: "configured_nomic_hnsw" },
        {
          table: "FileSummary",
          name: FILESUMMARY_VECTOR_INDEX_NAMES.jinaCode,
        },
        { table: "FileSummary", name: FILESUMMARY_VECTOR_INDEX_NAMES.nomic },
        {
          table: "AgentFeedback",
          name: AGENTFEEDBACK_VECTOR_INDEX_NAMES.jinaCode,
        },
        {
          table: "AgentFeedback",
          name: AGENTFEEDBACK_VECTOR_INDEX_NAMES.nomic,
        },
      ] as const;
      const defaultIndexes = await showIndexesStrict(conn);
      for (const expected of expectedVectorIndexes) {
        const actual = defaultIndexes.find(
          (index) =>
            index.name === expected.name && index.tableName === expected.table,
        );
        assert.equal(actual?.type, "vector");
        assert.equal(actual?.status, "healthy");
        assert.equal(actual?.extensionLoaded, true);
        assert.deepStrictEqual(
          await dropVectorIndex(conn, expected.table, expected.name),
          { status: "dropped" },
        );
      }

      const indexModule = await import("../../dist/cli/commands/index.js");
      const lifecycle = (
        indexModule as typeof indexModule & {
          runDirectJinaHnswLifecycle?: (
            params: {
              config: typeof config;
              configPath: string;
              spec: typeof spec;
              selectedFullRepoIds: readonly string[];
              requireAbsent: boolean;
            },
            dependencies?: {
              prepareReopenedJinaHnsw: typeof prepareReopenedJinaHnsw;
            },
          ) => Promise<{
            outcome: string;
            probe: Awaited<
              ReturnType<typeof readDeterministicSymbolVectorProbe>
            >;
            queryMs: number;
          }>;
        }
      ).runDirectJinaHnswLifecycle;
      assert.strictEqual(typeof lifecycle, "function");
      let observedSuppressedReopen = false;

      const result = await lifecycle!(
        {
          config,
          configPath,
          spec,
          selectedFullRepoIds: [repoId],
          requireAbsent: true,
        },
        {
          prepareReopenedJinaHnsw: async (params) => {
            conn = await getLadybugConn();
            const configuredIndexPresent = (
              await showIndexesStrict(conn)
            ).some((index) => index.name === spec.indexName);
            if (configuredIndexPresent) {
              // Exercise the real finalizer diagnostic if absence is violated.
              return prepareReopenedJinaHnsw(params);
            }
            assert.equal(
              configuredIndexPresent,
              false,
              "finalizer-owned cold reopen must suppress semantic vector bootstrap",
            );
            const reopenedIndexes = await showIndexesStrict(conn);
            for (const expected of expectedVectorIndexes.slice(1)) {
              const actual = reopenedIndexes.find(
                (index) =>
                  index.name === expected.name &&
                  index.tableName === expected.table,
              );
              assert.equal(
                actual?.type,
                "vector",
                `${expected.name} must still be ensured during Jina deferral`,
              );
              assert.equal(actual?.status, "healthy");
              assert.equal(actual?.extensionLoaded, true);
            }
            observedSuppressedReopen = true;
            return prepareReopenedJinaHnsw(params);
          },
        },
      );

      assert.strictEqual(result.outcome, "created");
      assert.ok(result.probe);
      assert.ok(result.queryMs >= 0);
      assert.equal(observedSuppressedReopen, true);

      const ladybug = await import("../../dist/db/ladybug.js");
      assert.strictEqual(ladybug.getLadybugDbPath(), null);
      await graphInit.initGraphDb(config, configPath);
      assert.ok(
        (await validateReopenedJinaHnsw({
          spec,
          probe: result.probe,
        })) >= 0,
      );
    } finally {
      await closeLadybugDb({ strict: true });
      for (const [name, value] of previousGraphEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      invalidateConfigCache();
    }
  });

  it("reports the configured index may be absent before inference failure", async () => {
    const { provider } = createRecordingProvider();
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: provider,
    });
    const events: string[] = [];
    const changedSymbols = symbols.map((symbol) => ({
      ...symbol,
      astFingerprint: `${symbol.astFingerprint}-changed`,
    }));

    await assert.rejects(
      refreshSymbolEmbeddings({
        repoId,
        provider: "local",
        model: jinaModel,
        symbols: changedSymbols,
        rebuildMinUncachedRows: 1,
        embeddingProvider: {
          ...provider,
          async embed(): Promise<number[][]> {
            events.push("inference");
            throw new Error("injected inference failure");
          },
        },
        jinaHnswSpec: {
          model: jinaModel,
          indexName: "configured_jina_hnsw",
          vectorProperty: "embeddingJinaCodeVec",
          dimension: 768,
          efc: 321,
        },
        deferVectorIndexCreate: true,
        onVectorIndexMayBeAbsent: () => events.push("may-be-absent"),
      }),
      /Embedding failure rate exceeds 50%/,
    );

    assert.deepEqual(events, ["may-be-absent", "inference"]);
    const conn = await getLadybugConn();
    assert.equal(
      (await showIndexesStrict(conn)).some(
        (index) => index.name === "symbol_vec_jina_code_v2",
      ),
      true,
      "the configured absent index must not fall back to dropping the mapping default",
    );
  });

  it("keeps indexed writes and skips the callback when configured drop fails", async () => {
    const { provider } = createRecordingProvider();
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: provider,
    });
    const events: string[] = [];
    const changedSymbols = symbols.map((symbol) => ({
      ...symbol,
      astFingerprint: `${symbol.astFingerprint}-changed`,
    }));

    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols: changedSymbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: provider,
      jinaHnswSpec: {
        model: jinaModel,
        indexName: "invalid-index-name",
        vectorProperty: "embeddingJinaCodeVec",
        dimension: 768,
        efc: 321,
      },
      deferVectorIndexCreate: true,
      onVectorIndexMayBeAbsent: () => events.push("may-be-absent"),
    });

    assert.deepEqual(result, { embedded: symbols.length, skipped: 0 });
    assert.deepEqual(events, []);
    const conn = await getLadybugConn();
    assert.equal(
      (await showIndexesStrict(conn)).some(
        (index) => index.name === "symbol_vec_jina_code_v2",
      ),
      true,
    );
  });

  it("refuses a configured Symbol vector index name owned by another property before DROP", async () => {
    const { provider: nomicProvider } = createRecordingProvider();
    const nomicModel = "nomic-embed-text-v1.5";
    const collidingIndexName = "configured_jina_hnsw";
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: nomicModel,
      symbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: nomicProvider,
    });

    const conn = await getLadybugConn();
    assert.deepStrictEqual(
      await dropVectorIndex(conn, "Symbol", "symbol_vec_nomic_embed_v15"),
      { status: "dropped" },
    );
    assert.equal(
      await createVectorIndex(
        conn,
        "Symbol",
        "embeddingNomicVec",
        collidingIndexName,
        768,
        200,
      ),
      true,
    );

    const events: string[] = [];
    const { provider: jinaProvider } = createRecordingProvider();
    await assert.rejects(
      refreshSymbolEmbeddings({
        repoId,
        provider: "local",
        model: jinaModel,
        symbols,
        rebuildMinUncachedRows: 1,
        embeddingProvider: {
          ...jinaProvider,
          async embed(texts): Promise<number[][]> {
            events.push("inference");
            return jinaProvider.embed(texts);
          },
        },
        jinaHnswSpec: {
          model: jinaModel,
          indexName: collidingIndexName,
          vectorProperty: "embeddingJinaCodeVec",
          dimension: 768,
          efc: 321,
        },
        deferVectorIndexCreate: true,
        onVectorIndexMayBeAbsent: () => events.push("may-be-absent"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, "IndexError");
        assert.match(
          error.message,
          /configured_jina_hnsw.*Symbol\.embeddingNomicVec.*Symbol\.embeddingJinaCodeVec/,
        );
        return true;
      },
    );

    assert.deepStrictEqual(events, []);
    const preservedIndexes = (await showIndexesStrict(conn)).filter(
      (index) => index.name === collidingIndexName,
    );
    assert.strictEqual(preservedIndexes.length, 1);
    assert.strictEqual(preservedIndexes[0]?.type, "vector");
    assert.strictEqual(preservedIndexes[0]?.tableName, "Symbol");
    assert.strictEqual(preservedIndexes[0]?.property, "embeddingNomicVec");
    for (const symbol of symbols) {
      assert.strictEqual(
        await ladybugDb.getSymbolEmbeddingFromNode(
          conn,
          symbol.symbolId,
          jinaModel,
        ),
        null,
        `${symbol.symbolId} must not receive a fallback Jina write`,
      );
    }
  });

  it("selects deterministic model-aware Symbol vector probes", async () => {
    const conn = await getLadybugConn();
    const noVector = await readRepoSymbolVectorProbe(conn, repoId, jinaModel);
    assert.equal(noVector.symbolCount, symbols.length);
    assert.equal(noVector.probe, null);

    const emptyRepoId = "empty-probe-repo";
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: emptyRepoId,
      rootPath: "/fake/empty-probe-repo",
      configJson: "{}",
      createdAt: now,
    });
    assert.deepEqual(
      await readRepoSymbolVectorProbe(conn, emptyRepoId, jinaModel),
      {
        symbolCount: 0,
        probe: null,
      },
    );

    const earlyRepoId = "aaa-probe-repo";
    await ladybugDb.upsertRepo(conn, {
      repoId: earlyRepoId,
      rootPath: "/fake/aaa-probe-repo",
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "probe-file",
      repoId: earlyRepoId,
      relPath: "src/probe.ts",
      contentHash: "probe-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: now,
    });
    const probeSymbols = Array.from(
      { length: 34 },
      (_, index): ladybugDb.SymbolRow => ({
        ...symbols[0],
        symbolId:
          index === 33
            ? "aab-valid"
            : `aaa-invalid-${String(index).padStart(2, "0")}`,
        repoId: earlyRepoId,
        fileId: "probe-file",
        name: `probe${index}`,
        astFingerprint: `probe-fp-${index}`,
      }),
    );
    await ladybugDb.upsertSymbolBatch(conn, probeSymbols);

    const validVector = new Array<number>(768).fill(0);
    validVector[0] = 1.25;
    const invalidVector = [...validVector];
    invalidVector[1] = Number.NaN;
    await ladybugDb.setSymbolEmbeddingBatchOnNode(
      conn,
      jinaModel,
      probeSymbols.map((symbol) => ({
        symbolId: symbol.symbolId,
        vector:
          symbol.symbolId === "aab-valid" ? JSON.stringify(validVector) : "[]",
        cardHash:
          symbol.symbolId === "aab-valid" ? "valid-card" : "invalid-card",
        vectorArray:
          symbol.symbolId === "aab-valid" ? validVector : invalidVector,
      })),
    );
    await ladybugDb.setSymbolEmbeddingOnNode(
      conn,
      "sym-auth",
      jinaModel,
      JSON.stringify(validVector),
      "later-card",
      validVector,
    );

    assert.deepEqual(
      await readDeterministicSymbolVectorProbe(conn, jinaModel),
      { repoId: earlyRepoId, symbolId: "aab-valid", vector: validVector },
    );
    assert.deepEqual(
      await readRepoSymbolVectorProbe(conn, earlyRepoId, jinaModel),
      {
        symbolCount: 34,
        probe: {
          repoId: earlyRepoId,
          symbolId: "aab-valid",
          vector: validVector,
        },
      },
    );
    assert.deepEqual(
      await readSymbolNumericVector(conn, "aab-valid", jinaModel),
      validVector,
    );
  });

  it("validates any matching logical Symbol among more than ten tied HNSW rows", async () => {
    const tiedVector = new Array<number>(768).fill(0);
    tiedVector[0] = 1;
    const tiedSymbols = Array.from(
      { length: 12 },
      (_, index): ladybugDb.SymbolRow => ({
        ...symbols[0],
        symbolId: `tie-${String(index).padStart(2, "0")}`,
        name: `tie${index}`,
        astFingerprint: `tie-fp-${index}`,
      }),
    );
    const conn = await getLadybugConn();
    for (const symbol of tiedSymbols)
      await ladybugDb.upsertSymbol(conn, symbol);
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols: tiedSymbols,
      rebuildMinUncachedRows: 1,
      embeddingProvider: {
        async embed(texts: string[]): Promise<number[][]> {
          return texts.map(() => [...tiedVector]);
        },
        getDimension: () => 768,
        isMockFallback: () => false,
      },
    });

    const probe = await readDeterministicSymbolVectorProbe(conn, jinaModel);
    assert.ok(probe);
    const rows = await queryVectorIndexProbe(
      conn,
      "symbol_vec_jina_code_v2",
      probe.vector,
    );
    assert.ok(rows.length > 0 && rows.length <= 10);
    assert.ok(
      rows.every(
        (row) =>
          row.symbolId.length > 0 &&
          typeof row.distance === "number" &&
          Number.isFinite(row.distance),
      ),
    );
    const config = AppConfigSchema.parse({
      repos: [],
      policy: {},
      semantic: {
        enabled: true,
        provider: "local",
        model: jinaModel,
        retrieval: { vector: { enabled: true } },
      },
    });
    const spec = resolveConfiguredJinaHnswSpec(config);
    assert.ok(spec);
    assert.ok((await validateReopenedJinaHnsw({ spec, probe })) >= 0);

    const unrelated = new Array<number>(768).fill(0);
    unrelated[767] = 1;
    await assert.rejects(
      queryVectorIndexProbe(conn, "symbol_vec_jina_code_v2", unrelated),
      /near-zero/i,
    );
  });

  it("refreshFileSummaryEmbeddings marks mock fallback as degraded without persistence", async () => {
    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt: now,
      },
      {
        fileId: "file2",
        repoId,
        summary:
          "File: src/dashboard.ts\nLanguage: ts\nExports: renderDashboard",
        searchText: "file: src/dashboard.ts exports: renderDashboard",
        updatedAt: now,
      },
    ]);

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      fileIds: ["file1", "file2"],
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      missing: 2,
      degraded: true,
    });

    const summaries = await ladybugDb.getFileSummariesByFileIds(conn, [
      "file1",
      "file2",
    ]);
    for (const summary of summaries.values()) {
      assert.strictEqual(summary.embeddingJinaCode, null);
      assert.strictEqual(summary.embeddingJinaCodeCardHash, null);
    }
  });

  it("marks a mid-refresh FileSummary mock fallback as degraded", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt: new Date().toISOString(),
      },
    ]);
    let mockFallback = false;
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts): Promise<number[][]> {
        mockFallback = true;
        return texts.map(() => new Array<number>(64).fill(0));
      },
      getDimension(): number {
        return 768;
      },
      isMockFallback(): boolean {
        return mockFallback;
      },
    };

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: "nomic-embed-text-v1.5",
      fileIds: ["file1"],
      rebuildMinUncachedRows: 1,
      embeddingProvider,
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      missing: 1,
      degraded: true,
    });
  });

  it("refreshFileSummaryEmbeddings degrades unknown models without persistence", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt: new Date().toISOString(),
      },
    ]);

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "mock",
      model: "unknown-embedding-model",
      fileIds: ["file1"],
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      missing: 1,
      degraded: true,
    });

    const summaries = await ladybugDb.getFileSummariesByFileIds(conn, [
      "file1",
    ]);
    assert.strictEqual(summaries.get("file1")?.embeddingJinaCode, null);
    assert.strictEqual(summaries.get("file1")?.embeddingNomic, null);
  });

  it("refreshFileSummaryEmbeddings scopes incremental runs and only re-embeds changed payloads", async () => {
    const conn = await getLadybugConn();
    await upsertStandardFileSummaries(conn);
    const { provider, calls } = createRecordingProvider();

    const first = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 1,
    });

    assert.deepStrictEqual(first, {
      embedded: 1,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].length, 1);
    assert.match(calls[0][0], /authenticateUser/);

    let rows = await readFileSummaryEmbeddingRows(conn, ["file1", "file2"]);
    const originalFile1 = rows.get("file1");
    assert.ok(originalFile1?.vector);
    assert.strictEqual(
      rows.get("file2")?.vector,
      null,
      "unrequested FileSummary should not be embedded",
    );

    const second = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
    });

    assert.deepStrictEqual(second, {
      embedded: 0,
      skipped: 1,
      missing: 0,
      degraded: false,
      deferred: 1,
    });
    assert.strictEqual(
      calls.length,
      1,
      "cached FileSummary payload should not call the provider again",
    );

    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary:
          "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser\nChanged payload",
        searchText:
          "file: src/auth.ts exports: authenticateUser summary: Changed payload",
        updatedAt: "2026-05-05T00:01:00Z",
      },
    ]);

    const third = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 1,
    });

    assert.deepStrictEqual(third, {
      embedded: 1,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.strictEqual(calls.length, 2);
    assert.match(calls[1][0], /Changed payload/);

    rows = await readFileSummaryEmbeddingRows(conn, ["file1", "file2"]);
    assert.notStrictEqual(rows.get("file1")?.cardHash, originalFile1.cardHash);
    assert.strictEqual(
      rows.get("file2")?.vector,
      null,
      "payload changes outside the requested set should remain untouched",
    );
  });

  it("refreshFileSummaryEmbeddings accumulates deferred rows across incremental scopes", async () => {
    const conn = await getLadybugConn();
    await upsertStandardFileSummaries(conn);
    const { provider, calls } = createRecordingProvider();

    const first = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 3,
    });

    assert.deepStrictEqual(first, {
      embedded: 0,
      skipped: 0,
      missing: 0,
      degraded: false,
      deferred: 2,
    });
    assert.strictEqual(calls.length, 0);

    await ladybugDb.upsertFile(conn, {
      fileId: "file3",
      repoId,
      relPath: "src/settings.ts",
      contentHash: "hash3",
      language: "ts",
      byteSize: 300,
      lastIndexedAt: "2026-05-05T00:01:00Z",
    });
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file3",
        repoId,
        summary: "File: src/settings.ts\nLanguage: ts\nExports: loadSettings",
        searchText: "file: src/settings.ts exports: loadSettings",
        updatedAt: "2026-05-05T00:01:00Z",
      },
    ]);

    const second = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file3"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 3,
    });

    assert.deepStrictEqual(second, {
      embedded: 3,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].length, 3);

    const rows = await readFileSummaryEmbeddingRows(conn, [
      "file1",
      "file2",
      "file3",
    ]);
    for (const fileId of ["file1", "file2", "file3"]) {
      assertStoredVectorArray(rows.get(fileId)?.vectorArray, fileId);
    }
  });

  it("refreshFileSummaryEmbeddings reports empty payloads as missing instead of cached", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: null,
        searchText: "   ",
        updatedAt: "2026-05-05T00:00:00Z",
      },
    ]);
    const { provider, calls } = createRecordingProvider();

    for (const model of [jinaModel, "nomic-embed-text-v1.5"]) {
      const result = await refreshFileSummaryEmbeddings({
        repoId,
        provider: "local",
        model,
        fileIds: ["file1"],
        embeddingProvider: provider,
      });

      assert.deepStrictEqual(
        result,
        {
          embedded: 0,
          skipped: 0,
          missing: 1,
          degraded: false,
        },
        `${model} should treat empty raw payloads as missing`,
      );
    }
    assert.strictEqual(calls.length, 0);
  });

  it("refreshFileSummaryEmbeddings preserves metadata and vector arrays on rebuild writes", async () => {
    const conn = await getLadybugConn();
    const summaryUpdatedAt = "2026-05-05T00:00:00Z";
    await upsertStandardFileSummaries(conn, summaryUpdatedAt);
    const { provider } = createRecordingProvider();

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1", "file2"],
      embeddingProvider: provider,
      batchSize: 1,
      rebuildMinUncachedRows: 1,
    });

    assert.deepStrictEqual(result, {
      embedded: 2,
      skipped: 0,
      missing: 0,
      degraded: false,
    });

    const rows = await readFileSummaryEmbeddingRows(conn, ["file1", "file2"]);
    for (const fileId of ["file1", "file2"]) {
      const row = rows.get(fileId);
      assert.ok(row, `${fileId} summary should exist`);
      assert.ok(row.vector, `${fileId} should store text vector metadata`);
      assert.ok(row.cardHash, `${fileId} should store a card hash`);
      assert.ok(
        row.embeddingUpdatedAt,
        `${fileId} should store embedding update metadata`,
      );
      assert.strictEqual(row.summaryUpdatedAt, summaryUpdatedAt);
      assert.match(row.summary ?? "", /File: src\//);
      assert.match(row.searchText ?? "", /file: src\//);
      assertStoredVectorArray(row.vectorArray, fileId);
    }
  });
});
