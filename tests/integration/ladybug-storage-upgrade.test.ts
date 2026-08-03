import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { dirname, join } from "path";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { fileURLToPath } from "url";

import type { Connection, QueryResult } from "kuzu";

import { execCheckpoint } from "../../dist/db/ladybug-core.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "ladybug", "storage-v40");
const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");

interface FixtureManifest {
  fixture: string;
  generatedByPackage: string;
  storageVersion: number;
  uncompressedBytes: number;
  uncompressedSha256: string;
  gzipBytes: number;
  gzipSha256: string;
  repoId: string;
  nonDerivedRows: {
    Memory: string;
    AgentFeedback: string;
    UsageSnapshot: string;
    Audit: string;
  };
  derivedRows: {
    DerivedState: string;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadFixture(manifest: FixtureManifest): Buffer {
  const compressedPath = join(FIXTURE_DIR, manifest.fixture);
  const compressed = readFileSync(compressedPath);
  assert.equal(compressed.length, manifest.gzipBytes);
  assert.equal(sha256(compressed), manifest.gzipSha256);

  const raw = gunzipSync(compressed);
  assert.equal(raw.length, manifest.uncompressedBytes);
  assert.equal(sha256(raw), manifest.uncompressedSha256);
  return raw;
}

async function queryAll<T extends Record<string, unknown>>(
  conn: Connection,
  sql: string,
): Promise<T[]> {
  const result = (await conn.query(sql)) as QueryResult;
  try {
    return (await result.getAll()) as T[];
  } finally {
    result.close();
  }
}

async function exec(conn: Connection, sql: string): Promise<void> {
  const result = (await conn.query(sql)) as QueryResult;
  result.close();
}

async function assertFixtureRows(
  conn: Connection,
  manifest: FixtureManifest,
): Promise<void> {
  const [memory] = await queryAll<{ content: string; deleted: boolean }>(
    conn,
    `MATCH (m:Memory {memoryId: '${manifest.nonDerivedRows.Memory}'})
     RETURN m.content AS content, m.deleted AS deleted`,
  );
  assert.deepEqual(memory, {
    content: "storage migration preserves memory",
    deleted: false,
  });

  const [feedback] = await queryAll<{
    taskType: string;
    usefulSymbolsJson: string;
  }>(
    conn,
    `MATCH (f:AgentFeedback {feedbackId: '${manifest.nonDerivedRows.AgentFeedback}'})
     RETURN f.taskType AS taskType, f.usefulSymbolsJson AS usefulSymbolsJson`,
  );
  assert.deepEqual(feedback, {
    taskType: "migration-test",
    usefulSymbolsJson: '["sym-fixture"]',
  });

  const [usage] = await queryAll<{
    totalSdlTokens: number | bigint;
    packedBytesSaved: number | bigint;
  }>(
    conn,
    `MATCH (u:UsageSnapshot {snapshotId: '${manifest.nonDerivedRows.UsageSnapshot}'})
     RETURN u.totalSdlTokens AS totalSdlTokens, u.packedBytesSaved AS packedBytesSaved`,
  );
  assert.equal(Number(usage?.totalSdlTokens), 11);
  assert.equal(Number(usage?.packedBytesSaved), 7);

  const [audit] = await queryAll<{ tool: string; detailsJson: string }>(
    conn,
    `MATCH (a:Audit {eventId: '${manifest.nonDerivedRows.Audit}'})
     RETURN a.tool AS tool, a.detailsJson AS detailsJson`,
  );
  assert.deepEqual(audit, {
    tool: "storage.fixture",
    detailsJson: '{"kind":"storage-upgrade"}',
  });

  const [derived] = await queryAll<{
    clustersDirty: boolean;
    targetVersionId: string;
  }>(
    conn,
    `MATCH (d:DerivedState {repoId: '${manifest.derivedRows.DerivedState}'})
     RETURN d.clustersDirty AS clustersDirty, d.targetVersionId AS targetVersionId`,
  );
  assert.deepEqual(derived, {
    clustersDirty: true,
    targetVersionId: "v40-fixture-version",
  });
}

describe("Ladybug raw-driver storage compatibility evidence", () => {
  it("uses the raw driver to probe a checksum-pinned v40 fixture without production init", async () => {
    const kuzu = await import("kuzu");
    assert.equal(
      String(kuzu.STORAGE_VERSION),
      "43",
      "this test is the 0.19.0 storage-upgrade gate; 0.16.1 reports storage v40",
    );

    const manifest = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as FixtureManifest;
    assert.equal(manifest.generatedByPackage, "@ladybugdb/core@0.16.1");
    assert.equal(manifest.storageVersion, 40);

    const testDir = join(
      tmpdir(),
      `sdl-ladybug-storage-upgrade-${process.pid}-${Date.now()}`,
    );
    const dbPath = join(testDir, "fixture-v40-copy.lbug");
    let db: import("kuzu").Database | undefined;
    let conn: import("kuzu").Connection | undefined;

    try {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(dbPath, loadFixture(manifest));

      db = new kuzu.Database(dbPath);
      conn = new kuzu.Connection(db);



      await assertFixtureRows(conn, manifest);
      await exec(
        conn,
        "CREATE NODE TABLE IF NOT EXISTS DriverQualificationProbe (" +
          "id STRING, cycle INT64, PRIMARY KEY(id))",
      );

      for (let cycle = 1; cycle <= 2; cycle += 1) {
        await exec(
          conn,
          `MERGE (p:DriverQualificationProbe {id: 'storage-upgrade'})
           SET p.cycle = ${cycle}`,
        );
        await execCheckpoint(conn);
        await conn.close();
        conn = undefined;
        await db.close();
        db = undefined;

        db = new kuzu.Database(dbPath);
        conn = new kuzu.Connection(db);
        const [probe] = await queryAll<{
          id: string;
          cycle: number | bigint;
        }>(
          conn,
          `MATCH (p:DriverQualificationProbe {id: 'storage-upgrade'})
           RETURN p.id AS id, p.cycle AS cycle`,
        );
        assert.equal(probe?.id, "storage-upgrade");
        assert.equal(Number(probe?.cycle), cycle);
        await assertFixtureRows(conn, manifest);
      }
    } finally {
      if (conn) await conn.close().catch(() => {});
      if (db) await db.close().catch(() => {});
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
