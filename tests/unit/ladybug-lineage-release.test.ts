import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("Ladybug lineage file boundaries", { concurrency: 1 }, () => {
  it("rejects a non-regular control path before opening it", async (t) => {
    const virtualFifo = join(tmpdir(), "sdl-ladybug-virtual-fifo");
    let opened = false;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        lstatSync(path: fs.PathLike, ...args: unknown[]): fs.Stats {
          if (String(path) === virtualFifo) {
            return {
              isFile: () => false,
              isSymbolicLink: () => false,
            } as fs.Stats;
          }
          return Reflect.apply(fs.lstatSync, fs, [path, ...args]) as fs.Stats;
        },
        openSync(path: fs.PathLike, ...args: unknown[]): number {
          if (String(path) === virtualFifo) {
            opened = true;
            throw new Error("open-called-sentinel");
          }
          return Reflect.apply(fs.openSync, fs, [path, ...args]) as number;
        },
      },
    });
    const { readBoundedLadybugControlFile } = await import(
      `../../dist/db/ladybug-family-files.js?pre-open=${String(Date.now())}`
    );

    assert.throws(
      () => readBoundedLadybugControlFile(virtualFifo, "control fixture"),
      /regular non-symlink file/iu,
    );
    assert.equal(opened, false);
  });

  it("retains lock ownership when unlink fails so release can be retried", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-lock-release-"));
    const dbPath = join(root, "graph.lbug");
    const unlinkFailure = new Error("unlink-failure-sentinel");
    let failLockUnlink = true;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        unlinkSync(path: fs.PathLike): void {
          if (failLockUnlink && String(path).endsWith(".sdl-family.lock")) {
            failLockUnlink = false;
            throw unlinkFailure;
          }
          fs.unlinkSync(path);
        },
      },
    });
    const lineage = await import(
      `../../dist/db/ladybug-lineage.js?unlink-retry=${String(Date.now())}`
    );
    const lease = lineage.acquireNormalLadybugFamily(dbPath, {
      version: "test",
      storageVersion: "1",
    });

    try {
      assert.throws(
        () => lineage.abandonLadybugFamily(lease),
        (error) => error === unlinkFailure,
      );
      assert.equal(fs.existsSync(dbPath + ".sdl-family.lock"), true);
      assert.doesNotThrow(() => lineage.abandonLadybugFamily(lease));
      assert.equal(fs.existsSync(dbPath + ".sdl-family.lock"), false);
    } finally {
      if (!lease.released) {
        failLockUnlink = false;
        lineage.abandonLadybugFamily(lease);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
