import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setupHttpTransport } from "../../dist/cli/transport/http.js";

describe("HTTP REST readiness admission", () => {
  it("rejects every direct REST mutation route while degraded", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sdl-http-rest-readiness-"));
    const server = await setupHttpTransport(
      "127.0.0.1",
      0,
      join(tempDir, "unused.lbug"),
      {
        checkDatabaseHealth: async () => true,
        getStartupReadiness: () => ({
          state: "degraded",
          reason: "watcher_start_failed",
          watchers: { expected: 2, ready: 1 },
        }),
      },
      { enabled: false },
    );

    try {
      const routes = [
        "/api/config",
        "/api/repo/test/buffer",
        "/api/repo/test/checkpoint",
        "/api/repo/test/reindex",
        "/api/repo/test/reindex-stream",
      ];

      for (const route of routes) {
        const response = await fetch(
          `http://127.0.0.1:${server.port}${route}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        );
        const body = (await response.json()) as {
          error?: { code?: string };
        };

        assert.equal(response.status, 503, route);
        assert.equal(body.error?.code, "STORAGE_NOT_WRITE_READY", route);
      }
    } finally {
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
