import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearAllCaches } from "../../dist/graph/cache.js";
import { clearSnapshotCache } from "../../dist/live-index/overlay-reader.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { buildCardForSymbol } from "../../dist/services/card-builder.js";
import { NotFoundError } from "../../dist/domain/errors.js";
import { PolicyEngine } from "../../dist/policy/engine.js";

const TEST_DB_PATH = join(
  tmpdir(),
  `.lbug-card-builder-unit-test-db-${process.pid}.lbug`,
);
const ORIGINAL_GRAPH_DB_PATH = process.env.SDL_GRAPH_DB_PATH;
const ORIGINAL_NATIVE_ADDON = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
const TEST_CASE_JSON =
  '{"framework":"node:test","title":"keeps sdl.info callable","suitePath":["Code Mode"],"modifiers":["only"]}';
const TEST_CASE = {
  framework: "node:test",
  title: "keeps sdl.info callable",
  suitePath: ["Code Mode"],
  modifiers: ["only"],
};

async function resetDb(): Promise<void> {
  clearAllCaches();
  clearSnapshotCache();
  await closeLadybugDb();
  for (const p of [
    TEST_DB_PATH,
    `${TEST_DB_PATH}.wal`,
    `${TEST_DB_PATH}.shadow`,
    `${TEST_DB_PATH}.lock`,
  ]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  await initLadybugDb(TEST_DB_PATH);
}

async function seedRepoAndFile(repoId: string, fileId: string): Promise<void> {
  const conn = await getLadybugConn();
  const now = "2026-03-19T08:00:00.000Z";
  await ladybugDb.upsertRepo(conn, {
    repoId,
    rootPath: "C:/card-builder-test",
    configJson: JSON.stringify({ policy: {} }),
    createdAt: now,
  });
  await ladybugDb.upsertFile(conn, {
    fileId,
    repoId,
    relPath: "src/service.ts",
    contentHash: `${fileId}-hash`,
    language: "ts",
    byteSize: 200,
    lastIndexedAt: now,
  });
}

async function seedSymbol(params: {
  repoId: string;
  fileId: string;
  symbolId: string;
  name: string;
  testCaseJson?: string | null;
  external?: boolean;
}): Promise<void> {
  const conn = await getLadybugConn();
  await ladybugDb.upsertSymbolBatch(conn, [{
    symbolId: params.symbolId,
    repoId: params.repoId,
    fileId: params.fileId,
    kind: "function",
    name: params.name,
    exported: true,
    visibility: "public",
    language: "ts",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 5,
    rangeEndCol: 0,
    astFingerprint: `${params.symbolId}-fp`,
    signatureJson: JSON.stringify({
      name: params.name,
      params: [],
      returns: "void",
    }),
    summary: `${params.name} summary`,
    invariantsJson: null,
    sideEffectsJson: null,
    testCaseJson: params.testCaseJson ?? null,
    external: params.external ?? false,
    updatedAt: "2026-03-19T08:00:00.000Z",
  }]);
}

describe("card-builder", () => {
  before(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    process.env.SDL_GRAPH_DB_PATH = TEST_DB_PATH;
  });

  after(async () => {
    clearAllCaches();
    clearSnapshotCache();
    await closeLadybugDb();
    for (const path of [
      TEST_DB_PATH,
      `${TEST_DB_PATH}.wal`,
      `${TEST_DB_PATH}.shadow`,
      `${TEST_DB_PATH}.lock`,
    ]) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    if (ORIGINAL_GRAPH_DB_PATH === undefined) {
      delete process.env.SDL_GRAPH_DB_PATH;
    } else {
      process.env.SDL_GRAPH_DB_PATH = ORIGINAL_GRAPH_DB_PATH;
    }
    if (ORIGINAL_NATIVE_ADDON === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = ORIGINAL_NATIVE_ADDON;
    }
  });

  it("exports buildCardForSymbol and returns a full card", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-a",
      name: "buildThing",
    });

    const card = await buildCardForSymbol("repo-a", "sym-a", undefined);

    assert.equal(typeof buildCardForSymbol, "function");
    assert.ok(!("notModified" in card));
    assert.equal(card.symbolId, "sym-a");
    assert.equal(card.repoId, "repo-a");
    assert.equal(card.name, "buildThing");
    assert.equal(card.detailLevel, "full");
    assert.equal(typeof card.etag, "string");
  });

  it("exposes parsed test-case facets on minimal and full cards", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-full",
      name: "fullTest",
      testCaseJson: TEST_CASE_JSON,
    });
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-minimal",
      name: "minimalTest",
      testCaseJson: TEST_CASE_JSON,
      external: true,
    });

    const full = await buildCardForSymbol(
      "repo-a",
      "sym-full",
      undefined,
    );
    const minimal = await buildCardForSymbol(
      "repo-a",
      "sym-minimal",
      undefined,
    );

    assert.ok(!("notModified" in full));
    assert.ok(!("notModified" in minimal));
    assert.deepStrictEqual(full.testCase, TEST_CASE);
    assert.deepStrictEqual(minimal.testCase, TEST_CASE);
    assert.equal(minimal.detailLevel, "minimal");
  });

  it("omits null and malformed persisted test-case facets", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-null",
      name: "nullTest",
      testCaseJson: null,
    });
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-malformed",
      name: "malformedTest",
      testCaseJson: '{"framework":"node:test"}',
    });

    const nullCard = await buildCardForSymbol(
      "repo-a",
      "sym-null",
      undefined,
    );
    const malformedCard = await buildCardForSymbol(
      "repo-a",
      "sym-malformed",
      undefined,
    );

    assert.ok(!("notModified" in nullCard));
    assert.ok(!("notModified" in malformedCard));
    assert.ok(!("testCase" in nullCard));
    assert.ok(!("testCase" in malformedCard));
  });

  it("changes the card ETag when only the test-case facet changes", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    const symbol = {
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-etag",
      name: "etagTest",
    };
    await seedSymbol({ ...symbol, testCaseJson: null });
    const withoutFacet = await buildCardForSymbol(
      "repo-a",
      "sym-etag",
      undefined,
    );

    await seedSymbol({ ...symbol, testCaseJson: TEST_CASE_JSON });
    const withFacet = await buildCardForSymbol(
      "repo-a",
      "sym-etag",
      undefined,
    );

    assert.ok(!("notModified" in withoutFacet));
    assert.ok(!("notModified" in withFacet));
    assert.notEqual(withFacet.etag, withoutFacet.etag);
    assert.deepStrictEqual(withFacet.testCase, TEST_CASE);
  });

  it("throws NotFoundError when symbol does not exist", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");

    await assert.rejects(
      () => buildCardForSymbol("repo-a", "missing-symbol", undefined),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.code, "NOT_FOUND");
        assert.match(
          (error as Error).message,
          /Symbol not found: missing-symbol/,
        );
        return true;
      },
    );
  });

  it("returns notModified when ifNoneMatch matches computed etag", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-a",
      name: "buildThing",
    });

    const conn = await getLadybugConn();
    await ladybugDb.createVersion(conn, {
      versionId: "v-test-1",
      repoId: "repo-a",
      createdAt: "2026-03-19T08:00:00.000Z",
      reason: "unit-test",
      prevVersionHash: null,
      versionHash: "hash-v-test-1",
    });

    const first = await buildCardForSymbol("repo-a", "sym-a", undefined);
    assert.ok(!("notModified" in first));

    const second = await buildCardForSymbol("repo-a", "sym-a", first.etag);
    assert.ok("notModified" in second);
    assert.equal(second.notModified, true);
    assert.equal(second.etag, first.etag);
    assert.equal(second.ledgerVersion, "v-test-1");
  });

  it("filters call deps by minCallConfidence and includes resolution metadata", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-entry",
      name: "entry",
    });
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-stable",
      name: "stableCall",
    });
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-guess",
      name: "guessCall",
    });

    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-a",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-stable",
        edgeType: "call",
        weight: 1,
        confidence: 0.95,
        resolution: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
        provenance: "ts-compiler",
        createdAt: "2026-03-19T08:00:00.000Z",
      },
      {
        repoId: "repo-a",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-guess",
        edgeType: "call",
        weight: 1,
        confidence: 0.33,
        resolution: "global-fallback",
        resolverId: "pass1",
        resolutionPhase: "pass1",
        provenance: "heuristic",
        createdAt: "2026-03-19T08:00:00.000Z",
      },
    ]);

    const card = await buildCardForSymbol("repo-a", "sym-entry", undefined, {
      minCallConfidence: 0.8,
      includeResolutionMetadata: true,
    });

    assert.ok(!("notModified" in card));
    assert.deepStrictEqual(card.deps.calls, ["stableCall"]);
    assert.deepStrictEqual(card.callResolution, {
      minCallConfidence: 0.8,
      calls: [
        {
          symbolId: "sym-stable",
          label: "stableCall",
          confidence: 0.95,
          resolutionReason: "exact",
          resolverId: "pass2-ts",
          resolutionPhase: "pass2",
        },
      ],
    });
  });

  it("throws policy denial when policy engine denies card request", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-a",
      name: "blockedFn",
    });

    const originalEvaluate = PolicyEngine.prototype.evaluate;
    const originalNextBest = PolicyEngine.prototype.generateNextBestAction;

    PolicyEngine.prototype.evaluate = function evaluateDeny() {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "forced-deny",
        deniedReasons: ["forced deny for test"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction =
      function generateNextBest() {
        return {
          nextBestAction: "requestSkeleton",
          requiredFieldsForNext: {
            requestSkeleton: {
              repoId: "repo-a",
              symbolId: "sym-a",
            },
          },
        };
      };

    try {
      await assert.rejects(
        () => buildCardForSymbol("repo-a", "sym-a", undefined),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "PolicyDenialError");
          assert.match(error.message, /Policy denied symbol card request/);
          return true;
        },
      );
    } finally {
      PolicyEngine.prototype.evaluate = originalEvaluate;
      PolicyEngine.prototype.generateNextBestAction = originalNextBest;
    }
  });
});
