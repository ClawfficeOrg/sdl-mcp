import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";

const HEALTHY_CAPABILITIES = {
  fts: true,
  fileSummaryFts: true,
  vectorNomic: true,
  vectorJinaCode: true,
  coveragePermille: {
    symbolVector: 1000,
    fileSummaryVector: 1000,
  },
};

interface HealthBoundaryState {
  compatibilityCalls: number;
  strictArgs?: [unknown, string, unknown];
}

async function installHealthBoundaryMocks(t: TestContext) {
  const fallback = await import("../../dist/retrieval/fallback.js");
  const health = await import("../../dist/retrieval/health.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const orchestrator = await import("../../dist/retrieval/orchestrator.js");

  const semantic = {
    enabled: true,
    retrieval: { mode: "hybrid" },
  };
  const state: HealthBoundaryState = { compatibilityCalls: 0 };

  t.mock.module("../../dist/config/loadConfig.js", {
    namedExports: {
      ...loadConfigModule,
      loadConfig: () => ({ semantic }),
    },
  });
  t.mock.module("../../dist/retrieval/health.js", {
    namedExports: {
      ...health,
      checkRetrievalHealth: async (
        conn: unknown,
        repoId: string,
        semanticConfig: unknown,
      ) => {
        state.strictArgs = [conn, repoId, semanticConfig];
        return HEALTHY_CAPABILITIES;
      },
    },
  });
  t.mock.module("../../dist/retrieval/fallback.js", {
    namedExports: {
      ...fallback,
      checkRetrievalHealth: async () => {
        state.compatibilityCalls += 1;
        return HEALTHY_CAPABILITIES;
      },
      isHybridRetrievalAvailable: async (
        _repoId: string,
        healthFactory: () => Promise<unknown>,
      ) => {
        await healthFactory();
        return true;
      },
    },
  });
  t.mock.module("../../dist/retrieval/orchestrator.js", {
    namedExports: {
      ...orchestrator,
      createRetrievalQueryContext: () => ({}),
      getOrCreateHealthPromise: async (
        _context: unknown,
        _repoId: string,
        healthFactory: () => Promise<unknown>,
      ) => healthFactory(),
      hybridSearch: async () => ({ results: [] }),
      runAfterGraphRetrievalAdmission: async (
        _conn: unknown,
        _repoId: string,
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  });

  return { semantic, state };
}

it("start-node resolver forwards its admitted connection to strict health", async (t) => {
  const { semantic, state } = await installHealthBoundaryMocks(t);
  const admittedConn = { id: "resolver-admitted" };
  const { resolveStartNodesLadybug } = await import(
    "../../dist/graph/slice/start-node-resolver.js?strict-health-admission"
  );

  await resolveStartNodesLadybug(admittedConn as never, "repo" as never, {});

  assert.equal(state.compatibilityCalls, 0);
  assert.deepEqual(state.strictArgs, [admittedConn, "repo", semantic]);
});

it("executor forwards its admitted connection to strict health", async (t) => {
  const { semantic, state } = await installHealthBoundaryMocks(t);
  const admittedConn = { id: "executor-admitted" };
  const { Executor } = await import(
    "../../dist/agent/executor.js?strict-health-admission"
  );
  const dbQueries = {
    getFileByRepoPath: async () => null,
    getSymbolIdsByFile: async () => [],
    getFilesByPrefix: async () => [],
    getSymbolsByFile: async () => [],
    getClusterMembers: async () => [],
    getProcessStepsByIds: async () => [],
    getSymbolsByIds: async () => new Map(),
    getFilesByIds: async () => new Map(),
    searchSymbols: async () => [],
  };
  const executor = new Executor(undefined, dbQueries as never);
  const privateExecutor = executor as unknown as {
    connPromise: Promise<unknown>;
    executeCardRung(
      task: {
        taskType: "debug";
        taskText: string;
        repoId: string;
        options: {
          semantic: true;
          contextMode: "precise";
          searchTerms: string[];
        };
      },
      context: string[],
      seedCandidates: never[],
    ): Promise<unknown>;
  };
  privateExecutor.connPromise = Promise.resolve(admittedConn);

  await privateExecutor.executeCardRung(
    {
      taskType: "debug",
      taskText: "find target",
      repoId: "repo",
      options: {
        semantic: true,
        contextMode: "precise",
        searchTerms: ["target"],
      },
    },
    [],
    [],
  );

  assert.equal(state.compatibilityCalls, 0);
  assert.deepEqual(state.strictArgs, [admittedConn, "repo", semantic]);
});
