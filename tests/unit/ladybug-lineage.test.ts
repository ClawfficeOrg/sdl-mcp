import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";

interface LineageModule {
  getLadybugLineageMarkerPath(dbPath: string): string;
  verifyLadybugLineageBeforeOpen(
    dbPath: string,
    driver: { version: string; storageVersion: string },
  ): "fresh" | "ready";
  reserveFreshLadybugPrimary(dbPath: string): void;
  writeLadybugLineageMarker(
    dbPath: string,
    driver: { version: string; storageVersion: string },
  ): void;
}

const DRIVER = { version: "0.19.0-test", storageVersion: "43" };
let lineage: LineageModule | undefined;
let testRoot = "";

before(async () => {
  try {
    lineage = (await import(
      "../../dist/db/ladybug-lineage.js"
    )) as LineageModule;
  } catch {
    lineage = undefined;
  }
});

afterEach(() => {
  if (testRoot && existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
  testRoot = "";
});

function requireLineage(): LineageModule {
  assert.ok(lineage, "Ladybug lineage module must exist");
  return lineage;
}

function createPrimary(name = "graph.lbug"): string {
  testRoot = mkdtempSync(join(tmpdir(), "sdl-ladybug-lineage-"));
  const dbPath = join(testRoot, name);
  writeFileSync(dbPath, "primary", "utf8");
  return dbPath;
}

describe("Ladybug ready lineage marker", () => {
  it("allows a nonexistent database path", () => {
    const api = requireLineage();
    testRoot = mkdtempSync(join(tmpdir(), "sdl-ladybug-lineage-"));
    const dbPath = join(testRoot, "fresh.lbug");

    assert.equal(api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER), "fresh");
  });

  it("atomically writes a sibling receipt bound to path, file identity, and driver", () => {
    const api = requireLineage();
    const dbPath = createPrimary();
    const markerPath = api.getLadybugLineageMarkerPath(dbPath);

    api.writeLadybugLineageMarker(dbPath, DRIVER);

    const receipt = JSON.parse(readFileSync(markerPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(receipt, {
      receiptKind: "sdl-mcp-ladybug-ready",
      receiptVersion: 1,
      canonicalDbPath: receipt.canonicalDbPath,
      primaryFile: receipt.primaryFile,
      driverVersion: DRIVER.version,
      storageVersion: DRIVER.storageVersion,
    });
    assert.equal(typeof receipt.canonicalDbPath, "string");
    assert.match(String(receipt.canonicalDbPath), /graph\.lbug$/iu);
    assert.match(JSON.stringify(receipt.primaryFile), /"dev":"\d+","ino":"\d+"/u);
    assert.equal(api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER), "ready");
    assert.deepEqual(
      readdirSync(testRoot).filter((name) => name.includes(".tmp-")),
      [],
      "atomic write must not leave a temporary receipt",
    );
  });

  it("rejects a missing or malformed receipt with safe-rebuild guidance", () => {
    const api = requireLineage();
    const dbPath = createPrimary();
    const markerPath = api.getLadybugLineageMarkerPath(dbPath);

    assert.throws(
      () => api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER),
      /lineage marker is missing[\s\S]*--safe-rebuild/iu,
    );

    writeFileSync(markerPath, "{not-json", "utf8");
    assert.throws(
      () => api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER),
      /lineage marker is malformed[\s\S]*--safe-rebuild/iu,
    );
  });

  for (const mismatch of [
    {
      name: "receipt kind",
      mutate: (receipt: Record<string, unknown>) => {
        receipt.receiptKind = "other";
      },
    },
    {
      name: "receipt version",
      mutate: (receipt: Record<string, unknown>) => {
        receipt.receiptVersion = 2;
      },
    },
    {
      name: "canonical path",
      mutate: (receipt: Record<string, unknown>) => {
        receipt.canonicalDbPath = "C:/other/graph.lbug";
      },
    },
    {
      name: "primary file identity",
      mutate: (receipt: Record<string, unknown>) => {
        receipt.primaryFile = { dev: "0", ino: "0" };
      },
    },
    {
      name: "driver version",
      mutate: (receipt: Record<string, unknown>) => {
        receipt.driverVersion = "0.18.1";
      },
    },
    {
      name: "storage version",
      mutate: (receipt: Record<string, unknown>) => {
        receipt.storageVersion = "40";
      },
    },
  ]) {
    it("rejects a mismatched " + mismatch.name, () => {
      const api = requireLineage();
      const dbPath = createPrimary();
      const markerPath = api.getLadybugLineageMarkerPath(dbPath);
      api.writeLadybugLineageMarker(dbPath, DRIVER);
      const receipt = JSON.parse(readFileSync(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      mismatch.mutate(receipt);
      writeFileSync(markerPath, JSON.stringify(receipt) + "\n", "utf8");

      assert.throws(
        () => api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER),
        new RegExp(mismatch.name + " mismatch[\\s\\S]*--safe-rebuild", "iu"),
      );
    });
  }

  it("rejects a stale marker whose primary file is absent", () => {
    const api = requireLineage();
    const dbPath = createPrimary();
    api.writeLadybugLineageMarker(dbPath, DRIVER);
    renameSync(dbPath, dbPath + ".old");

    assert.throws(
      () => api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER),
      /lineage marker exists without its primary[\s\S]*--safe-rebuild/iu,
    );
  });

  it("atomically rejects a primary that appears after the fresh check", () => {
    const api = requireLineage();
    testRoot = mkdtempSync(join(tmpdir(), "sdl-ladybug-lineage-"));
    const dbPath = join(testRoot, "fresh.lbug");
    assert.equal(api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER), "fresh");
    writeFileSync(dbPath, "appeared-after-check", "utf8");

    assert.throws(
      () => api.reserveFreshLadybugPrimary(dbPath),
      /primary database appeared during fresh initialization[\s\S]*--safe-rebuild/iu,
    );
  });

  it("rejects a replaced primary file", () => {
    const api = requireLineage();
    const dbPath = createPrimary();
    api.writeLadybugLineageMarker(dbPath, DRIVER);
    renameSync(dbPath, dbPath + ".original");
    writeFileSync(dbPath, "replacement", "utf8");

    assert.throws(
      () => api.verifyLadybugLineageBeforeOpen(dbPath, DRIVER),
      /primary file identity mismatch[\s\S]*--safe-rebuild/iu,
    );
  });
});
