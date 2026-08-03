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

  it("retains failed lock initialization cleanup for explicit retry", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-lock-init-"));
    const dbPath = join(root, "graph.lbug");
    const writeFailure = new Error("lock-write-failure-sentinel");
    const unlinkFailure = new Error("lock-unlink-failure-sentinel");
    let failWrite = true;
    let failUnlink = true;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        writeFileSync(path: fs.PathOrFileDescriptor, ...args: unknown[]): void {
          if (failWrite && typeof path === "number") {
            failWrite = false;
            throw writeFailure;
          }
          Reflect.apply(fs.writeFileSync, fs, [path, ...args]);
        },
        unlinkSync(path: fs.PathLike): void {
          if (failUnlink && String(path).endsWith(".sdl-family.lock")) {
            throw unlinkFailure;
          }
          fs.unlinkSync(path);
        },
      },
    });
    const lineage = (await import(
      `../../dist/db/ladybug-lineage.js?init-cleanup=${String(Date.now())}`
    )) as typeof import("../../dist/db/ladybug-lineage.js") & {
      hasPendingLadybugFamilyLeaseCleanup(): boolean;
      retryPendingLadybugFamilyLeaseCleanup(): void;
    };

    try {
      let thrown: unknown;
      assert.throws(
        () =>
          lineage.acquireNormalLadybugFamily(dbPath, {
            version: "test",
            storageVersion: "1",
          }),
        (error) => {
          thrown = error;
          return true;
        },
      );
      assert.ok(thrown instanceof AggregateError);
      assert.deepEqual(thrown.errors, [writeFailure, unlinkFailure]);
      assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), true);
      assert.throws(
        () =>
          lineage.acquireNormalLadybugFamily(join(root, "other.lbug"), {
            version: "test",
            storageVersion: "1",
          }),
        /cleanup is pending/iu,
      );

      failUnlink = false;
      assert.doesNotThrow(() =>
        lineage.retryPendingLadybugFamilyLeaseCleanup(),
      );
      assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), false);
      assert.equal(fs.existsSync(dbPath + ".sdl-family.lock"), false);
    } finally {
      failUnlink = false;
      if (lineage.hasPendingLadybugFamilyLeaseCleanup?.()) {
        lineage.retryPendingLadybugFamilyLeaseCleanup();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves acquisition and failed release errors for cleanup retry", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-lock-acquire-"));
    const dbPath = join(root, "graph.lbug");
    const unlinkFailure = new Error("guarded-unlink-failure-sentinel");
    let failUnlink = true;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        openSync(path: fs.PathLike, ...args: unknown[]): number {
          if (String(path).replaceAll("\\", "/") === dbPath.replaceAll("\\", "/")) {
            throw Object.assign(new Error("reservation-race-sentinel"), {
              code: "EEXIST",
            });
          }
          return Reflect.apply(fs.openSync, fs, [path, ...args]) as number;
        },
        unlinkSync(path: fs.PathLike): void {
          if (failUnlink && String(path).endsWith(".sdl-family.lock")) {
            throw unlinkFailure;
          }
          fs.unlinkSync(path);
        },
      },
    });
    const lineage = (await import(
      `../../dist/db/ladybug-lineage.js?acquire-cleanup=${String(Date.now())}`
    )) as typeof import("../../dist/db/ladybug-lineage.js") & {
      hasPendingLadybugFamilyLeaseCleanup(): boolean;
      retryPendingLadybugFamilyLeaseCleanup(): void;
    };

    try {
      let thrown: unknown;
      assert.throws(
        () =>
          lineage.acquireNormalLadybugFamily(dbPath, {
            version: "test",
            storageVersion: "1",
          }),
        (error) => {
          thrown = error;
          return true;
        },
      );
      assert.ok(thrown instanceof AggregateError);
      assert.equal(thrown.errors.length, 2);
      assert.match(String(thrown.errors[0]), /primary database appeared/iu);
      assert.equal(thrown.errors[1], unlinkFailure);
      assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), true);

      failUnlink = false;
      lineage.retryPendingLadybugFamilyLeaseCleanup();
      assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), false);
    } finally {
      failUnlink = false;
      if (lineage.hasPendingLadybugFamilyLeaseCleanup?.()) {
        lineage.retryPendingLadybugFamilyLeaseCleanup();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves finalization failures when lock cleanup also fails", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-finalize-cleanup-"));
    const unlinkFailure = new Error("finalize-unlink-failure-sentinel");
    let failUnlink = true;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        unlinkSync(path: fs.PathLike): void {
          if (failUnlink && String(path).endsWith(".sdl-family.lock")) {
            throw unlinkFailure;
          }
          fs.unlinkSync(path);
        },
      },
    });
    const lineage = await import(
      `../../dist/db/ladybug-lineage.js?finalize-cleanup=${String(Date.now())}`
    );

    try {
      const normalPath = join(root, "normal.lbug");
      const normalLease = lineage.acquireNormalLadybugFamily(normalPath, {
        version: "test",
        storageVersion: "1",
      });
      rmSync(normalPath, { force: true });

      let normalError: unknown;
      assert.throws(
        () => lineage.finalizeNormalLadybugFamilyClose(normalLease),
        (error) => {
          normalError = error;
          return true;
        },
      );
      assert.ok(normalError instanceof AggregateError);
      assert.match(String(normalError.errors[0]), /primary database file is missing/iu);
      assert.equal(normalError.errors[1], unlinkFailure);
      assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), true);
      failUnlink = false;
      lineage.retryPendingLadybugFamilyLeaseCleanup();

      const safePath = join(root, "safe.lbug");
      const safeLease = lineage.reserveSafeRebuildLadybugFamily(safePath, {
        version: "test",
        storageVersion: "1",
      });
      lineage.sealSafeRebuildFamilyForReopen(safeLease);
      const publicationFailure = new Error("publication-failure-sentinel");
      failUnlink = true;

      let safeError: unknown;
      assert.throws(
        () =>
          lineage.finalizeSafeRebuildLadybugFamily(safeLease, () => {
            throw publicationFailure;
          }),
        (error) => {
          safeError = error;
          return true;
        },
      );
      assert.ok(safeError instanceof AggregateError);
      assert.deepEqual(safeError.errors, [publicationFailure, unlinkFailure]);
      assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), true);
      failUnlink = false;
      lineage.retryPendingLadybugFamilyLeaseCleanup();
    } finally {
      failUnlink = false;
      if (lineage.hasPendingLadybugFamilyLeaseCleanup()) {
        lineage.retryPendingLadybugFamilyLeaseCleanup();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries descriptor-only cleanup without touching a lost lock path", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-ladybug-detached-lock-"));
    const descriptorCloseFailure = new Error("descriptor-close-failure-sentinel");
    let failDescriptorClose = false;
    t.mock.module("node:fs", {
      namedExports: {
        ...fs,
        closeSync(descriptor: number): void {
          if (failDescriptorClose) {
            failDescriptorClose = false;
            throw descriptorCloseFailure;
          }
          fs.closeSync(descriptor);
        },
      },
    });
    const lineage = await import(
      `../../dist/db/ladybug-lineage.js?detached-cleanup=${String(Date.now())}`
    );

    try {
      for (const mode of ["missing", "replacement"] as const) {
        const dbPath = join(root, mode + ".lbug");
        const lease = lineage.acquireNormalLadybugFamily(dbPath, {
          version: "test",
          storageVersion: "1",
        });
        const lockPath = lineage.getLadybugFamilyLockPath(dbPath);
        rmSync(lockPath, { force: true });
        const replacement =
          JSON.stringify({
            version: 1,
            pid: process.pid,
            nonce: "b".repeat(64),
          }) + "\n";
        if (mode === "replacement") {
          writeFileSync(lockPath, replacement, "utf8");
        }
        failDescriptorClose = true;

        let releaseError: unknown;
        assert.throws(
          () => lineage.abandonLadybugFamily(lease),
          (error) => {
            releaseError = error;
            return true;
          },
        );
        assert.ok(releaseError instanceof AggregateError);
        assert.ok(releaseError.errors.includes(descriptorCloseFailure));
        assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), true);

        assert.doesNotThrow(() =>
          lineage.retryPendingLadybugFamilyLeaseCleanup(),
        );
        assert.equal(lineage.hasPendingLadybugFamilyLeaseCleanup(), false);
        if (mode === "replacement") {
          assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
          rmSync(lockPath, { force: true });
        } else {
          assert.equal(fs.existsSync(lockPath), false);
        }
      }
    } finally {
      failDescriptorClose = false;
      if (lineage.hasPendingLadybugFamilyLeaseCleanup()) {
        lineage.retryPendingLadybugFamilyLeaseCleanup();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
