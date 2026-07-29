import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as contextEngine from "../../dist/context/engine.js";

const engineSource = readFileSync(
  new URL("../../src/context/engine.ts", import.meta.url),
  "utf8",
);
const candidateSearchSource = readFileSync(
  new URL(
    "../../src/retrieval/context-candidate-search.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("Context V2 database boundary", () => {
  it("owns a temporary exclusive connection for the full read-only snapshot", () => {
    assert.match(
      engineSource,
      /withExclusiveReadConnection\([\s\S]*withReadOnlyTransaction\(/,
    );
    assert.doesNotMatch(
      engineSource,
      /async function defaultRunReadSnapshot[\s\S]*?getLadybugConn\(/,
    );
  });

  it("admits graph reads before embedding prewarm and the transaction", async () => {
    const runReadSnapshot = Reflect.get(
      contextEngine,
      "defaultRunReadSnapshot",
    );
    assert.equal(typeof runReadSnapshot, "function");
    if (typeof runReadSnapshot !== "function") return;

    const events: string[] = [];
    const embeddingPromises = new Map([
      [
        "jina-embeddings-v2-base-code\u0000review ContextEngineV2",
        Promise.resolve([1]).then((embedding) => {
          events.push("embedding:resolved");
          return embedding;
        }),
      ],
    ]);
    const connection = {};

    await runReadSnapshot(
      "repo",
      async (runtime: {
        queryContext?: {
          embeddingPromises: Map<string, Promise<number[]>>;
        };
      }) => {
        events.push("callback");
        assert.strictEqual(
          runtime.queryContext?.embeddingPromises,
          embeddingPromises,
        );
        return "done";
      },
      { query: "review ContextEngineV2", includeFileSummary: false },
      {
        prewarmEmbeddingPromises: async () => {
          await Promise.allSettled(embeddingPromises.values());
          return embeddingPromises;
        },
        withExclusiveReadConnection: async (
          fn: (conn: object) => Promise<unknown>,
        ) => {
          events.push("exclusive:acquired");
          return fn(connection);
        },
        runAfterGraphRetrievalAdmission: async (
          conn: object,
          repoId: string,
          fn: () => Promise<unknown>,
        ) => {
          assert.strictEqual(conn, connection);
          assert.equal(repoId, "repo");
          events.push("graph:admitted");
          return fn();
        },
        withReadOnlyTransaction: async (
          conn: object,
          fn: () => Promise<unknown>,
        ) => {
          assert.strictEqual(conn, connection);
          events.push("transaction:begin");
          return fn();
        },
        getOverlaySnapshot: () => ({ repoId: "repo" }),
        createRetrievalQueryContext: (initial: {
          embeddingPromises: Map<string, Promise<number[]>>;
        }) => ({
          ...initial,
          laneOutcomes: new Map(),
          healthPromises: new Map(),
        }),
      },
    );

    assert.deepEqual(events, [
      "exclusive:acquired",
      "graph:admitted",
      "embedding:resolved",
      "exclusive:acquired",
      "transaction:begin",
      "callback",
    ]);
  });

  it("does not invoke the embedding provider when graph admission rejects", async () => {
    const runReadSnapshot = Reflect.get(
      contextEngine,
      "defaultRunReadSnapshot",
    );
    assert.equal(typeof runReadSnapshot, "function");
    if (typeof runReadSnapshot !== "function") return;

    let prewarmCalled = false;
    let transactionCalled = false;
    const admissionError = new Error("graph integrity unverified");

    await assert.rejects(
      runReadSnapshot(
        "repo",
        async () => "unreachable",
        { query: "review ContextEngineV2", includeFileSummary: false },
        {
          prewarmEmbeddingPromises: async () => {
            prewarmCalled = true;
            return new Map();
          },
          withExclusiveReadConnection: async (
            fn: (conn: object) => Promise<unknown>,
          ) => fn({}),
          runAfterGraphRetrievalAdmission: async () => {
            throw admissionError;
          },
          withReadOnlyTransaction: async (
            _conn: object,
            fn: () => Promise<unknown>,
          ) => {
            transactionCalled = true;
            return fn();
          },
          getOverlaySnapshot: () => ({ repoId: "repo" }),
          createRetrievalQueryContext: () => ({
            laneOutcomes: new Map(),
            healthPromises: new Map(),
            embeddingPromises: new Map(),
          }),
        },
      ),
      admissionError,
    );

    assert.equal(prewarmCalled, false);
    assert.equal(transactionCalled, false);
  });

  it("delegates unified symbol and FileSummary ranking to the retrieval owner", () => {
    assert.match(engineSource, /searchContextCandidates\(/);
    assert.doesNotMatch(engineSource, /const fileSummaryCandidates/);
    assert.doesNotMatch(
      engineSource,
      /\.\.\.symbolCandidates,[\s\S]*\.\.\.fileSummaryCandidates/,
    );
  });

  it("passes focus partitioning and exact pins into shared fusion without local reorder", () => {
    const defaultRetrieveSource =
      engineSource.match(
        /async function defaultRetrieve[\s\S]*?async function defaultExpand/,
      )?.[0] ?? "";

    assert.match(defaultRetrieveSource, /pinnedSymbolIds:/);
    assert.match(defaultRetrieveSource, /exactIdentifierSymbolIds:/);
    assert.match(
      defaultRetrieveSource,
      /focusPathPrefixes:\s*pathResolution\.directoryPrefixes/,
    );
    assert.match(
      defaultRetrieveSource,
      /candidateResult\.rows\.map\(\s*\(row, index\)\s*=>\s*\(\{[\s\S]*rank:\s*index \+ 1/,
    );
    assert.match(defaultRetrieveSource, /tier: row\.tier/);
    assert.doesNotMatch(
      defaultRetrieveSource,
      /candidateResult\.rows[\s\S]*?\.sort\(/,
    );
    assert.doesNotMatch(defaultRetrieveSource, /mergeCandidates\(/);
    assert.doesNotMatch(defaultRetrieveSource, /buildMetadataCandidates\(/);
  });

  it("keeps fused pins ahead of post-fusion PPR boosts", () => {
    const pprSource =
      candidateSearchSource.match(
        /async function applyContextPpr[\s\S]*?function buildContextCandidateEvidence/,
      )?.[0] ?? "";

    assert.match(pprSource, /const pinned = fused\.filter/);
    assert.match(pprSource, /const boostable = fused\.filter/);
    assert.match(
      pprSource,
      /const pprItems:[\s\S]*boostable\.map/,
    );
    assert.match(pprSource, /applyPprBoost\(pprItems,/);
    assert.match(pprSource, /return \[\s*\.\.\.pinned,/);
  });
});

describe("semantic test-case candidate boundary", () => {
  it("parses durable facet JSON only while normalizing candidates", () => {
    assert.match(
      candidateSearchSource,
      /parseTestCaseFacetJson\([\s\S]*?testCaseJson/,
    );
    assert.match(candidateSearchSource, /hasTestCaseFacet:\s*boolean/);
    assert.match(candidateSearchSource, /isTestCandidate\(/);
    assert.doesNotMatch(
      candidateSearchSource,
      /rows:\s*orderedRows\.map\([\s\S]*testCaseJson/,
    );
  });
});
