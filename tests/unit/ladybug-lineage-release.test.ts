import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  it("allocates bounded config reads from the validated file size", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-config-read-"));
    const configPath = join(root, "config.json");
    const configBytes = Buffer.from(
      JSON.stringify({ repos: [], padding: "x".repeat(20 * 1024) }),
    );
    writeFileSync(configPath, configBytes);
    const originalAllocUnsafe = Buffer.allocUnsafe;
    let allocatedBytes = -1;
    t.mock.method(Buffer, "allocUnsafe", (size: number) => {
      allocatedBytes = size;
      return originalAllocUnsafe(size);
    });
    const { readBoundedLadybugConfigFile } = await import(
      "../../dist/db/ladybug-family-files.js?bounded-config=" +
        String(Date.now())
    );

    try {
      assert.deepEqual(
        readBoundedLadybugConfigFile(configPath, "qualification config"),
        configBytes,
      );
      assert.equal(allocatedBytes, statSync(configPath).size);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the original open error when post-failure classification races", async (t) => {
    const virtualPath = join(tmpdir(), "sdl-ladybug-open-race");
    const openFailure = new Error("open-failure-sentinel");
    const classificationFailure = new Error(
      "regular non-symlink file classification raced",
    );
    let lstatCalls = 0;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        lstatSync(path: fs.PathLike): fs.Stats {
          if (String(path) !== virtualPath) return fs.lstatSync(path);
          lstatCalls += 1;
          if (lstatCalls > 1) throw classificationFailure;
          return {
            dev: 1,
            ino: 2,
            isFile: () => true,
            isSymbolicLink: () => false,
          } as fs.Stats;
        },
        openSync(path: fs.PathLike): number {
          if (String(path) === virtualPath) throw openFailure;
          return fs.openSync(path, "r");
        },
      },
    });
    const { readBoundedLadybugControlFile } = await import(
      "../../dist/db/ladybug-family-files.js?open-race=" +
        String(Date.now())
    );

    assert.throws(
      () => readBoundedLadybugControlFile(virtualPath, "control fixture"),
      (error) => error === openFailure,
    );
  });

  it("uses nonblocking no-follow flags when the platform exposes them", async (t) => {
    const virtualPath = join(tmpdir(), "sdl-ladybug-safe-open");
    const openFailure = new Error("safe-open-sentinel");
    const noFollow = 0x20_0000;
    const nonblock = 0x4_0000;
    let openedFlags = -1;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        constants: {
          ...fs.constants,
          O_NOFOLLOW: noFollow,
          O_NONBLOCK: nonblock,
        },
        lstatSync(path: fs.PathLike): fs.Stats {
          if (String(path) !== virtualPath) return fs.lstatSync(path);
          return {
            dev: 1,
            ino: 2,
            isFile: () => true,
            isSymbolicLink: () => false,
          } as fs.Stats;
        },
        openSync(path: fs.PathLike, flags: number): number {
          if (String(path) === virtualPath) {
            openedFlags = flags;
            throw openFailure;
          }
          return fs.openSync(path, flags);
        },
      },
    });
    const { readBoundedLadybugControlFile } = await import(
      "../../dist/db/ladybug-family-files.js?safe-open=" +
        String(Date.now())
    );

    assert.throws(
      () => readBoundedLadybugControlFile(virtualPath, "control fixture"),
      (error) => error === openFailure,
    );
    assert.equal(openedFlags & noFollow, noFollow);
    assert.equal(openedFlags & nonblock, nonblock);
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
