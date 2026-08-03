import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";

type Lease = object;

interface LineageModule {
  getLadybugLineageMarkerPath(dbPath: string): string;
  getLadybugFamilyLockPath(dbPath: string): string;
  acquireNormalLadybugFamily(
    dbPath: string,
    driver: { version: string; storageVersion: string },
  ): Lease;
  reserveSafeRebuildLadybugFamily(
    dbPath: string,
    driver: { version: string; storageVersion: string },
  ): Lease;
  finalizeNormalLadybugFamilyClose(lease: Lease): void;
  sealSafeRebuildFamilyForReopen(lease: Lease): void;
  verifySafeRebuildFamilyBeforeReopen(lease: Lease): void;
  finalizeSafeRebuildLadybugFamily(
    lease: Lease,
    beforePublication?: () => void,
  ): void;
  abandonLadybugFamily(lease: Lease): void;
  writeLadybugLineageMarker?: unknown;
  verifyLadybugLineageBeforeOpen?: unknown;
  reserveFreshLadybugPrimary?: unknown;
}

const DRIVER = { version: "0.19.0-test", storageVersion: "43" };
let lineage: LineageModule | undefined;
let testRoot = "";
const openLeases = new Set<Lease>();

before(async () => {
  lineage = (await import(
    "../../dist/db/ladybug-lineage.js"
  )) as unknown as LineageModule;
});

afterEach(() => {
  if (lineage) {
    for (const lease of openLeases) {
      try {
        lineage.abandonLadybugFamily(lease);
      } catch {
        // The test may already have finalized and released the lease.
      }
    }
  }
  openLeases.clear();
  if (testRoot && existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
  testRoot = "";
});

function api(): LineageModule {
  assert.ok(lineage, "Ladybug lineage module must exist");
  return lineage;
}

function freshPath(name = "graph.lbug"): string {
  testRoot = mkdtempSync(join(tmpdir(), "sdl-ladybug-lineage-"));
  return join(testRoot, name);
}

function track(lease: Lease): Lease {
  openLeases.add(lease);
  return lease;
}

function createReadyFamily(options: { wal?: string } = {}): string {
  const dbPath = freshPath();
  const lease = track(api().acquireNormalLadybugFamily(dbPath, DRIVER));
  writeFileSync(dbPath, "primary-v1", "utf8");
  if (options.wal !== undefined) {
    writeFileSync(dbPath + ".wal", options.wal, "utf8");
  }
  api().finalizeNormalLadybugFamilyClose(lease);
  openLeases.delete(lease);
  return dbPath;
}

describe("Ladybug closed-family lineage receipt", () => {
  it("reserves the whole fresh family under a cooperative lifetime lock", () => {
    const dbPath = freshPath();
    const lease = track(api().acquireNormalLadybugFamily(dbPath, DRIVER));

    assert.equal(existsSync(dbPath), true);
    assert.equal(existsSync(api().getLadybugFamilyLockPath(dbPath)), true);
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /family lock[\s\S]*(?:active|owned|process)/iu,
    );

    writeFileSync(dbPath, "primary", "utf8");
    api().finalizeNormalLadybugFamilyClose(lease);
    openLeases.delete(lease);
    assert.equal(existsSync(api().getLadybugFamilyLockPath(dbPath)), false);
  });

  for (const suffix of [
    ".sdl-lineage.json",
    ".wal",
    ".wal.checkpoint",
    ".shadow",
    ".tmp-crash",
    ".recovery",
    ".unknown",
  ]) {
    it("rejects an orphan " + suffix + " member before reserving a fresh primary", () => {
      const dbPath = freshPath();
      writeFileSync(dbPath + suffix, "orphan", "utf8");

      assert.throws(
        () => api().reserveSafeRebuildLadybugFamily(dbPath, DRIVER),
        /database family is not fresh[\s\S]*--safe-rebuild/iu,
      );
      assert.equal(existsSync(dbPath), false);
    });
  }

  it("publishes an atomic receipt for the complete durable closed family", () => {
    const dbPath = createReadyFamily({ wal: "wal-v1" });
    const markerPath = api().getLadybugLineageMarkerPath(dbPath);
    const receipt = JSON.parse(readFileSync(markerPath, "utf8")) as {
      receiptKind: string;
      receiptVersion: number;
      canonicalDbPath: string;
      primaryFile: { dev: string; ino: string };
      driverVersion: string;
      storageVersion: string;
      family: {
        files: Array<{ path: string; size: number; sha256: string }>;
        sha256: string;
      };
    };

    assert.equal(receipt.receiptKind, "sdl-mcp-ladybug-ready");
    assert.equal(receipt.receiptVersion, 2);
    assert.match(receipt.canonicalDbPath, /graph\.lbug$/iu);
    assert.match(JSON.stringify(receipt.primaryFile), /"dev":"\d+","ino":"\d+"/u);
    assert.equal(receipt.driverVersion, DRIVER.version);
    assert.equal(receipt.storageVersion, DRIVER.storageVersion);
    assert.deepEqual(
      receipt.family.files.map((file) => file.path),
      ["graph.lbug", "graph.lbug.wal"],
    );
    assert.ok(
      receipt.family.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)),
    );
    assert.match(receipt.family.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      readdirSync(testRoot).filter((name) => name.includes(".tmp-")),
      [],
    );

    const reopened = track(api().acquireNormalLadybugFamily(dbPath, DRIVER));
    api().abandonLadybugFamily(reopened);
    openLeases.delete(reopened);
  });

  it("rejects an in-place primary overwrite even when dev and ino are unchanged", () => {
    const dbPath = createReadyFamily();
    writeFileSync(dbPath, "primary-v2-with-different-bytes", "utf8");
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /closed family digest mismatch[\s\S]*--safe-rebuild/iu,
    );
  });

  it("rejects a changed durable WAL", () => {
    const dbPath = createReadyFamily({ wal: "wal-v1" });
    writeFileSync(dbPath + ".wal", "wal-v2", "utf8");
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /closed family digest mismatch[\s\S]*--safe-rebuild/iu,
    );
  });

  it("rejects a replaced primary before native open", () => {
    const dbPath = createReadyFamily();
    renameSync(dbPath, dbPath + ".original");
    writeFileSync(dbPath, "replacement", "utf8");
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /primary file identity mismatch[\s\S]*--safe-rebuild/iu,
    );
  });

  it("leaves a stale receipt after an abandoned or crashed active lifetime", () => {
    const dbPath = createReadyFamily();
    const lease = track(api().acquireNormalLadybugFamily(dbPath, DRIVER));
    writeFileSync(dbPath, "mutated-before-crash", "utf8");
    api().abandonLadybugFamily(lease);
    openLeases.delete(lease);

    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /closed family digest mismatch[\s\S]*--safe-rebuild/iu,
    );
  });

  it("reclaims a well-formed lock whose owner process is stale", () => {
    const dbPath = freshPath();
    const lockPath = api().getLadybugFamilyLockPath(dbPath);
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        nonce: "a".repeat(64),
      }) + "\n",
      "utf8",
    );

    const lease = track(api().acquireNormalLadybugFamily(dbPath, DRIVER));
    assert.equal(existsSync(lockPath), true);
    api().abandonLadybugFamily(lease);
    openLeases.delete(lease);
    assert.equal(existsSync(lockPath), false);
  });

  it("rejects oversized, malformed, and symlink lineage markers", (t) => {
    const dbPath = createReadyFamily();
    const markerPath = api().getLadybugLineageMarkerPath(dbPath);

    writeFileSync(markerPath, "x".repeat(16 * 1024 + 1), "utf8");
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /lineage marker exceeds 16384 bytes/iu,
    );
    writeFileSync(markerPath, "{not-json", "utf8");
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /lineage marker is malformed/iu,
    );

    rmSync(markerPath, { force: true });
    const target = join(testRoot, "marker-target.json");
    writeFileSync(target, "{}", "utf8");
    try {
      symlinkSync(target, markerPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation is unavailable on this Windows host");
        return;
      }
      throw error;
    }
    assert.throws(
      () => api().acquireNormalLadybugFamily(dbPath, DRIVER),
      /lineage marker must be a regular non-symlink file/iu,
    );
  });

  it("binds a safe rebuild reopen to the same closed identity and digest", () => {
    const dbPath = freshPath();
    const lease = track(api().reserveSafeRebuildLadybugFamily(dbPath, DRIVER));
    writeFileSync(dbPath, "validated-candidate", "utf8");
    api().sealSafeRebuildFamilyForReopen(lease);
    api().verifySafeRebuildFamilyBeforeReopen(lease);

    api().finalizeSafeRebuildLadybugFamily(lease);
    openLeases.delete(lease);
    assert.equal(existsSync(api().getLadybugLineageMarkerPath(dbPath)), true);
  });

  it("refuses safe-rebuild publication when the target changes after validation", () => {
    const dbPath = freshPath();
    const lease = track(api().reserveSafeRebuildLadybugFamily(dbPath, DRIVER));
    writeFileSync(dbPath, "validated-candidate", "utf8");
    api().sealSafeRebuildFamilyForReopen(lease);
    api().verifySafeRebuildFamilyBeforeReopen(lease);

    assert.throws(
      () =>
        api().finalizeSafeRebuildLadybugFamily(lease, () => {
          renameSync(dbPath, dbPath + ".validated");
          writeFileSync(dbPath, "replacement-after-validation", "utf8");
        }),
      /changed after validation/iu,
    );
    openLeases.delete(lease);
    assert.equal(existsSync(api().getLadybugLineageMarkerPath(dbPath)), false);
  });

  it("does not expose the old generic bypass and marker writer", () => {
    assert.equal(api().writeLadybugLineageMarker, undefined);
    assert.equal(api().verifyLadybugLineageBeforeOpen, undefined);
    assert.equal(api().reserveFreshLadybugPrimary, undefined);
  });
});
