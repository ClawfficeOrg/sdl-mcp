import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  formatIndexStartupLines,
} from "../../dist/cli/commands/index.js";
import {
  parseIndexOptions,
} from "../../dist/cli/argParsing.js";
import type { CLIOptions } from "../../dist/cli/types.js";
import {
  validateSafeRebuildRequest,
} from "../../dist/cli/commands/index-safe-rebuild.js";

describe("CLI index command", () => {
  const global: CLIOptions = {};

  describe("argument parsing", () => {
    it("defaults to no watch, no force, no repoId", () => {
      const options = parseIndexOptions([], global, {});
      assert.strictEqual(options.watch, undefined);
      assert.strictEqual(options.force, undefined);
      assert.strictEqual(options.repoId, undefined);
    });

    it("parses --watch from args", () => {
      const options = parseIndexOptions(["--watch"], global, {});
      assert.strictEqual(options.watch, true);
    });

    it("parses -w short form for watch", () => {
      const options = parseIndexOptions(["-w"], global, {});
      assert.strictEqual(options.watch, true);
    });

    it("parses --force from args", () => {
      const options = parseIndexOptions(["--force"], global, {});
      assert.strictEqual(options.force, true);
    });

    it("parses -f short form for force", () => {
      const options = parseIndexOptions(["-f"], global, {});
      assert.strictEqual(options.force, true);
    });

    it("parses --repo-id from args", () => {
      const options = parseIndexOptions(
        ["--repo-id", "my-repo"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("throws when --repo-id has no value", () => {
      assert.throws(
        () => parseIndexOptions(["--repo-id"], global, {}),
        /--repo-id requires a value/,
      );
    });

    it("prefers parsed values over positional args", () => {
      const options = parseIndexOptions([], global, {
        watch: true,
        force: true,
        "repo-id": "from-values",
      });
      assert.strictEqual(options.watch, true);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.repoId, "from-values");
    });

    it("combines args and parsed values", () => {
      const options = parseIndexOptions(["--watch"], global, {
        "repo-id": "combined-repo",
      });
      assert.strictEqual(options.watch, true);
      assert.strictEqual(options.repoId, "combined-repo");
    });

    it("parses --safe-rebuild from args and parsed values", () => {
      assert.strictEqual(
        parseIndexOptions(
          ["--safe-rebuild", "F:\\graphs\\candidate.lbug"],
          global,
          {},
        ).safeRebuildPath,
        "F:\\graphs\\candidate.lbug",
      );
      assert.strictEqual(
        parseIndexOptions([], global, {
          "safe-rebuild": "F:\\graphs\\from-values.lbug",
        }).safeRebuildPath,
        "F:\\graphs\\from-values.lbug",
      );
    });

    it("throws when --safe-rebuild has no value", () => {
      assert.throws(
        () => parseIndexOptions(["--safe-rebuild"], global, {}),
        /--safe-rebuild requires a value/,
      );
    });

    it("inherits global config option", () => {
      const g: CLIOptions = { config: "/path/to/config.json" };
      const options = parseIndexOptions([], g, {});
      assert.strictEqual(options.config, "/path/to/config.json");
    });
  });

  describe("startup output", () => {
    it("prints useful pre-open context before graph DB initialization", () => {
      assert.deepStrictEqual(
        formatIndexStartupLines({
          repoCount: 1,
          runtimeIdentity: {
            version: "0.11.4",
            node: "v24.14.0",
            modulePath: "C:\\pkg\\sdl-mcp\\dist\\cli\\commands\\index.js",
          },
          graphDbPath: "F:\\Claude\\sdl-mcp\\sdl-mcp-graph.lbug",
        }),
        [
          "Indexing 1 repo(s)...",
          "Runtime: sdl-mcp 0.11.4; node=v24.14.0; module=C:/pkg/sdl-mcp/dist/cli/commands/index.js",
          "Graph DB: F:/Claude/sdl-mcp/sdl-mcp-graph.lbug",
        ],
      );
    });
  });

  describe("safe rebuild preflight", () => {
    const activePath = resolve("test-output", "active-graph.lbug");
    const candidatePath = resolve("test-output", "candidate-graph.lbug");

    function validate(
      overrides: Partial<Parameters<typeof validateSafeRebuildRequest>[0]> = {},
    ): ReturnType<typeof validateSafeRebuildRequest> {
      return validateSafeRebuildRequest({
        options: {
          force: true,
          safeRebuildPath: candidatePath,
        },
        activeGraphDbPath: activePath,
        findOwner: () => null,
        pathExists: () => false,
        ...overrides,
      });
    }

    it("accepts a stopped-owner absolute non-existent candidate", () => {
      const result = validate();
      assert.strictEqual(result.targetGraphDbPath, candidatePath);
      assert.match(result.externalOwnerWarning, /external LadybugDB owner/i);
    });

    it("rejects a leftover lineage marker in the candidate family", () => {
      assert.throws(
        () =>
          validate({
            pathExists: (path) => path.endsWith(".sdl-lineage.json"),
          }),
        /candidate-graph\.lbug\.sdl-lineage\.json/iu,
      );
    });

    it("requires force and rejects watch or repository scope", () => {
      assert.throws(
        () => validate({ options: { safeRebuildPath: candidatePath } }),
        /requires --force/,
      );
      assert.throws(
        () =>
          validate({
            options: {
              force: true,
              watch: true,
              safeRebuildPath: candidatePath,
            },
          }),
        /cannot be combined with --watch/,
      );
      assert.throws(
        () =>
          validate({
            options: {
              force: true,
              repoId: "one-repo",
              safeRebuildPath: candidatePath,
            },
          }),
        /cannot be combined with --repo-id/,
      );
    });

    it("rejects relative, active, existing, and live-owner targets", () => {
      assert.throws(
        () =>
          validate({
            options: {
              force: true,
              safeRebuildPath: "relative-candidate.lbug",
            },
          }),
        /absolute path/,
      );
      assert.throws(
        () =>
          validate({
            options: {
              force: true,
              safeRebuildPath: activePath,
            },
          }),
        /different from the active graph database/,
      );
      assert.throws(
        () => validate({ pathExists: () => true }),
        /already exists/,
      );
      assert.throws(
        () =>
          validate({
            findOwner: () => ({
              pid: 4242,
              transport: "http",
              port: 3000,
              startedAt: new Date(0).toISOString(),
            }),
          }),
        /PID 4242/,
      );
    });
  });

  describe("delegation decision", () => {
    it("allows HTTP delegation without an auth token when HTTP auth is disabled", async () => {
      const { canDelegateIndexToServer } = await import(
        "../../dist/cli/commands/index.js"
      );

      assert.strictEqual(
        canDelegateIndexToServer(
          {
            pid: process.pid,
            transport: "http",
            port: 3000,
            startedAt: new Date().toISOString(),
          },
          false,
        ),
        true,
      );
    });

    it("requires an auth token when HTTP auth is enabled", async () => {
      const { canDelegateIndexToServer } = await import(
        "../../dist/cli/commands/index.js"
      );
      const server = {
        pid: process.pid,
        transport: "http" as const,
        port: 3000,
        startedAt: new Date().toISOString(),
      };

      assert.strictEqual(canDelegateIndexToServer(server, true), false);
      assert.strictEqual(
        canDelegateIndexToServer({ ...server, authToken: "secret" }, true),
        true,
      );
    });

    it("rejects non-HTTP pidfiles and HTTP pidfiles without a port", async () => {
      const { canDelegateIndexToServer } = await import(
        "../../dist/cli/commands/index.js"
      );

      assert.strictEqual(
        canDelegateIndexToServer(
          {
            pid: process.pid,
            transport: "stdio",
            startedAt: new Date().toISOString(),
          },
          false,
        ),
        false,
      );
      assert.strictEqual(
        canDelegateIndexToServer(
          {
            pid: process.pid,
            transport: "http",
            startedAt: new Date().toISOString(),
          },
          false,
        ),
        false,
      );
    });
  });

  describe("one-shot lifecycle", () => {
    it("starts the command wall timer at the first executable line", () => {
      const source = readFileSync("src/cli/commands/index.ts", "utf-8");

      assert.match(
        source,
        /export async function indexCommand\([\s\S]*?\): Promise<void> \{\s*const commandWallStartedAt = Date\.now\(\);/,
      );
    });

    it("enables Jina HNSW deferral only for local one-shot commands with an effective full repo", async () => {
      const indexModule = await import("../../dist/cli/commands/index.js");
      const isEligible = (
        indexModule as typeof indexModule & {
          isJinaHnswDeferralEligible?: (params: {
            canDelegate: boolean;
            isOneShot: boolean;
            hasJinaHnswSpec: boolean;
            effectiveModes: ReadonlyMap<string, "full" | "incremental">;
          }) => boolean;
        }
      ).isJinaHnswDeferralEligible;

      assert.strictEqual(
        typeof isEligible,
        "function",
        "the command should expose its single eligibility decision for regression coverage",
      );

      const full = new Map([["repo", "full" as const]]);
      const incremental = new Map([["repo", "incremental" as const]]);
      const mixed = new Map([
        ["full-repo", "full" as const],
        ["incremental-repo", "incremental" as const],
      ]);
      const base = {
        canDelegate: false,
        isOneShot: true,
        hasJinaHnswSpec: true,
      };

      assert.strictEqual(isEligible!({ ...base, effectiveModes: full }), true);
      assert.strictEqual(
        isEligible!({ ...base, effectiveModes: incremental }),
        false,
      );
      assert.strictEqual(isEligible!({ ...base, effectiveModes: mixed }), true);
      assert.strictEqual(
        isEligible!({ ...base, canDelegate: true, effectiveModes: full }),
        false,
      );
      assert.strictEqual(
        isEligible!({ ...base, isOneShot: false, effectiveModes: full }),
        false,
      );
      assert.strictEqual(
        isEligible!({ ...base, hasJinaHnswSpec: false, effectiveModes: full }),
        false,
      );
    });

    describe("direct Jina HNSW cold-reopen lifecycle", () => {
      const spec = {
        model: "jina-embeddings-v2-base-code" as const,
        indexName: "configured_jina_hnsw",
        vectorProperty: "embeddingJinaCodeVec",
        dimension: 2,
        efc: 321,
      };
      const probe = {
        repoId: "full-a",
        symbolId: "probe",
        vector: [1, 0],
      };

      type LifecycleResult = typeof spec & {
        outcome: "created" | "validated-existing" | "skipped-empty";
        catalogMutated: boolean;
        probe: typeof probe | null;
        createMs: number;
        queryMs: number;
        checkpointMs: number;
      };
      type Lifecycle = (
        params: {
          config: never;
          configPath: string;
          spec: typeof spec;
          selectedFullRepoIds: readonly string[];
          requireAbsent: boolean;
        },
        dependencies: Record<string, unknown>,
      ) => Promise<LifecycleResult>;

      function result(
        outcome: LifecycleResult["outcome"],
      ): LifecycleResult {
        return {
          ...spec,
          outcome,
          catalogMutated: outcome === "created",
          probe: outcome === "skipped-empty" ? null : probe,
          createMs: outcome === "created" ? 2 : 0,
          queryMs: outcome === "validated-existing" ? 3 : 0,
          checkpointMs: outcome === "created" ? 5 : 0,
        };
      }

      async function loadLifecycle(): Promise<Lifecycle> {
        const indexModule = await import("../../dist/cli/commands/index.js");
        const lifecycle = (
          indexModule as typeof indexModule & {
            runDirectJinaHnswLifecycle?: Lifecycle;
          }
        ).runDirectJinaHnswLifecycle;
        assert.strictEqual(
          typeof lifecycle,
          "function",
          "the direct normal-family lifecycle should be exposed for focused tests",
        );
        return lifecycle!;
      }

      function messages(error: unknown): string[] {
        if (error instanceof AggregateError) {
          return [
            ...error.errors.flatMap(messages),
            ...(error.message ? [error.message] : []),
          ];
        }
        return [error instanceof Error ? error.message : String(error)];
      }

      function harness(
        outcome: LifecycleResult["outcome"],
        overrides: Record<string, unknown> = {},
      ) {
        const events: string[] = [];
        const initOptions: unknown[] = [];
        let openPath: string | null = "F:/normal/graph.lbug";
        let prepareCalls = 0;
        let validateCalls = 0;
        const dependencies = {
          shutdownDerivedRefreshQueue: async () => {
            events.push("queue:shutdown");
          },
          enableDerivedRefreshQueue: () => {
            events.push("queue:enable");
          },
          closeLadybugDb: async (options: { strict?: boolean }) => {
            assert.deepStrictEqual(options, { strict: true });
            events.push("db:close");
            openPath = null;
          },
          initGraphDb: async (
            _config: unknown,
            _configPath: string,
            options?: unknown,
          ) => {
            initOptions.push(options);
            events.push("db:init");
            openPath = "F:/normal/graph.lbug";
            return openPath;
          },
          getLadybugDbPath: () => openPath,
          prepareReopenedJinaHnsw: async (params: {
            selectedFullRepoIds: readonly string[];
            requireAbsent: boolean;
          }) => {
            prepareCalls++;
            events.push(
              `hnsw:prepare:${params.selectedFullRepoIds.join(",")}:${params.requireAbsent}`,
            );
            return result(outcome);
          },
          validateReopenedJinaHnsw: async () => {
            validateCalls++;
            events.push("hnsw:validate");
            return 7;
          },
          ...overrides,
        };
        return {
          dependencies,
          events,
          getOpenPath: () => openPath,
          setOpenPath: (value: string | null) => {
            openPath = value;
          },
          getPrepareCalls: () => prepareCalls,
          getValidateCalls: () => validateCalls,
          getInitOptions: () => initOptions,
        };
      }

      const params = {
        config: {} as never,
        configPath: "F:/normal/sdlmcp.config.json",
        spec,
        selectedFullRepoIds: ["full-a", "full-b"],
        requireAbsent: true,
      } as const;

      it("closes, cold-reopens, creates, cold-reopens, validates, and closes", async () => {
        const lifecycle = await loadLifecycle();
        const state = harness("created");

        const actual = await lifecycle(params, state.dependencies);

        assert.deepStrictEqual(state.events, [
          "queue:shutdown",
          "db:close",
          "db:init",
          "hnsw:prepare:full-a,full-b:true",
          "db:close",
          "db:init",
          "hnsw:validate",
          "db:close",
          "queue:enable",
        ]);
        assert.strictEqual(actual.outcome, "created");
        assert.strictEqual(actual.queryMs, 7);
        assert.strictEqual(state.getPrepareCalls(), 1);
        assert.strictEqual(state.getValidateCalls(), 1);
        assert.deepStrictEqual(state.getInitOptions(), [
          { deferSemanticVectorIndexes: true },
          { deferSemanticVectorIndexes: true },
        ]);
        assert.strictEqual(state.getOpenPath(), null);
      });

      it("validates an existing index on the first cold reopen without reopening twice", async () => {
        const lifecycle = await loadLifecycle();
        const state = harness("validated-existing");

        const actual = await lifecycle(params, state.dependencies);

        assert.deepStrictEqual(state.events, [
          "queue:shutdown",
          "db:close",
          "db:init",
          "hnsw:prepare:full-a,full-b:true",
          "db:close",
          "queue:enable",
        ]);
        assert.strictEqual(actual.outcome, "validated-existing");
        assert.strictEqual(state.getPrepareCalls(), 1);
        assert.strictEqual(
          state.getValidateCalls(),
          0,
          "shared preparation owns existing-index query validation",
        );
      });

      it("closes an empty family without a create or query-validation reopen", async () => {
        const lifecycle = await loadLifecycle();
        const state = harness("skipped-empty");

        const actual = await lifecycle(params, state.dependencies);

        assert.deepStrictEqual(state.events, [
          "queue:shutdown",
          "db:close",
          "db:init",
          "hnsw:prepare:full-a,full-b:true",
          "db:close",
          "queue:enable",
        ]);
        assert.strictEqual(actual.outcome, "skipped-empty");
        assert.strictEqual(state.getValidateCalls(), 0);
      });

      for (const [name, retainedPath] of [
        ["retained ownership", "F:/normal/graph.lbug"],
        ["closed native ownership", null],
      ] as const) {
        it(`does not reopen after the first strict close fails with ${name}`, async () => {
          const lifecycle = await loadLifecycle();
          const state = harness("created", {
            closeLadybugDb: async () => {
              state.events.push("db:close-failed");
              state.setOpenPath(retainedPath);
              throw new Error("injected close failure");
            },
          });

          const error = await lifecycle(params, state.dependencies).then(
            () => undefined,
            (caught) => caught,
          );

          assert.ok(error);
          assert.match(messages(error).join("\n"), /injected close failure/);
          assert.match(
            messages(error).join("\n"),
            retainedPath
              ? /ownership.*retained|retained.*ownership/i
              : /native ownership.*closed.*cleanup failed/i,
          );
          assert.deepStrictEqual(state.events, [
            "queue:shutdown",
            "db:close-failed",
            "queue:enable",
          ]);
        });
      }

      it("cleans up one partial reopen and preserves init then cleanup diagnostics", async () => {
        const lifecycle = await loadLifecycle();
        let closeCalls = 0;
        const state = harness("created", {
          closeLadybugDb: async () => {
            closeCalls++;
            if (closeCalls === 1) {
              state.events.push("db:close");
              state.setOpenPath(null);
              return;
            }
            state.events.push("db:partial-cleanup-failed");
            state.setOpenPath("F:/normal/poisoned.lbug");
            throw new Error("injected partial cleanup failure");
          },
          initGraphDb: async () => {
            state.events.push("db:init-partial-failed");
            state.setOpenPath("F:/normal/poisoned.lbug");
            throw new Error("injected init failure after open");
          },
        });

        const error = await lifecycle(params, state.dependencies).then(
          () => undefined,
          (caught) => caught,
        );

        assert.ok(error);
        const flattened = messages(error);
        assert.ok(
          flattened.findIndex((message) => /init failure/.test(message)) <
            flattened.findIndex((message) => /cleanup failure/.test(message)),
        );
        assert.match(flattened.join("\n"), /retained|poisoned/i);
        assert.deepStrictEqual(state.events, [
          "queue:shutdown",
          "db:close",
          "db:init-partial-failed",
          "db:partial-cleanup-failed",
          "queue:enable",
        ]);
        assert.strictEqual(closeCalls, 2);
      });

      for (const [name, overrides, expectedLastEvent] of [
        [
          "reopen",
          {
            initGraphDb: async () => {
              throw new Error("reopen failed");
            },
            getLadybugDbPath: () => null,
          },
          "db:close",
        ],
        [
          "checkpoint/create preparation",
          {
            prepareReopenedJinaHnsw: async () => {
              throw new Error("prepare failed");
            },
          },
          "db:close",
        ],
        [
          "post-create query validation",
          {
            validateReopenedJinaHnsw: async () => {
              throw new Error("query failed");
            },
          },
          "db:close",
        ],
      ] as const) {
        it(`rejects without completion after ${name} fails`, async () => {
          const lifecycle = await loadLifecycle();
          const state = harness("created", overrides);

          await assert.rejects(
            lifecycle(params, state.dependencies),
            /reopen failed|prepare failed|query failed/,
          );
          assert.strictEqual(state.events.at(-2), expectedLastEvent);
          assert.strictEqual(state.events.at(-1), "queue:enable");
        });
      }

      it("rejects a final strict close failure without retrying it", async () => {
        const lifecycle = await loadLifecycle();
        let closeCalls = 0;
        const state = harness("skipped-empty", {
          closeLadybugDb: async () => {
            closeCalls++;
            state.events.push(`db:close:${closeCalls}`);
            if (closeCalls === 1) {
              state.setOpenPath(null);
              return;
            }
            state.setOpenPath("F:/normal/graph.lbug");
            throw new Error("final close failed");
          },
        });

        await assert.rejects(
          lifecycle(params, state.dependencies),
          /final close failed|strict close/i,
        );
        assert.strictEqual(closeCalls, 2);
        assert.deepStrictEqual(state.events, [
          "queue:shutdown",
          "db:close:1",
          "db:init",
          "hnsw:prepare:full-a,full-b:true",
          "db:close:2",
          "queue:enable",
        ]);
      });

      it("passes every selected full repository to one shared preparation", async () => {
        const lifecycle = await loadLifecycle();
        const state = harness("validated-existing");

        await lifecycle(params, state.dependencies);

        assert.strictEqual(state.getPrepareCalls(), 1);
        assert.ok(
          state.events.includes("hnsw:prepare:full-a,full-b:true"),
        );
      });
    });

    it("preflights direct indexing before repository registration writes", () => {
      const source = readFileSync("src/cli/commands/index.ts", "utf-8");
      const directPathStart = source.indexOf(
        "// Direct indexing path (original behavior).",
      );
      const preflight = source.indexOf(
        "await assertIndexStoragePreflight(",
        directPathStart,
      );
      const repoWrite = source.indexOf(
        "await ladybugDb.upsertRepo(",
        directPathStart,
      );
      const indexCall = source.indexOf(
        "const stats: IndexResult = await dependencies.indexRepo(",
        directPathStart,
      );

      assert.ok(directPathStart >= 0, "direct CLI index path must exist");
      assert.ok(
        preflight > directPathStart && preflight < repoWrite,
        "storage preflight must run before the direct CLI writes Repo metadata",
      );
      assert.ok(
        repoWrite < indexCall,
        "repository registration must still precede the authoritative index call",
      );
    });

    it("cleans up direct indexing resources before reporting completion", () => {
      const source = readFileSync("src/cli/commands/index.ts", "utf-8");

      assert.match(
        source,
        /if \(!options\.watch && \(dbCleanupOwned \|\| derivedRefreshDisabled\)\) \{[\s\S]*?await cleanupOneShotIndexing\(/,
      );
      assert.match(
        source,
        /async function cleanupOneShotIndexing[\s\S]*?shutdownDerivedRefreshQueue\(\)[\s\S]*?closeLadybugDb\(\)/,
      );
    });

    it("forces process exit after successful one-shot index command", () => {
      const source = readFileSync("src/cli/index.ts", "utf-8");

      assert.match(
        source,
        /await indexCommand\(options\);\s*process\.exit\(0\);\s*return;/,
      );
    });

    it("legacy index-repo script closes resources and exits on success", () => {
      const source = readFileSync("scripts/index-repo.ts", "utf-8");

      assert.match(source, /await closeLadybugDb\(\);/);
      assert.match(source, /process\.exit\(0\);/);
    });
  });

  describe("command invocation", { concurrency: 1 }, () => {
    let tempDir: string;
    let originalSDLConfig: string | undefined;
    let originalSDLConfigPath: string | undefined;
    let originalExit: typeof process.exit;

    before(() => {
      tempDir = join(tmpdir(), `sdl-mcp-index-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });

      originalSDLConfig = process.env.SDL_CONFIG;
      originalSDLConfigPath = process.env.SDL_CONFIG_PATH;

      originalExit = process.exit;
    });

    function clearGraphPathEnvironment(): () => void {
      const previous = new Map(
        ["SDL_GRAPH_DB_PATH", "SDL_GRAPH_DB_DIR", "SDL_DB_PATH"].map(
          (name) => [name, process.env[name]] as const,
        ),
      );
      for (const name of previous.keys()) delete process.env[name];
      return () => {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      };
    }

    function emptyIndexResult() {
      return {
        versionId: "test-version",
        filesProcessed: 0,
        changedFiles: 0,
        removedFiles: 0,
        symbolsIndexed: 0,
        edgesCreated: 0,
        clustersComputed: 0,
        processesTraced: 0,
        durationMs: 1,
      };
    }

    async function assertDerivedQueueRestored(
      ladybugPath: string,
      repoId: string,
    ): Promise<void> {
      const ladybug = await import("../../dist/db/ladybug.js");
      const queue = await import("../../dist/indexer/derived-refresh-queue.js");
      let refreshCalls = 0;
      await ladybug.initLadybugDb(ladybugPath);
      queue._setDerivedRefreshHooksForTesting({
        refresh: async () => {
          refreshCalls += 1;
        },
      });
      try {
        queue.enqueueDerivedRefresh(repoId, "v1");
        await queue.waitForDerivedRefreshIdle(repoId, 5_000, 10);
        assert.strictEqual(refreshCalls, 1);
      } finally {
        queue._setDerivedRefreshHooksForTesting(null);
        queue.enableDerivedRefreshQueue();
        await ladybug.closeLadybugDb();
      }
    }

    after(() => {
      process.exit = originalExit;

      if (originalSDLConfig === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = originalSDLConfig;
      }
      if (originalSDLConfigPath === undefined) {
        delete process.env.SDL_CONFIG_PATH;
      } else {
        process.env.SDL_CONFIG_PATH = originalSDLConfigPath;
      }

      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it("rejects when repo-id is not found in config", async () => {
      const dir = join(tempDir, "notfound");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "real-repo", rootPath: tempDir }],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );

      let exitCode: number | undefined;
      let errorOutput = "";
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => {
        errorOutput += args.map(String).join(" ") + "\n";
      };
      console.log = () => {};

      process.exit = ((code: number) => {
        exitCode = code;
        throw new Error(`exit(${code})`);
      }) as typeof process.exit;

      let thrownError: unknown;
      try {
        await indexCommand({ config: configPath, repoId: "nonexistent-repo" });
      } catch (e) {
        thrownError = e;
      } finally {
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
        const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
        await closeLadybugDb();
      }

      // The command should either exit(1) or throw for non-existent repo
      assert.ok(
        exitCode === 1 || thrownError !== undefined,
        "Should either exit(1) or throw for missing repo",
      );
      if (exitCode === 1) {
        assert.ok(
          errorOutput.includes("Repository not found") ||
            errorOutput.includes("nonexistent-repo"),
          `Should report repo not found, got: ${errorOutput}`,
        );
      }
    });

    it("rejects when no repositories are configured", async () => {
      const dir = join(tempDir, "norepos");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );

      let exitCode: number | undefined;
      const origError = console.error;
      const origLog = console.log;
      console.error = () => {};
      console.log = () => {};

      process.exit = ((code: number) => {
        exitCode = code;
        throw new Error(`exit(${code})`);
      }) as typeof process.exit;

      let thrownError: unknown;
      try {
        await indexCommand({ config: configPath });
      } catch (e) {
        thrownError = e;
      } finally {
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
        const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
        await closeLadybugDb();
      }

      // Should either exit(1) or throw for empty repos
      assert.ok(
        exitCode === 1 || thrownError !== undefined,
        "Should either exit(1) or throw for empty repos",
      );
    });

    it("logs repo count before indexing starts", async () => {
      const dir = join(tempDir, "count");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "test-repo", rootPath: tempDir }],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );

      let stdoutOutput = "";
      let thrownError: unknown;
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args: unknown[]) => {
        stdoutOutput += args.map(String).join(" ") + "\n";
      };
      console.error = () => {};

      process.exit = originalExit;

      try {
        await indexCommand({ config: configPath });
      } catch (e) {
        thrownError = e;
      } finally {
        console.log = origLog;
        console.error = origError;
        await closeLadybugDb();
      }

      // The indexCommand should reach the "Indexing N repo(s)..." log line
      // before any failure in the actual indexing. If config loading itself
      // fails (e.g., Zod validation), the log line won't appear.
      if (stdoutOutput.length > 0) {
        assert.ok(
          stdoutOutput.includes("Indexing 1 repo(s)"),
          `Should log repo count, got: ${stdoutOutput}`,
        );
      } else {
        // If config loading failed before reaching the log line,
        // verify the command at least threw (didn't silently succeed)
        assert.ok(
          thrownError !== undefined,
          "Command should have either logged or thrown",
        );
      }
    });

    it("restores queue and closes the local DB when plugin initialization fails", async () => {
      const dir = join(tempDir, "plugin-init-failure");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "plugin-failure", rootPath: join(dir, "missing") }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: false },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const origError = console.error;
      const origLog = console.log;
      let errorOutput = "";
      let closeCalls = 0;
      let indexCalls = 0;
      console.error = (...args: unknown[]) => {
        errorOutput += args.map(String).join(" ") + "\n";
      };
      console.log = () => {};
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await assert.rejects(
          indexCommand(
            { config: configPath },
            {
              loadConfiguredAdapterPlugins: async () => {
                throw new Error("injected plugin init failure");
              },
              closeLadybugDb: async () => {
                closeCalls += 1;
                await ladybug.closeLadybugDb();
              },
              indexRepo: async () => {
                indexCalls += 1;
                return emptyIndexResult();
              },
            },
          ),
          /process\.exit:1/,
        );

        assert.match(errorOutput, /injected plugin init failure/);
        assert.strictEqual(closeCalls, 1);
        assert.strictEqual(indexCalls, 0);
        assert.strictEqual(ladybug.getLadybugDbPath(), null);

        await assertDerivedQueueRestored(ladybugPath, "plugin-queue-restored");
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("attempts cleanup when local DB initialization opens then rejects", async () => {
      const dir = join(tempDir, "db-init-rejects-after-open");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "init-failure", rootPath: repoRoot }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: false },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const queue = await import("../../dist/indexer/derived-refresh-queue.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const origError = console.error;
      const origLog = console.log;
      let errorOutput = "";
      let closeCalls = 0;
      let indexCalls = 0;
      console.error = (...args: unknown[]) => {
        errorOutput += args.map(String).join(" ") + "\n";
      };
      console.log = () => {};
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await assert.rejects(
          indexCommand(
            { config: configPath },
            {
              initGraphDb: async () => {
                await ladybug.initLadybugDb(ladybugPath);
                throw new Error("injected init failure after open");
              },
              closeLadybugDb: async () => {
                closeCalls += 1;
                await ladybug.closeLadybugDb();
              },
              indexRepo: async () => {
                indexCalls += 1;
                return emptyIndexResult();
              },
            },
          ),
          /process\.exit:1/,
        );

        assert.match(errorOutput, /injected init failure after open/);
        assert.strictEqual(closeCalls, 1);
        assert.strictEqual(indexCalls, 0);
        assert.strictEqual(ladybug.getLadybugDbPath(), null);
        await assertDerivedQueueRestored(ladybugPath, "init-queue-restored");
      } finally {
        queue.enableDerivedRefreshQueue();
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("cleans up when effective-mode resolution rejects after initialization", async () => {
      const dir = join(tempDir, "mode-resolution-failure");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "mode-failure", rootPath: repoRoot }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: false },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const queue = await import("../../dist/indexer/derived-refresh-queue.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const origError = console.error;
      const origLog = console.log;
      let errorOutput = "";
      let closeCalls = 0;
      let indexCalls = 0;
      console.error = (...args: unknown[]) => {
        errorOutput += args.map(String).join(" ") + "\n";
      };
      console.log = () => {};
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await assert.rejects(
          indexCommand(
            { config: configPath },
            {
              resolveEffectiveIndexMode: async () => {
                throw new Error("injected mode planning failure");
              },
              closeLadybugDb: async () => {
                closeCalls += 1;
                await ladybug.closeLadybugDb();
              },
              indexRepo: async () => {
                indexCalls += 1;
                return emptyIndexResult();
              },
            },
          ),
          /process\.exit:1/,
        );

        assert.match(errorOutput, /injected mode planning failure/);
        assert.strictEqual(closeCalls, 1);
        assert.strictEqual(indexCalls, 0);
        assert.strictEqual(ladybug.getLadybugDbPath(), null);
        await assertDerivedQueueRestored(ladybugPath, "mode-queue-restored");
      } finally {
        queue.enableDerivedRefreshQueue();
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("delegates without local DB initialization or close", async () => {
      const dir = join(tempDir, "delegated-ownership");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "delegated", rootPath: join(dir, "repo") }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          httpAuth: { enabled: false, token: null },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const { removePidfile, resolvePidfilePath, writePidfile } = await import(
        "../../dist/util/pidfile.js"
      );
      const restoreGraphEnv = clearGraphPathEnvironment();
      const origError = console.error;
      const origLog = console.log;
      let initCalls = 0;
      let closeCalls = 0;
      let indexCalls = 0;
      let delegateCalls = 0;
      console.error = () => {};
      console.log = () => {};
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;
      writePidfile(ladybugPath, "http", 65_530);

      try {
        await indexCommand(
          { config: configPath, repoId: "delegated" },
          {
            initGraphDb: async () => {
              initCalls += 1;
            },
            closeLadybugDb: async () => {
              closeCalls += 1;
            },
            indexRepo: async () => {
              indexCalls += 1;
              return emptyIndexResult();
            },
            delegateIndexToServer: async () => {
              delegateCalls += 1;
              return { ok: true };
            },
          },
        );

        assert.strictEqual(delegateCalls, 1);
        assert.strictEqual(initCalls, 0);
        assert.strictEqual(closeCalls, 0);
        assert.strictEqual(indexCalls, 0);
      } finally {
        removePidfile(resolvePidfilePath(ladybugPath));
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("shares one finalization object across mixed full and incremental index calls", async () => {
      const dir = join(tempDir, "mixed-finalization");
      const fullRoot = join(dir, "full-root");
      const incrementalRoot = join(dir, "incremental-root");
      mkdirSync(fullRoot, { recursive: true });
      mkdirSync(incrementalRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [
            { repoId: "full-repo", rootPath: fullRoot },
            { repoId: "incremental-repo", rootPath: incrementalRoot },
          ],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { retrieval: {} },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const queries = await import("../../dist/db/ladybug-queries.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const calls: Array<{
        repoId: string;
        mode: "full" | "incremental";
        finalization: unknown;
        effectiveModeAlreadyResolved: unknown;
      }> = [];
      const resolverCalls: string[] = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = () => {};
      console.log = () => {};

      try {
        await ladybug.closeLadybugDb();
        await ladybug.initLadybugDb(ladybugPath);
        const conn = await ladybug.getLadybugConn();
        const createdAt = new Date().toISOString();
        await queries.upsertRepo(conn, {
          repoId: "incremental-repo",
          rootPath: incrementalRoot,
          configJson: "{}",
          createdAt,
        });
        await queries.upsertFile(conn, {
          fileId: "incremental:file.ts",
          repoId: "incremental-repo",
          relPath: "file.ts",
          contentHash: "hash",
          language: "typescript",
          byteSize: 1,
          lastIndexedAt: createdAt,
        });
        await ladybug.closeLadybugDb();

        await indexCommand(
          { config: configPath },
          {
            resolveEffectiveIndexMode: async (repoId) => {
              resolverCalls.push(repoId);
              return repoId === "full-repo" ? "full" : "incremental";
            },
            indexRepo: async (repoId, mode, _progress, _signal, options) => {
              calls.push({
                repoId,
                mode,
                finalization: options?.jinaHnswFinalization,
                effectiveModeAlreadyResolved:
                  options?.effectiveModeAlreadyResolved,
              });
              return emptyIndexResult();
            },
          },
        );

        assert.deepStrictEqual(
          resolverCalls,
          ["full-repo", "incremental-repo"],
        );
        assert.deepStrictEqual(
          calls.map(({ repoId, mode }) => [repoId, mode]),
          [
            ["full-repo", "full"],
            ["incremental-repo", "incremental"],
          ],
        );
        assert.ok(calls[0]?.finalization);
        assert.strictEqual(calls[0]?.finalization, calls[1]?.finalization);
        assert.ok(
          calls.every(
            ({ effectiveModeAlreadyResolved }) =>
              effectiveModeAlreadyResolved === true,
          ),
        );
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
      }
    });

    it("runs the required direct finalizer once and does not double-close after success", async () => {
      const dir = join(tempDir, "direct-finalization-success");
      const firstRepoRoot = join(dir, "first-repo");
      const secondRepoRoot = join(dir, "second-repo");
      mkdirSync(firstRepoRoot, { recursive: true });
      mkdirSync(secondRepoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [
            { repoId: "full-a", rootPath: firstRepoRoot },
            { repoId: "full-b", rootPath: secondRepoRoot },
          ],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: {
            enabled: true,
            retrieval: { vector: { efc: 321 } },
          },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const graphInit = await import("../../dist/db/initGraphDb.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const events: string[] = [];
      const stdout: string[] = [];
      let strictCloseCalls = 0;
      let now = 1_000;
      const origError = console.error;
      const origLog = console.log;
      const originalDateNow = Date.now;
      console.error = () => {};
      console.log = (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        stdout.push(line);
        if (line.startsWith("Post-reopen Jina HNSW finalization:")) {
          events.push("output:finalization");
        } else if (line.startsWith("  Wall time:")) {
          events.push("output:wall");
        } else if (line.includes("Indexing complete")) {
          events.push("output:complete");
        }
      };
      Date.now = () => now;

      try {
        await ladybug.closeLadybugDb();
        await indexCommand(
          { config: configPath, force: true },
          {
            initGraphDb: async (...args) => {
              events.push("db:init");
              return graphInit.initGraphDb(...args);
            },
            closeLadybugDb: async (options) => {
              events.push(`db:close:${options?.strict === true ? "strict" : "best"}`);
              if (options?.strict === true) {
                strictCloseCalls += 1;
                if (strictCloseCalls === 3) now = 21_000;
              }
              await ladybug.closeLadybugDb(options);
            },
            getLadybugDbPath: ladybug.getLadybugDbPath,
            resolveEffectiveIndexMode: async () => "full",
            indexRepo: async (repoId, _mode, _progress, _signal, options) => {
              events.push(`repo:index:${repoId}`);
              options?.jinaHnswFinalization?.onMayBeAbsent?.();
              return {
                ...emptyIndexResult(),
                durationMs: repoId === "full-a" ? 2_500 : 3_500,
              };
            },
            prepareReopenedJinaHnsw: async (params) => {
              events.push(
                `hnsw:prepare:${params.selectedFullRepoIds.join(",")}:${params.requireAbsent}`,
              );
              return {
                ...params.spec,
                outcome: "created",
                catalogMutated: true,
                probe: {
                  repoId: "full-a",
                  symbolId: "probe",
                  vector: [1, 0],
                },
                createMs: 2,
                queryMs: 0,
                checkpointMs: 3,
              };
            },
            validateReopenedJinaHnsw: async () => {
              events.push("hnsw:validate");
              return 4;
            },
          },
        );

        assert.deepStrictEqual(events, [
          "db:init",
          "repo:index:full-a",
          "repo:index:full-b",
          "db:close:strict",
          "db:init",
          "hnsw:prepare:full-a,full-b:true",
          "db:close:strict",
          "db:init",
          "hnsw:validate",
          "db:close:strict",
          "output:finalization",
          "output:wall",
          "output:complete",
        ]);
        const finalizationAt = stdout.indexOf(
          "Post-reopen Jina HNSW finalization: created",
        );
        assert.deepStrictEqual(stdout.slice(finalizationAt, finalizationAt + 3), [
          "Post-reopen Jina HNSW finalization: created",
          "  jina-embeddings-v2-base-code (symbol_vec_jina_code_v2, efc=321)",
          "  create=2ms query=4ms checkpoint=3ms",
        ]);
        assert.deepStrictEqual(
          stdout.filter((line) => line.startsWith("  Duration:")),
          ["  Duration: 2500ms", "  Duration: 3500ms"],
        );
        assert.deepStrictEqual(
          stdout.filter((line) => line.startsWith("  Wall time:")),
          ["  Wall time: 20000ms (includes 14000ms outside indexed phases)"],
        );
        assert.strictEqual(ladybug.getLadybugDbPath(), null);
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        Date.now = originalDateNow;
        console.error = origError;
        console.log = origLog;
      }
    });

    it("does not print finalization, wall, or completion after the final strict close fails", async () => {
      const dir = join(tempDir, "direct-finalization-close-failure");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "full-repo", rootPath: repoRoot }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: true, retrieval: {} },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const graphInit = await import("../../dist/db/initGraphDb.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const stdout: string[] = [];
      let strictCloseCalls = 0;
      const origError = console.error;
      const origLog = console.log;
      console.error = () => {};
      console.log = (...args: unknown[]) => {
        stdout.push(args.map(String).join(" "));
      };
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await ladybug.closeLadybugDb();
        await assert.rejects(
          indexCommand(
            { config: configPath, force: true },
            {
              initGraphDb: graphInit.initGraphDb,
              closeLadybugDb: async (options) => {
                await ladybug.closeLadybugDb(options);
                if (options?.strict === true) {
                  strictCloseCalls += 1;
                  if (strictCloseCalls === 3) {
                    throw new Error("injected final strict close failure");
                  }
                }
              },
              getLadybugDbPath: ladybug.getLadybugDbPath,
              resolveEffectiveIndexMode: async () => "full",
              indexRepo: async (_repoId, _mode, _progress, _signal, options) => {
                options?.jinaHnswFinalization?.onMayBeAbsent?.();
                return emptyIndexResult();
              },
              prepareReopenedJinaHnsw: async (params) => ({
                ...params.spec,
                outcome: "created",
                catalogMutated: true,
                probe: {
                  repoId: "full-repo",
                  symbolId: "probe",
                  vector: [1, 0],
                },
                createMs: 2,
                queryMs: 0,
                checkpointMs: 3,
              }),
              validateReopenedJinaHnsw: async () => 4,
            },
          ),
          /process\.exit:1/,
        );

        const output = stdout.join("\n");
        assert.strictEqual(strictCloseCalls, 3);
        assert.doesNotMatch(output, /Post-reopen Jina HNSW finalization:/);
        assert.doesNotMatch(output, /Wall time:/);
        assert.doesNotMatch(output, /Indexing complete/);
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("repairs a possibly absent global index after a repo error but still fails the command", async () => {
      const dir = join(tempDir, "direct-finalization-repair");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "failed-full-repo", rootPath: repoRoot }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: true, retrieval: {} },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const graphInit = await import("../../dist/db/initGraphDb.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const events: string[] = [];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => {
        stderr.push(args.map(String).join(" "));
      };
      console.log = (...args: unknown[]) => {
        stdout.push(args.map(String).join(" "));
      };
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await ladybug.closeLadybugDb();
        await assert.rejects(
          indexCommand(
            { config: configPath, force: true },
            {
              initGraphDb: async (...args) => {
                events.push("db:init");
                return graphInit.initGraphDb(...args);
              },
              closeLadybugDb: async (options) => {
                events.push("db:close");
                await ladybug.closeLadybugDb(options);
              },
              getLadybugDbPath: ladybug.getLadybugDbPath,
              resolveEffectiveIndexMode: async () => "full",
              indexRepo: async (_repoId, _mode, _progress, _signal, options) => {
                events.push("repo:error");
                options?.jinaHnswFinalization?.onMayBeAbsent?.();
                throw new Error("primary repository failure");
              },
              prepareReopenedJinaHnsw: async (params) => {
                events.push(
                  `hnsw:repair:${params.selectedFullRepoIds.join(",")}:${params.requireAbsent}`,
                );
                return {
                  ...params.spec,
                  outcome: "created",
                  catalogMutated: true,
                  probe: {
                    repoId: "failed-full-repo",
                    symbolId: "probe",
                    vector: [1, 0],
                  },
                  createMs: 2,
                  queryMs: 0,
                  checkpointMs: 3,
                };
              },
              validateReopenedJinaHnsw: async () => {
                events.push("hnsw:validate");
                return 4;
              },
            },
          ),
          /process\.exit:1/,
        );

        assert.deepStrictEqual(events, [
          "db:init",
          "repo:error",
          "db:close",
          "db:init",
          "hnsw:repair::true",
          "db:close",
          "db:init",
          "hnsw:validate",
          "db:close",
        ]);
        assert.match(stderr.join("\n"), /primary repository failure/);
        assert.doesNotMatch(stdout.join("\n"), /Indexing complete/);
        assert.strictEqual(ladybug.getLadybugDbPath(), null);
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("uses existing cleanup after a repo error when deferral never made the index absent", async () => {
      const dir = join(tempDir, "direct-finalization-no-repair");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "failed-full-repo", rootPath: repoRoot }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: true, retrieval: {} },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      let closeCalls = 0;
      let prepareCalls = 0;
      const origError = console.error;
      const origLog = console.log;
      console.error = () => {};
      console.log = () => {};
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await ladybug.closeLadybugDb();
        await assert.rejects(
          indexCommand(
            { config: configPath, force: true },
            {
              closeLadybugDb: async (options) => {
                closeCalls++;
                assert.notStrictEqual(options?.strict, true);
                await ladybug.closeLadybugDb(options);
              },
              resolveEffectiveIndexMode: async () => "full",
              indexRepo: async () => {
                throw new Error("primary repository failure");
              },
              prepareReopenedJinaHnsw: async () => {
                prepareCalls++;
                throw new Error("must not repair");
              },
            },
          ),
          /process\.exit:1/,
        );

        assert.strictEqual(closeCalls, 1);
        assert.strictEqual(prepareCalls, 0);
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("prints the repo failure before indented repair and teardown failures", async () => {
      const dir = join(tempDir, "direct-finalization-repair-failure");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "failed-full-repo", rootPath: repoRoot }],
          graphDatabase: { path: ladybugPath },
          policy: {},
          semantic: { enabled: true, retrieval: {} },
          scip: { enabled: false },
        }),
      );

      const { indexCommand } = await import("../../dist/cli/commands/index.js");
      const graphInit = await import("../../dist/db/initGraphDb.js");
      const ladybug = await import("../../dist/db/ladybug.js");
      const restoreGraphEnv = clearGraphPathEnvironment();
      const stderr: string[] = [];
      let closeCalls = 0;
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => {
        stderr.push(args.map(String).join(" "));
      };
      console.log = () => {};
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await ladybug.closeLadybugDb();
        await assert.rejects(
          indexCommand(
            { config: configPath, force: true },
            {
              initGraphDb: graphInit.initGraphDb,
              closeLadybugDb: async (options) => {
                closeCalls++;
                await ladybug.closeLadybugDb(options);
                if (closeCalls === 2) {
                  throw new Error("repair teardown failure");
                }
              },
              getLadybugDbPath: ladybug.getLadybugDbPath,
              resolveEffectiveIndexMode: async () => "full",
              indexRepo: async (_repoId, _mode, _progress, _signal, options) => {
                options?.jinaHnswFinalization?.onMayBeAbsent?.();
                throw new Error("primary repository failure");
              },
              prepareReopenedJinaHnsw: async () => {
                throw new Error("repair preparation failure");
              },
            },
          ),
          /process\.exit:1/,
        );

        const output = stderr.join("\n");
        const primaryAt = output.indexOf("primary repository failure");
        const repairAt = output.indexOf("repair preparation failure");
        const teardownAt = output.indexOf("repair teardown failure");
        assert.ok(primaryAt >= 0 && primaryAt < repairAt);
        assert.ok(repairAt < teardownAt);
        assert.match(output, /\n    Jina HNSW repair:/);
        assert.match(output, /native ownership.*closed.*cleanup failed/i);
        assert.strictEqual(closeCalls, 2);
      } finally {
        await ladybug.closeLadybugDb();
        restoreGraphEnv();
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
      }
    });

    it("delegates indexing to an auth-disabled HTTP server", async () => {
      const dir = join(tempDir, "delegate-no-auth");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "test-repo", rootPath: repoRoot }],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
          policy: {
            maxWindowLines: 180,
            maxWindowTokens: 1400,
            requireIdentifiers: true,
            allowBreakGlass: false,
            defaultDenyRaw: true,
          },
          httpAuth: { enabled: false, token: null },
        }),
      );

      let receivedPath = "";
      let receivedBody = "";
      let receivedAuthorization: string | undefined;
      const server = createServer((req, res) => {
        receivedPath = req.url ?? "";
        receivedAuthorization = req.headers.authorization;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          receivedBody += chunk;
        });
        req.on("end", () => {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "close",
          });
          res.write("event: complete\n");
          res.write(
            `data: ${JSON.stringify({
              filesProcessed: 0,
              symbolsIndexed: 0,
              totalSymbols: 0,
              edgesCreated: 0,
              totalEdges: 0,
              durationMs: 1,
            })}\n\n`,
          );
          res.end();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");

      const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );
      const { writePidfile } = await import("../../dist/util/pidfile.js");
      writePidfile(ladybugPath, "http", address.port);

      const originalGraphDbPath = process.env.SDL_GRAPH_DB_PATH;
      const originalGraphDbDir = process.env.SDL_GRAPH_DB_DIR;
      const originalDbPath = process.env.SDL_DB_PATH;
      const origLog = console.log;
      const origError = console.error;
      delete process.env.SDL_GRAPH_DB_PATH;
      delete process.env.SDL_GRAPH_DB_DIR;
      // The test runner sets legacy SDL_DB_PATH for compatibility. Clear it so
      // this test exercises the graphDatabase.path from its temporary config.
      delete process.env.SDL_DB_PATH;
      console.log = () => {};
      console.error = () => {};

      try {
        await indexCommand({ config: configPath, repoId: "test-repo" });
      } finally {
        if (originalGraphDbPath === undefined) {
          delete process.env.SDL_GRAPH_DB_PATH;
        } else {
          process.env.SDL_GRAPH_DB_PATH = originalGraphDbPath;
        }
        if (originalGraphDbDir === undefined) {
          delete process.env.SDL_GRAPH_DB_DIR;
        } else {
          process.env.SDL_GRAPH_DB_DIR = originalGraphDbDir;
        }
        if (originalDbPath === undefined) {
          delete process.env.SDL_DB_PATH;
        } else {
          process.env.SDL_DB_PATH = originalDbPath;
        }
        console.log = origLog;
        console.error = origError;
        await closeLadybugDb();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }

      assert.strictEqual(
        receivedPath,
        "/api/repo/test-repo/reindex-stream",
      );
      assert.strictEqual(receivedAuthorization, undefined);
      assert.deepStrictEqual(JSON.parse(receivedBody), {
        mode: "incremental",
      });
    });

    it("does not fall back to direct indexing when HTTP delegation reports a retryable server-busy error", async () => {
      const dir = join(tempDir, "delegate-server-busy");
      const repoRoot = join(dir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "test-repo", rootPath: repoRoot }],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
          policy: {
            maxWindowLines: 180,
            maxWindowTokens: 1400,
            requireIdentifiers: true,
            allowBreakGlass: false,
            defaultDenyRaw: true,
          },
          httpAuth: { enabled: false, token: null },
        }),
      );

      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "close",
          });
          res.write("event: error\n");
          res.write(
            `data: ${JSON.stringify({
              message:
                "Tool dispatch queue timed out after 30000ms for tool-dispatch (active=1, queued=0, max=1)",
            })}\n\n`,
          );
          res.end();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");

      const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );
      const { writePidfile } = await import("../../dist/util/pidfile.js");
      writePidfile(ladybugPath, "http", address.port);

      const originalGraphDbPath = process.env.SDL_GRAPH_DB_PATH;
      const originalGraphDbDir = process.env.SDL_GRAPH_DB_DIR;
      const originalDbPath = process.env.SDL_DB_PATH;
      const origLog = console.log;
      const origError = console.error;
      const originalExit = process.exit;
      const stdout: string[] = [];
      const stderr: string[] = [];
      delete process.env.SDL_GRAPH_DB_PATH;
      delete process.env.SDL_GRAPH_DB_DIR;
      delete process.env.SDL_DB_PATH;
      console.log = (message?: unknown) => {
        stdout.push(String(message ?? ""));
      };
      console.error = (message?: unknown) => {
        stderr.push(String(message ?? ""));
      };
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit;

      try {
        await assert.rejects(
          indexCommand({ config: configPath, repoId: "test-repo" }),
          /process\.exit:1/,
        );
      } finally {
        if (originalGraphDbPath === undefined) {
          delete process.env.SDL_GRAPH_DB_PATH;
        } else {
          process.env.SDL_GRAPH_DB_PATH = originalGraphDbPath;
        }
        if (originalGraphDbDir === undefined) {
          delete process.env.SDL_GRAPH_DB_DIR;
        } else {
          process.env.SDL_GRAPH_DB_DIR = originalGraphDbDir;
        }
        if (originalDbPath === undefined) {
          delete process.env.SDL_DB_PATH;
        } else {
          process.env.SDL_DB_PATH = originalDbPath;
        }
        console.log = origLog;
        console.error = origError;
        process.exit = originalExit;
        await closeLadybugDb();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }

      const joinedStdout = stdout.join("\n");
      const joinedStderr = stderr.join("\n");
      assert.doesNotMatch(joinedStdout, /Falling back to direct indexing/);
      assert.match(
        joinedStderr,
        /Not falling back to direct indexing because the HTTP server owns the graph DB lock/,
      );
      assert.match(joinedStderr, /concurrency\.toolQueueTimeoutMs/);
      assert.match(joinedStderr, /retry/i);
    });
  });
});
