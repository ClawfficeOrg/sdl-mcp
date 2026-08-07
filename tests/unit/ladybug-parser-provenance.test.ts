import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { exec } from "../../dist/db/ladybug-core.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  deleteFileParserStatesByFileIdsInTransaction,
  deleteParserProvenanceForRepoInTransaction,
  getRepoParserState,
  listFileParserStates,
  upsertFileParserStatesInTransaction,
  upsertRepoParserStateInTransaction,
  verifyExactParserCoverageInTransaction,
} from "../../dist/db/ladybug-parser-provenance.js";
import { upsertFile, upsertRepo } from "../../dist/db/ladybug-queries.js";
import { hashContent } from "../../dist/util/hashing.js";

const CREATED_AT = "2026-08-07T00:00:00.000Z";

function parserState(
  repoId: string,
  fileId: string,
  engine: "native" | "typescript" = "typescript",
) {
  const native = engine === "native";
  return {
    stateId: JSON.stringify([repoId, fileId]),
    repoId,
    fileId,
    engine,
    engineContract: native ? "native:1" : "typescript:1",
    adapterKey: native
      ? "native:native:1"
      : "builtin:typescript:typescript:1",
    language: "typescript",
  };
}

describe("parser provenance persistence", () => {
  let root = "";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-parser-provenance-"));
    await initLadybugDb(join(root, "provenance.lbug"));
  });

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function seedRepo(
    repoId: string,
    fileIds: readonly string[],
  ): Promise<void> {
    await withWriteConn(async (conn) => {
      await upsertRepo(conn, {
        repoId,
        rootPath: join(root, repoId),
        configJson: "{}",
        createdAt: CREATED_AT,
      });
      for (const fileId of fileIds) {
        await upsertFile(conn, {
          fileId,
          repoId,
          relPath: `src/${fileId}.ts`,
          contentHash: fileId,
          language: "typescript",
          byteSize: 1,
          lastIndexedAt: CREATED_AT,
        });
      }
    });
  }

  it("persists repository-owned file and repository state with a deterministic coverage digest", async () => {
    await seedRepo("r1", ["f1", "f2"]);

    const f1 = parserState("r1", "f1", "native");
    const f2 = parserState("r1", "f2");
    const expectedDigest = hashContent(
      JSON.stringify([
        [
          "f1",
          "native",
          "native:1",
          "native:native:1",
          "typescript",
        ],
        [
          "f2",
          "typescript",
          "typescript:1",
          "builtin:typescript:typescript:1",
          "typescript",
        ],
      ]),
    );

    await withWriteConn(async (conn) => {
      await upsertFileParserStatesInTransaction(conn, [f2, f1]);
      assert.deepEqual(await listFileParserStates(conn, "r1"), [f1, f2]);

      const firstDigest = await verifyExactParserCoverageInTransaction(
        conn,
        "r1",
      );
      assert.equal(firstDigest, expectedDigest);

      await upsertFileParserStatesInTransaction(conn, [f1, f2]);
      assert.equal(
        await verifyExactParserCoverageInTransaction(conn, "r1"),
        firstDigest,
      );

      const repoState = {
        repoId: "r1",
        coverageState: "complete" as const,
        graphVersionId: "version-1",
        graphRevision: 7,
        coverageDigest: firstDigest,
      };
      await upsertRepoParserStateInTransaction(conn, repoState);
      assert.deepEqual(await getRepoParserState(conn, "r1"), repoState);

      await deleteFileParserStatesByFileIdsInTransaction(conn, ["f1"]);
      assert.deepEqual(await listFileParserStates(conn, "r1"), [f2]);

      await deleteParserProvenanceForRepoInTransaction(conn, "r1");
      assert.deepEqual(await listFileParserStates(conn, "r1"), []);
      assert.equal(await getRepoParserState(conn, "r1"), null);
    });
  });

  for (const corruption of [
    "zero",
    "duplicate",
    "orphan",
    "cross-repository",
    "wrong-file",
    "equal-count-different-id",
  ] as const) {
    it(`rejects ${corruption} parser-state coverage`, async () => {
      const repoId = `repo-${corruption}`;
      const fileIds =
        corruption === "zero" || corruption === "wrong-file"
          ? ["f1"]
          : ["f1", "f2"];
      await seedRepo(repoId, fileIds);

      await withWriteConn(async (conn) => {
        if (corruption !== "zero") {
          const states =
            corruption === "equal-count-different-id"
              ? [
                  parserState(repoId, "f1"),
                  parserState(repoId, "f3"),
                ]
              : corruption === "wrong-file"
                ? [parserState(repoId, "f3")]
                : fileIds.map((fileId) => parserState(repoId, fileId));
          await upsertFileParserStatesInTransaction(conn, states);
        }

        if (corruption === "duplicate") {
          await exec(
            conn,
            `MATCH (r:Repo {repoId: $repoId})
             CREATE (s:FileParserState {
               stateId: $stateId, repoId: $repoId, fileId: 'f1',
               engine: 'typescript', engineContract: 'typescript:1',
               adapterKey: 'builtin:typescript:typescript:1',
               language: 'typescript'
             })
             CREATE (s)-[:FILE_PARSER_STATE_IN_REPO]->(r)`,
            { repoId, stateId: JSON.stringify([repoId, "f1", "duplicate"]) },
          );
        }

        if (corruption === "orphan") {
          await exec(
            conn,
            `CREATE (:FileParserState {
               stateId: $stateId, repoId: $repoId, fileId: 'orphan',
               engine: 'typescript', engineContract: 'typescript:1',
               adapterKey: 'builtin:typescript:typescript:1',
               language: 'typescript'
             })`,
            { repoId, stateId: JSON.stringify([repoId, "orphan"]) },
          );
        }

        if (corruption === "cross-repository") {
          const otherRepoId = `${repoId}-other`;
          await upsertRepo(conn, {
            repoId: otherRepoId,
            rootPath: join(root, otherRepoId),
            configJson: "{}",
            createdAt: CREATED_AT,
          });
          await exec(
            conn,
            `MATCH (s:FileParserState {stateId: $stateId})
             MATCH (r:Repo {repoId: $otherRepoId})
             CREATE (s)-[:FILE_PARSER_STATE_IN_REPO]->(r)`,
            {
              stateId: JSON.stringify([repoId, "f1"]),
              otherRepoId,
            },
          );
        }

        await assert.rejects(
          verifyExactParserCoverageInTransaction(conn, repoId),
          /parser coverage/i,
        );
      });
    });
  }

  it("lists only relationship-owned states for the requested repository", async () => {
    await seedRepo("r1", ["f1"]);
    await seedRepo("r2", ["f2"]);

    await withWriteConn(async (conn) => {
      const r1 = parserState("r1", "f1");
      const r2 = parserState("r2", "f2");
      await upsertFileParserStatesInTransaction(conn, [r2, r1]);

      assert.deepEqual(await listFileParserStates(conn, "r1"), [r1]);
      assert.deepEqual(await listFileParserStates(conn, "r2"), [r2]);

      await exec(
        conn,
        `MATCH (s:FileParserState {stateId: $stateId})
         SET s.repoId = 'r2'`,
        { stateId: r1.stateId },
      );
      await assert.rejects(listFileParserStates(conn, "r1"), /parser/i);
    });
  });

  it("rejects unsupported parser engines", async () => {
    await seedRepo("r1", ["f1"]);

    await withWriteConn(async (conn) => {
      const state = parserState("r1", "f1");
      Object.defineProperty(state, "engine", { value: "python" });
      await assert.rejects(
        upsertFileParserStatesInTransaction(conn, [state]),
        /parser coverage/i,
      );
    });
  });

  it("rejects duplicate file parser states in one upsert", async () => {
    await seedRepo("r1", ["f1"]);

    await withWriteConn(async (conn) => {
      const state = parserState("r1", "f1");
      await assert.rejects(
        upsertFileParserStatesInTransaction(conn, [state, state]),
        /parser coverage/i,
      );
    });
  });

  it("rejects repository state with mismatched relationship ownership", async () => {
    await seedRepo("r1", []);
    await seedRepo("r2", []);

    await withWriteConn(async (conn) => {
      await exec(
        conn,
        `MATCH (r:Repo {repoId: 'r1'})
         CREATE (s:RepoParserState {
           repoId: 'r2', coverageState: 'complete',
           graphVersionId: 'version-1', graphRevision: 1,
           coverageDigest: 'digest'
         })
         CREATE (s)-[:REPO_PARSER_STATE_IN_REPO]->(r)`,
      );

      await assert.rejects(getRepoParserState(conn, "r1"), /parser/i);
    });
  });
});
