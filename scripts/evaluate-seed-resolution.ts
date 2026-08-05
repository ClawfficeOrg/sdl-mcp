import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectTaskTextSeedTokens,
  getTaskTextTokenRank,
} from "../dist/graph/slice/start-node-resolver.js";
import { autoExtractMentions } from "../dist/retrieval/seed-resolver.js";
import { normalizeToLf } from "../dist/util/eol.js";

type TaskType = "debug" | "review" | "implement" | "explain";

interface CorpusCase {
  id: string;
  taskType: TaskType;
  taskText: string;
  focusPaths: string[];
  expected: {
    contextMentions: string[];
    sliceTokens: string[];
  };
}

interface Corpus {
  schemaVersion: number;
  source: string;
  cases: CorpusCase[];
}

const ROOT = resolve(import.meta.dirname, "..");
const CORPUS_PATH = resolve(
  ROOT,
  "docs/benchmarks/seed-resolution-corpus-v2.json",
);
const OUTPUT_PATH = resolve(
  ROOT,
  "docs/benchmarks/seed-resolution-evaluation-v2.json",
);
const SOURCE_PATHS = [
  "src/context/engine.ts",
  "src/graph/slice/start-node-resolver.ts",
  "src/retrieval/identifier-extraction.ts",
  "src/retrieval/orchestrator.ts",
  "src/retrieval/seed-resolver.ts",
] as const;
const ITERATIONS = 25;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function sourceHashes(): Record<string, string> {
  return Object.fromEntries(
    SOURCE_PATHS.map((path) => [
      path,
      sha256(normalizeToLf(readFileSync(resolve(ROOT, path), "utf8"))),
    ]),
  );
}

function normalizeRecallToken(value: string): string {
  return value.toLowerCase().replace(/^\p{P}+|\p{P}+$/gu, "");
}

function recall(actual: readonly string[], expected: readonly string[]): number {
  const actualSet = new Set(actual.map(normalizeRecallToken));
  const hits = expected.filter((item) =>
    actualSet.has(normalizeRecallToken(item)),
  ).length;
  return expected.length === 0
    ? 1
    : Number((hits / expected.length).toFixed(3));
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function roundedMs(value: number): number {
  return Number(value.toFixed(4));
}

function evaluateCase(input: CorpusCase) {
  const contextMentions = autoExtractMentions(input.taskText);
  const sliceTokens = collectTaskTextSeedTokens(input.taskText);
  return {
    id: input.id,
    taskType: input.taskType,
    focusPaths: input.focusPaths,
    contextRetrieval: {
      rankedMentions: contextMentions,
      recall: recall(contextMentions, input.expected.contextMentions),
      evidence: "shared identifier extraction, capped in stable order",
    },
    sliceStartNodes: {
      rankedTaskTokens: sliceTokens.map((token) => ({
        token,
        rank: getTaskTextTokenRank(token),
      })),
      recall: recall(sliceTokens, input.expected.sliceTokens),
      evidence: "slice token rank, length, then graph symbol matching",
    },
  };
}

function averageRecall(
  cases: ReturnType<typeof evaluateCase>[],
  stack: "contextRetrieval" | "sliceStartNodes",
): number {
  return Number(
    (
      cases.reduce((total, item) => total + item[stack].recall, 0)
      / cases.length
    ).toFixed(3),
  );
}

function measureLatency(corpus: Corpus): Record<string, number> {
  const samples = {
    contextRetrieval: [] as number[],
    sliceStartNodes: [] as number[],
  };
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    for (const item of corpus.cases) {
      let started = performance.now();
      autoExtractMentions(item.taskText);
      samples.contextRetrieval.push(performance.now() - started);

      started = performance.now();
      collectTaskTextSeedTokens(item.taskText);
      samples.sliceStartNodes.push(performance.now() - started);
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [
      name,
      roundedMs(median(values)),
    ]),
  );
}

function stableProjection(report: Record<string, unknown>): unknown {
  return {
    schemaVersion: report.schemaVersion,
    corpus: report.corpus,
    sourceHashes: (report.baseline as { sourceHashes: unknown }).sourceHashes,
    cases: report.cases,
    quality: report.quality,
  };
}

function main(corpus: Corpus): void {
  const cases = corpus.cases.map(evaluateCase);
  const quality = {
    metric: "labeled seed recall within each retained retrieval interface",
    contextRetrievalRecall: averageRecall(cases, "contextRetrieval"),
    sliceStartNodeRecall: averageRecall(cases, "sliceStartNodes"),
  };
  if (
    quality.contextRetrievalRecall < 1
    || quality.sliceStartNodeRecall < 1
  ) {
    throw new Error(
      `Seed-resolution hard floor failed: ${JSON.stringify(quality)}`,
    );
  }

  const report = {
    schemaVersion: 2,
    corpus: {
      version: corpus.schemaVersion,
      source: corpus.source,
      sha256: sha256(normalizeToLf(readFileSync(CORPUS_PATH, "utf8"))),
      caseCount: corpus.cases.length,
    },
    baseline: {
      gitHead: git(["rev-parse", "HEAD"]),
      evaluatedSourceDiffSha256: sha256(
        git(["diff", "--binary", "HEAD", "--", ...SOURCE_PATHS]),
      ),
      sourceHashes: sourceHashes(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      providerModelSettings: "not used; seed parsing is pure",
    },
    cases,
    quality,
    observedMedianPolicyLatencyMs: measureLatency(corpus),
    reproduction: "npm run benchmark:seed-resolution",
    check:
      "npm run build && node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check",
  };

  if (process.argv.includes("--check")) {
    const existing = JSON.parse(
      readFileSync(OUTPUT_PATH, "utf8"),
    ) as Record<string, unknown>;
    if (
      JSON.stringify(stableProjection(existing))
      !== JSON.stringify(stableProjection(report))
    ) {
      throw new Error("Seed Resolution evaluation artifact is stale");
    }
    console.log("seed-resolution-evaluation: OK");
    return;
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Seed Resolution evaluation saved to ${OUTPUT_PATH}`);
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
main(corpus);
