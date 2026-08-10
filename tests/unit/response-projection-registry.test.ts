import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ACTION_DEFINITION_BY_ACTION } from "../../dist/code-mode/action-catalog.js";
import {
  COMPATIBILITY_WORKFLOW_CHILD_ACTIONS,
  CUSTOM_RESPONSE_PROJECTION_ACTIONS,
  RESPONSE_PROJECTION_RULES,
  createResponseProjectionRegistry,
  getWorkflowChildAction,
} from "../../dist/mcp/context-response-projection-registry.js";
import {
  PROJECTION_PROFILE_REGISTRY,
  WORKFLOW_CHILD_ACTION_BINDINGS,
  assertProjectionProfilesForActions,
  createProjectionProfileRegistry,
  getProjectionProfile,
} from "../../dist/mcp/response-projection/registry.js";
import {
  CARD_WIRE_FIELD_ORDER,
  compactCardForWire,
} from "../../dist/mcp/tools/symbol-utils.js";

describe("response projection registry", () => {
  it("covers the exact actions with custom projection behavior", () => {
    assert.deepEqual(CUSTOM_RESPONSE_PROJECTION_ACTIONS, [
      "action.search",
      "buffer.checkpoint",
      "code.needWindow",
      "context",
      "delta.get",
      "repo.overview",
      "repo.status",
      "slice.build",
      "symbol.search",
      "usage.stats",
      "workflow",
    ]);
    assert.deepEqual(
      Object.keys(RESPONSE_PROJECTION_RULES).sort(),
      [...CUSTOM_RESPONSE_PROJECTION_ACTIONS].sort(),
    );
    for (const action of CUSTOM_RESPONSE_PROJECTION_ACTIONS) {
      assert.ok(ACTION_DEFINITION_BY_ACTION[action], action);
    }
  });

  it("rejects unknown registry keys", () => {
    assert.throws(
      () =>
        createResponseProjectionRegistry([
          ["unknown.action", { projector: "generic" }],
        ] as never),
      /Unknown response projection action/,
    );
  });

  it("fails closed for missing, duplicate, or unknown profiles", () => {
    const infoProfile = PROJECTION_PROFILE_REGISTRY.info;

    assert.throws(
      () =>
        createProjectionProfileRegistry(
          [
            ["info", infoProfile],
            ["info", infoProfile],
          ],
          ["info"],
        ),
      /Duplicate projection profile action: info/,
    );
    assert.throws(
      () =>
        createProjectionProfileRegistry(
          [["info", infoProfile]],
          ["info", "manual"],
        ),
      /Missing projection profile action: manual/,
    );
    assert.throws(
      () =>
        createProjectionProfileRegistry(
          [["unknown.action", infoProfile]],
          ["info"],
        ),
      /Unknown projection profile action: unknown.action/,
    );
    assert.throws(
      () => getProjectionProfile("unknown.action"),
      /Missing response projection profile: unknown.action/,
    );
    assert.throws(
      () => assertProjectionProfilesForActions(["sdl.info", "info"]),
      /Duplicate public actions projection action: info/,
    );
  });

  it("keeps compatibility-only workflow aliases disjoint from canonical bindings", () => {
    assert.deepEqual(COMPATIBILITY_WORKFLOW_CHILD_ACTIONS, {
      actionSearch: "action.search",
      file: "sdl.file",
      sdlFile: "sdl.file",
      symbolGetCards: "symbol.getCards",
    });
    for (const fn of Object.keys(WORKFLOW_CHILD_ACTION_BINDINGS)) {
      assert.equal(
        Object.hasOwn(COMPATIBILITY_WORKFLOW_CHILD_ACTIONS, fn),
        false,
        fn,
      );
    }

    assert.equal(getWorkflowChildAction("repoRegister"), "repo.register");
    assert.equal(getWorkflowChildAction("actionSearch"), "action.search");
    assert.equal(getWorkflowChildAction("unknownFunction"), "workflow");
  });

  it("owns action rules outside the projection implementation", () => {
    const source = readFileSync(
      join(process.cwd(), "src/mcp/context-response-projection.ts"),
      "utf8",
    );
    assert.equal(source.includes("WORKFLOW_CHILD_TOOL_NAMES"), false);
    assert.equal(source.includes("USAGE_STATS_TOOLS"), false);
    assert.equal(source.includes("CODE_NEED_WINDOW_TOOLS"), false);

    const registrySource = readFileSync(
      join(process.cwd(), "src/mcp/response-projection/registry.ts"),
      "utf8",
    );
    assert.equal(registrySource.includes("../tools"), false);
    assert.equal(registrySource.includes("../gateway"), false);
  });
});

describe("canonical card wire order", () => {
  it("pins the exact serialized key sequence", () => {
    assert.deepEqual(CARD_WIRE_FIELD_ORDER, [
      "symbolId",
      "repoId",
      "file",
      "range",
      "kind",
      "name",
      "exported",
      "visibility",
      "signature",
      "summary",
      "summaryProvenance",
      "invariants",
      "sideEffects",
      "testCase",
      "cluster",
      "processes",
      "callResolution",
      "deps",
      "metrics",
      "detailLevel",
      "etag",
      "version",
      "truncated",
    ]);

    const output = compactCardForWire({
      symbolId: "sym",
      repoId: "repo",
      file: "src/a.ts",
      range: { startLine: 1, startCol: 0, endLine: 2, endCol: 1 },
      kind: "function",
      name: "run",
      exported: false,
      visibility: "private",
      signature: { name: "run", params: [] },
      summary: "Runs.",
      summaryProvenance: "source",
      invariants: ["stable"],
      sideEffects: ["logs"],
      testCase: { framework: "node:test", title: "runs" },
      cluster: "core",
      processes: ["request"],
      callResolution: { resolved: 1 },
      deps: { imports: ["dep"], calls: [] },
      metrics: { fanIn: 1 },
      detailLevel: "full",
      etag: "etag",
      version: "v1",
      truncated: false,
    } as never);
    assert.deepEqual(Object.keys(output), CARD_WIRE_FIELD_ORDER);
  });
});
