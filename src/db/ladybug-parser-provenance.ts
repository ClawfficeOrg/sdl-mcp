import type { Connection } from "kuzu";

import { DatabaseError } from "../domain/errors.js";
import type { ParserEngine } from "../indexer/parser-provenance.js";
import { hashContent } from "../util/hashing.js";
import { exec, queryAll, querySingle, toNumber } from "./ladybug-core.js";

export interface FileParserStateRecord {
  stateId: string;
  repoId: string;
  fileId: string;
  engine: ParserEngine;
  engineContract: string;
  adapterKey: string;
  language: string;
}

export interface RepoParserStateRecord {
  repoId: string;
  coverageState: "complete" | "partial";
  graphVersionId: string;
  graphRevision: number;
  coverageDigest: string;
}

export interface ParserCoverageSummary {
  coverageState: "complete" | "partial";
  coverageDigest: string;
}

interface FileParserStateRow extends FileParserStateRecord {
  ownerRepoId: string | null;
}

interface RepoParserStateRow extends Omit<
  RepoParserStateRecord,
  "graphRevision"
> {
  graphRevision: unknown;
  ownerRepoId: string | null;
}

function fileParserStateId(repoId: string, fileId: string): string {
  return JSON.stringify([repoId, fileId]);
}

function parserCoverageError(message: string): DatabaseError {
  return new DatabaseError(`Parser coverage is invalid: ${message}`);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw parserCoverageError(`${field} must not be empty`);
  }
}

function assertFileParserState(row: FileParserStateRecord): void {
  for (const field of [
    "repoId",
    "fileId",
    "engine",
    "engineContract",
    "adapterKey",
    "language",
  ] as const) {
    assertNonEmpty(row[field], field);
  }
  if (row.engine !== "native" && row.engine !== "typescript") {
    throw parserCoverageError("parser engine is unsupported");
  }
  if (row.stateId !== fileParserStateId(row.repoId, row.fileId)) {
    throw parserCoverageError("file parser state identity is inconsistent");
  }
}

function assertRepoParserState(row: RepoParserStateRecord): void {
  assertNonEmpty(row.repoId, "repoId");
  assertNonEmpty(row.graphVersionId, "graphVersionId");
  assertNonEmpty(row.coverageDigest, "coverageDigest");
  if (
    row.coverageState !== "complete" &&
    row.coverageState !== "partial"
  ) {
    throw parserCoverageError(
      "repository coverage state must be complete or partial",
    );
  }
  if (!Number.isSafeInteger(row.graphRevision)) {
    throw parserCoverageError("graphRevision must be a safe integer");
  }
}

export async function upsertFileParserStatesInTransaction(
  conn: Connection,
  rows: readonly FileParserStateRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  const fileIds = new Set<string>();
  for (const row of rows) {
    assertFileParserState(row);
    if (fileIds.has(row.fileId)) {
      throw parserCoverageError("duplicate file parser state");
    }
    fileIds.add(row.fileId);
  }

  await exec(
    conn,
    `UNWIND $rows AS row
     MATCH (r:Repo {repoId: row.repoId})
     MERGE (s:FileParserState {stateId: row.stateId})
     SET s.repoId = row.repoId, s.fileId = row.fileId,
         s.engine = row.engine, s.engineContract = row.engineContract,
         s.adapterKey = row.adapterKey, s.language = row.language
     MERGE (s)-[:FILE_PARSER_STATE_IN_REPO]->(r)`,
    { rows },
  );
}

export async function listFileParserStates(
  conn: Connection,
  repoId: string,
): Promise<FileParserStateRecord[]> {
  const wrongOwner = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:FileParserState)-[:FILE_PARSER_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE s.repoId IS NULL OR s.repoId <> $repoId
     RETURN count(s) AS count`,
    { repoId },
  );
  if (toNumber(wrongOwner?.count ?? 0) !== 0) {
    throw parserCoverageError("file parser state ownership is inconsistent");
  }

  const rows = await queryAll<FileParserStateRow>(
    conn,
    `MATCH (s:FileParserState {repoId: $repoId})
     OPTIONAL MATCH (s)-[:FILE_PARSER_STATE_IN_REPO]->(owner:Repo)
     RETURN s.stateId AS stateId, s.repoId AS repoId, s.fileId AS fileId,
            s.engine AS engine, s.engineContract AS engineContract,
            s.adapterKey AS adapterKey, s.language AS language,
            owner.repoId AS ownerRepoId
     ORDER BY s.fileId ASC, s.stateId ASC, owner.repoId ASC`,
    { repoId },
  );

  const byStateId = new Map<string, FileParserStateRow[]>();
  for (const row of rows) {
    const group = byStateId.get(row.stateId);
    if (group) group.push(row);
    else byStateId.set(row.stateId, [row]);
  }

  const states: FileParserStateRecord[] = [];
  const fileIds = new Set<string>();
  for (const group of byStateId.values()) {
    const [row] = group;
    if (!row || group.length !== 1 || row.ownerRepoId !== repoId) {
      throw parserCoverageError(
        "file parser state must have exactly one owner",
      );
    }
    const state: FileParserStateRecord = {
      stateId: row.stateId,
      repoId: row.repoId,
      fileId: row.fileId,
      engine: row.engine,
      engineContract: row.engineContract,
      adapterKey: row.adapterKey,
      language: row.language,
    };
    assertFileParserState(state);
    if (fileIds.has(state.fileId)) {
      throw parserCoverageError("duplicate file parser state");
    }
    fileIds.add(state.fileId);
    states.push(state);
  }
  return states;
}

export async function getFileParserState(
  conn: Connection,
  repoId: string,
  fileId: string,
): Promise<FileParserStateRecord | null> {
  const stateId = JSON.stringify([repoId, fileId]);
  const rows = await queryAll<FileParserStateRow>(
    conn,
    `MATCH (s:FileParserState {fileId: $fileId})
     OPTIONAL MATCH (s)-[:FILE_PARSER_STATE_IN_REPO]->(owner:Repo)
     RETURN s.stateId AS stateId, s.repoId AS repoId, s.fileId AS fileId,
            s.engine AS engine, s.engineContract AS engineContract,
            s.adapterKey AS adapterKey, s.language AS language,
            owner.repoId AS ownerRepoId
     ORDER BY s.stateId ASC, owner.repoId ASC`,
    { fileId },
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.stateId !== stateId ||
    row.repoId !== repoId ||
    row.fileId !== fileId ||
    row.ownerRepoId !== repoId
  ) {
    throw parserCoverageError("file parser state ownership is inconsistent");
  }
  const state: FileParserStateRecord = {
    stateId: row.stateId,
    repoId: row.repoId,
    fileId: row.fileId,
    engine: row.engine,
    engineContract: row.engineContract,
    adapterKey: row.adapterKey,
    language: row.language,
  };
  assertFileParserState(state);
  return state;
}

/** Validate provenance structure while treating membership gaps as partial coverage. */
export async function summarizeParserCoverageInTransaction(
  conn: Connection,
  repoId: string,
): Promise<ParserCoverageSummary> {
  const files = await queryAll<{ fileId: string }>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId
     ORDER BY f.fileId ASC`,
    { repoId },
  );
  const expectedFileIds = files.map((row) => row.fileId);
  if (new Set(expectedFileIds).size !== expectedFileIds.length) {
    throw parserCoverageError("duplicate repository file identity");
  }

  const states = await listFileParserStates(conn, repoId);
  const coverageState =
    states.length !== expectedFileIds.length ||
    states.some((state, index) => state.fileId !== expectedFileIds[index])
      ? "partial"
      : "complete";
  const coverageDigest = hashContent(
    JSON.stringify(
      states.map((state) => [
        state.fileId,
        state.engine,
        state.engineContract,
        state.adapterKey,
        state.language,
      ]),
    ),
  );
  return { coverageState, coverageDigest };
}

export async function verifyExactParserCoverageInTransaction(
  conn: Connection,
  repoId: string,
): Promise<string> {
  const summary = await summarizeParserCoverageInTransaction(conn, repoId);
  if (summary.coverageState !== "complete") {
    throw parserCoverageError("file and parser-state membership differ");
  }
  return summary.coverageDigest;
}

export async function upsertRepoParserStateInTransaction(
  conn: Connection,
  row: RepoParserStateRecord,
): Promise<void> {
  assertRepoParserState(row);
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (s:RepoParserState {repoId: $repoId})
     SET s.coverageState = $coverageState,
         s.graphVersionId = $graphVersionId,
         s.graphRevision = $graphRevision,
         s.coverageDigest = $coverageDigest
     MERGE (s)-[:REPO_PARSER_STATE_IN_REPO]->(r)`,
    { ...row },
  );
}

export async function getRepoParserState(
  conn: Connection,
  repoId: string,
): Promise<RepoParserStateRecord | null> {
  const wrongOwner = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:RepoParserState)-[:REPO_PARSER_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE s.repoId <> $repoId
     RETURN count(s) AS count`,
    { repoId },
  );
  if (toNumber(wrongOwner?.count ?? 0) !== 0) {
    throw parserCoverageError(
      "repository parser state ownership is inconsistent",
    );
  }

  const rows = await queryAll<RepoParserStateRow>(
    conn,
    `MATCH (s:RepoParserState {repoId: $repoId})
     OPTIONAL MATCH (s)-[:REPO_PARSER_STATE_IN_REPO]->(owner:Repo)
     RETURN s.repoId AS repoId, s.coverageState AS coverageState,
            s.graphVersionId AS graphVersionId,
            s.graphRevision AS graphRevision,
            s.coverageDigest AS coverageDigest,
            owner.repoId AS ownerRepoId
     ORDER BY owner.repoId ASC`,
    { repoId },
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0]?.ownerRepoId !== repoId) {
    throw parserCoverageError(
      "repository parser state ownership is inconsistent",
    );
  }
  const row = rows[0];
  const state: RepoParserStateRecord = {
    repoId: row.repoId,
    coverageState: row.coverageState,
    graphVersionId: row.graphVersionId,
    graphRevision: toNumber(row.graphRevision),
    coverageDigest: row.coverageDigest,
  };
  assertRepoParserState(state);
  return state;
}

export async function deleteFileParserStatesByFileIdsInTransaction(
  conn: Connection,
  fileIds: readonly string[],
): Promise<void> {
  const uniqueFileIds = [...new Set(fileIds)];
  if (uniqueFileIds.length === 0) return;
  await exec(
    conn,
    `MATCH (s:FileParserState)
     WHERE s.fileId IN $fileIds
     DETACH DELETE s`,
    { fileIds: uniqueFileIds },
  );
}

export async function deleteParserProvenanceForRepoInTransaction(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:FileParserState)-[:FILE_PARSER_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     DETACH DELETE s`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (s:FileParserState {repoId: $repoId})
     DETACH DELETE s`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (s:RepoParserState)-[:REPO_PARSER_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     DETACH DELETE s`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (s:RepoParserState {repoId: $repoId})
     DETACH DELETE s`,
    { repoId },
  );
}
