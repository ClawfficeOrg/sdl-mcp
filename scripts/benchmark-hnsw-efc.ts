#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import type { Connection, Database } from "kuzu";

const VECTOR_DIMENSION = 768;
const JINA_MODEL = "jina-embeddings-v2-base-code";
const BENCH_TABLE = "HnswBenchVector";
const BENCH_INDEX = "hnsw_efc_bench";

export interface HnswBenchmarkOptions {
  sourcePath: string;
  loadMode: "create" | "update" | "clone";
  indexName?: string;
  efcValues: number[];
  queryCount: number;
  k: number;
  efs: number;
  pageSize: number;
}

interface CandidateSummary {
  buildMs: number;
  meanRecall: number;
  minRecall: number;
  queryP50Ms: number;
  queryP95Ms: number;
}

interface VectorRow {
  id: string;
  embedding: unknown;
}

interface QueryVector {
  id: string;
  embedding: number[];
  sampleKey: string;
}

function argValue(args: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = args.findIndex(
    (arg) => arg === flag || arg.startsWith(`${flag}=`),
  );
  if (index < 0) return undefined;
  const arg = args[index];
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

export function parseHnswBenchmarkArgs(
  args: readonly string[],
): HnswBenchmarkOptions {
  const sourcePath = argValue(args, "source");
  if (!sourcePath) throw new Error("--source <absolute-lbug-path> is required");
  if (!isAbsolute(sourcePath))
    throw new Error("--source must be an absolute path");

  const loadMode = argValue(args, "load-mode") ?? "create";
  if (loadMode !== "create" && loadMode !== "update" && loadMode !== "clone") {
    throw new Error("--load-mode must be create, update, or clone");
  }
  const indexName = argValue(args, "index-name");
  if (indexName !== undefined && loadMode !== "clone") {
    throw new Error("--index-name is only valid with --load-mode clone");
  }

  const efcValues = (argValue(args, "efc") ?? "200,100")
    .split(",")
    .map((value) => positiveInt(value.trim(), 0, "efc"));
  if (efcValues.length < 2 || new Set(efcValues).size !== efcValues.length) {
    throw new Error(
      "--efc must contain at least two distinct positive integers",
    );
  }

  return {
    sourcePath,
    loadMode,
    ...(indexName === undefined ? {} : { indexName }),
    efcValues,
    queryCount: positiveInt(argValue(args, "queries"), 20, "queries"),
    k: positiveInt(argValue(args, "k"), 10, "k"),
    efs: positiveInt(argValue(args, "efs"), 200, "efs"),
    pageSize: positiveInt(argValue(args, "page-size"), 256, "page-size"),
  };
}

interface CloneVectorIndex {
  name: string;
  tableName?: string;
  type: "fts" | "vector";
  property: string;
}

export function resolveCloneVectorIndexName(
  indexes: readonly CloneVectorIndex[],
  vectorProperty: string,
  requestedIndexName: string | undefined,
  fallbackIndexName: string,
): string {
  const matches = indexes.filter(
    (index) =>
      index.tableName === "Symbol" &&
      index.type === "vector" &&
      index.property === vectorProperty,
  );
  if (matches.length > 1) {
    throw new Error(
      `Clone contains multiple Symbol vector indexes on ${vectorProperty}; benchmark an unambiguous source`,
    );
  }
  if (matches.length === 1) {
    const installedName = matches[0]!.name;
    if (requestedIndexName && requestedIndexName !== installedName) {
      throw new Error(
        `Clone already contains ${installedName}; --index-name ${requestedIndexName} would leave it installed`,
      );
    }
    return installedName;
  }
  const selectedName = requestedIndexName ?? fallbackIndexName;
  const nameCollision = indexes.find(
    (index) => index.tableName === "Symbol" && index.name === selectedName,
  );
  if (nameCollision) {
    throw new Error(
      `Clone index name ${selectedName} is already used by ${nameCollision.property}; refusing to drop an unrelated index`,
    );
  }
  return selectedName;
}

export function recallAtK(
  predicted: readonly string[],
  exact: readonly string[],
  k: number,
): number {
  const truth = new Set(exact.slice(0, k));
  if (truth.size === 0) return 1;
  const hits = new Set(predicted.slice(0, k)).intersection(truth).size;
  return hits / truth.size;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], percent: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function summarizeHnswCandidate(
  buildMs: number,
  recalls: readonly number[],
  queryLatenciesMs: readonly number[],
): CandidateSummary {
  return {
    buildMs,
    meanRecall: mean(recalls),
    minRecall: Math.min(...recalls),
    queryP50Ms: percentile(queryLatenciesMs, 50),
    queryP95Ms: percentile(queryLatenciesMs, 95),
  };
}

function vectorFromRow(value: unknown): number[] {
  if (!value || typeof value !== "object" || !(Symbol.iterator in value)) {
    throw new Error("LadybugDB returned a non-iterable embedding vector");
  }
  const vector = Array.from(value as Iterable<unknown>, Number);
  if (
    vector.length !== VECTOR_DIMENSION ||
    vector.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`Expected a finite ${VECTOR_DIMENSION}-dimension vector`);
  }
  return vector;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function sampleKey(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function closeStrictly(
  conn: Connection | undefined,
  db: Database | undefined,
): Promise<void> {
  await conn?.close();
  await db?.close();
}

export async function runHnswEfcBenchmark(
  options: HnswBenchmarkOptions,
): Promise<Map<number, CandidateSummary>> {
  if (!existsSync(options.sourcePath)) {
    throw new Error(`Source LadybugDB does not exist: ${options.sourcePath}`);
  }

  const kuzu = await import("kuzu");
  const { exec, execDdl, queryAll, queryStoredProcAll } =
    await import("../dist/db/ladybug-core.js");
  const { createVectorIndex, dropVectorIndex, showIndexesStrict } =
    await import("../dist/retrieval/index-lifecycle.js");
  const { isWindowsFtsRuntimeUnavailable, withWindowsFtsRuntime } =
    await import("../dist/db/ladybug-windows-fts-runtime.js");

  const tempRoot = await mkdtemp(join(tmpdir(), "sdl-hnsw-efc-"));
  let sourceDb: Database | undefined;
  let sourceConn: Connection | undefined;
  let benchDb: Database | undefined;
  let benchConn: Connection | undefined;
  let readConn: Connection | undefined;
  let targetTable = BENCH_TABLE;
  let targetIdProperty = "id";
  let targetVectorProperty = "embedding";
  let targetIndex = BENCH_INDEX;
  let cloneFallbackIndex = BENCH_INDEX;

  try {
    const benchPath = join(tempRoot, "benchmark.lbug");
    if (options.loadMode === "clone") {
      const {
        consumeVerifiedLadybugFamilyCopy,
        copyLadybugFamilyForValidatedClone,
      } = await import("../dist/db/ladybug-family-files.js");
      const { getVecPropertyName, getVectorIndexName } =
        await import("../dist/retrieval/model-mapping.js");
      console.log("Copying and validating the complete LadybugDB family...");
      const capability = copyLadybugFamilyForValidatedClone(
        options.sourcePath,
        benchPath,
      );
      consumeVerifiedLadybugFamilyCopy(capability, benchPath);
      benchDb = new kuzu.Database(benchPath);
      targetTable = "Symbol";
      targetIdProperty = "symbolId";
      targetVectorProperty =
        getVecPropertyName(JINA_MODEL) ?? "embeddingJinaCodeVec";
      cloneFallbackIndex =
        getVectorIndexName(JINA_MODEL) ?? "symbol_vec_jina_code_v2";
    } else {
      // Synthetic modes stream from a read-only source into a new temp DB.
      sourceDb = new kuzu.Database(options.sourcePath, undefined, true, true);
      sourceConn = new kuzu.Connection(sourceDb);
      benchDb = new kuzu.Database(benchPath);
    }
    benchConn = new kuzu.Connection(benchDb);
    readConn = options.loadMode === "clone" ? benchConn : sourceConn;
    if (!readConn) throw new Error("Benchmark read connection is unavailable");

    const extensionResult = await withWindowsFtsRuntime(() =>
      execDdl(benchConn!, "LOAD EXTENSION vector"),
    );
    if (isWindowsFtsRuntimeUnavailable(extensionResult)) {
      throw new Error(
        `Vector extension unavailable: ${extensionResult.reason}`,
      );
    }
    if (options.loadMode === "clone") {
      targetIndex = resolveCloneVectorIndexName(
        await showIndexesStrict(benchConn),
        targetVectorProperty,
        options.indexName,
        cloneFallbackIndex,
      );
    }
    if (options.loadMode !== "clone") {
      await execDdl(
        benchConn,
        `CREATE NODE TABLE ${BENCH_TABLE} (id STRING PRIMARY KEY, embedding DOUBLE[${VECTOR_DIMENSION}])`,
      );
    }

    const readSourceBatch = (afterId: string | undefined) =>
      queryAll<VectorRow>(
        readConn,
        `MATCH (s:Symbol)
         WHERE s.embeddingJinaCodeVec IS NOT NULL
           ${afterId === undefined ? "" : "AND s.symbolId > $afterId"}
         RETURN s.symbolId AS id, s.embeddingJinaCodeVec AS embedding
         ORDER BY s.symbolId
         LIMIT $pageSize`,
        afterId === undefined
          ? { pageSize: options.pageSize }
          : { afterId, pageSize: options.pageSize },
      );

    let afterId: string | undefined;
    let vectorCount = 0;
    const queryVectors: QueryVector[] = [];
    for (;;) {
      const rows = await readSourceBatch(afterId);
      if (rows.length === 0) break;

      const batch = rows.map((row) => ({
        id: String(row.id),
        embedding: vectorFromRow(row.embedding),
      }));
      if (options.loadMode === "clone") {
        // The validated clone already contains the complete production table.
      } else if (options.loadMode === "create") {
        await exec(
          benchConn,
          `UNWIND $rows AS row
           CREATE (:${BENCH_TABLE} {
             id: row.id,
             embedding: CAST(row.embedding, 'DOUBLE[${VECTOR_DIMENSION}]')
           })`,
          { rows: batch },
        );
      } else {
        await exec(
          benchConn,
          `UNWIND $rows AS row
           CREATE (:${BENCH_TABLE} { id: row.id })`,
          { rows: batch.map((row) => ({ id: row.id })) },
        );
      }

      queryVectors.push(
        ...batch.map((row) => ({ ...row, sampleKey: sampleKey(row.id) })),
      );
      queryVectors.sort((left, right) =>
        left.sampleKey.localeCompare(right.sampleKey),
      );
      queryVectors.splice(options.queryCount);
      vectorCount += batch.length;
      afterId = batch.at(-1)!.id;
      if (options.loadMode === "clone") {
        process.stdout.write(
          `\rRead ${vectorCount} Jina vectors from validated clone...`,
        );
      } else {
        const copied =
          options.loadMode === "create" ? "Jina vectors" : "Symbol IDs";
        process.stdout.write(
          `\rCopied ${vectorCount} ${copied} to disposable DB...`,
        );
      }
    }
    process.stdout.write("\n");

    if (options.loadMode === "update") {
      let updateAfterId: string | undefined;
      let updated = 0;
      for (;;) {
        const rows = await readSourceBatch(updateAfterId);
        if (rows.length === 0) break;
        const batch = rows.map((row) => ({
          id: String(row.id),
          embedding: vectorFromRow(row.embedding),
        }));
        // Match the production fast path: existing Symbol rows receive their
        // fixed-size vector through one batched MATCH/SET statement.
        await exec(
          benchConn,
          `UNWIND $rows AS row
           MATCH (target:${BENCH_TABLE} { id: row.id })
           SET target.embedding = row.embedding`,
          { rows: batch },
        );
        updated += batch.length;
        updateAfterId = batch.at(-1)!.id;
        process.stdout.write(
          `\rUpdated ${updated} existing rows with Jina vectors...`,
        );
      }
      process.stdout.write("\n");
    }

    if (vectorCount < options.k || queryVectors.length === 0) {
      throw new Error(
        `Need at least ${options.k} Jina vectors; found ${vectorCount}`,
      );
    }

    console.log(
      `Load mode: ${options.loadMode}; computing exact cosine neighbors for ${queryVectors.length} queries...`,
    );
    const exactByQuery = new Map<string, string[]>();
    for (const query of queryVectors) {
      const rows = await queryAll<{ id: string }>(
        benchConn,
        `MATCH (v:${targetTable})
         WHERE v.${targetVectorProperty} IS NOT NULL
         RETURN v.${targetIdProperty} AS id
         ORDER BY array_cosine_similarity(
           v.${targetVectorProperty},
           CAST(${vectorLiteral(query.embedding)}, 'DOUBLE[${VECTOR_DIMENSION}]')
         ) DESC, v.${targetIdProperty}
         LIMIT ${options.k}`,
      );
      exactByQuery.set(
        query.id,
        rows.map((row) => String(row.id)),
      );
    }

    if (options.loadMode === "clone") {
      const initialDrop = await dropVectorIndex(
        benchConn,
        targetTable,
        targetIndex,
      );
      if (initialDrop.status === "failed") {
        throw new Error(`Initial clone HNSW drop failed: ${initialDrop.error}`);
      }
      console.log(`Validated clone index state: ${initialDrop.status}`);
    }

    const results = new Map<number, CandidateSummary>();
    for (const efc of options.efcValues) {
      console.log(`Building disposable HNSW index with efc=${efc}...`);
      const buildStartedAt = performance.now();
      const created = await createVectorIndex(
        benchConn,
        targetTable,
        targetVectorProperty,
        targetIndex,
        VECTOR_DIMENSION,
        efc,
      );
      const buildMs = performance.now() - buildStartedAt;
      if (!created) throw new Error(`HNSW creation failed for efc=${efc}`);

      const recalls: number[] = [];
      const queryLatencies: number[] = [];
      for (const query of queryVectors) {
        const queryStartedAt = performance.now();
        const rows = await queryStoredProcAll<{ id: unknown }>(
          benchConn,
          `CALL QUERY_VECTOR_INDEX(
             '${targetTable}',
             '${targetIndex}',
             ${vectorLiteral(query.embedding)},
             ${options.k},
             efs := ${options.efs}
           ) RETURN node.${targetIdProperty} AS id, distance`,
        );
        queryLatencies.push(performance.now() - queryStartedAt);
        recalls.push(
          recallAtK(
            rows.map((row) => String(row.id)),
            exactByQuery.get(query.id) ?? [],
            options.k,
          ),
        );
      }
      results.set(
        efc,
        summarizeHnswCandidate(buildMs, recalls, queryLatencies),
      );

      const dropped = await dropVectorIndex(
        benchConn,
        targetTable,
        targetIndex,
      );
      if (dropped.status === "failed") {
        throw new Error(`HNSW cleanup failed for efc=${efc}: ${dropped.error}`);
      }
    }

    console.log(
      "\nefc | build_ms | mean_recall | min_recall | query_p50_ms | query_p95_ms",
    );
    for (const [efc, result] of results) {
      console.log(
        `${String(efc).padStart(3)} | ${result.buildMs.toFixed(0).padStart(8)} | ${result.meanRecall.toFixed(4).padStart(11)} | ${result.minRecall.toFixed(4).padStart(10)} | ${result.queryP50Ms.toFixed(1).padStart(12)} | ${result.queryP95Ms.toFixed(1).padStart(12)}`,
      );
    }
    return results;
  } finally {
    try {
      await closeStrictly(benchConn, benchDb);
    } finally {
      try {
        await closeStrictly(sourceConn, sourceDb);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  }
}

async function main(): Promise<void> {
  try {
    await runHnswEfcBenchmark(parseHnswBenchmarkArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) void main();
