import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { setupHttpTransport } from "../../dist/cli/transport/http.js";
import type { StartupReadinessSnapshot } from "../../dist/startup/readiness.js";

async function withHealthServer(
  snapshot: StartupReadinessSnapshot,
  checkDatabaseHealth: () => Promise<boolean>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-http-readiness-"));
  const server = await setupHttpTransport(
    "127.0.0.1",
    0,
    join(tempDir, "unused.lbug"),
    {
      getStartupReadiness: () => snapshot,
      checkDatabaseHealth,
    },
  );

  try {
    await run(`http://127.0.0.1:${server.port}/health`);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("HTTP health readiness", () => {
  it("returns 200 only when database liveness and startup readiness pass", async () => {
    await withHealthServer(
      {
        state: "ready",
        reason: null,
        watchers: { expected: 2, ready: 2 },
      },
      async () => true,
      async (url) => {
        const response = await fetch(url);
        const body = (await response.json()) as Record<string, unknown>;

        assert.equal(response.status, 200);
        assert.equal(body.status, "ok");
        assert.deepEqual(body.readiness, {
          state: "ready",
          reason: null,
          watchers: { expected: 2, ready: 2 },
        });
      },
    );
  });

  it("returns 503 while watchers are degraded even when the database is live", async () => {
    await withHealthServer(
      {
        state: "degraded",
        reason: "watcher_start_failed",
        watchers: { expected: 2, ready: 1 },
      },
      async () => true,
      async (url) => {
        const response = await fetch(url);
        const body = (await response.json()) as Record<string, unknown>;

        assert.equal(response.status, 503);
        assert.equal(body.status, "unhealthy");
        assert.deepEqual(body.readiness, {
          state: "degraded",
          reason: "watcher_start_failed",
          watchers: { expected: 2, ready: 1 },
        });
      },
    );
  });

  it("returns 503 when database liveness fails despite ready watchers", async () => {
    await withHealthServer(
      {
        state: "ready",
        reason: null,
        watchers: { expected: 0, ready: 0 },
      },
      async () => false,
      async (url) => {
        const response = await fetch(url);
        assert.equal(response.status, 503);
      },
    );
  });
});
