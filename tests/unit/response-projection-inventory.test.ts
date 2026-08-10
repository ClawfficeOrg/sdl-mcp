import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ZodType } from "zod";

import {
  ACTION_DEFINITION_BY_ACTION,
  INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION,
  buildCatalog,
} from "../../dist/code-mode/action-catalog.js";
import { getActiveFnNameMap } from "../../dist/code-mode/manual-generator.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import {
  PROJECTION_PROFILE_ACTIONS,
  PROJECTION_PROFILE_REGISTRY,
  WORKFLOW_CHILD_ACTION_BINDINGS,
  assertProjectionProfileInventory,
  assertWorkflowProjectionBindings,
} from "../../dist/mcp/response-projection/registry.js";
import { registerTools } from "../../dist/mcp/tools/index.js";
import {
  AGENT_OUTPUT_CASES,
  DEFERRED_FAMILY_ASSERTIONS,
} from "../fixtures/response-projection/agent-output-cases.ts";

const MUTATING_ACTIONS = new Set([
  "symbol.edit",
  "repo.register",
  "repo.unregister",
  "index.refresh",
  "policy.set",
  "file.write",
  "search.edit",
  "semantic.enrichment.refresh",
  "agent.feedback",
  "buffer.push",
  "buffer.checkpoint",
  "runtime.execute",
  "memory.store",
  "memory.remove",
  "memory.surface",
  "file",
  "workflow",
]);

interface PublicToolRegistration {
  readonly name: string;
  readonly outputSchema: ZodType | undefined;
}

function capturePublicToolRegistrations(
  codeModeConfig?: Parameters<typeof registerTools>[3],
): readonly PublicToolRegistration[] {
  const registrations: PublicToolRegistration[] = [];
  const server = {
    gatewayMode: false,
    registerPostDispatchHook(): void {},
    registerTool(
      name: string,
      _description: string,
      _inputSchema: ZodType,
      _handler: (args: unknown) => unknown,
      _wireSchema?: Record<string, unknown>,
      _presentation?: { title?: string },
      outputSchema?: ZodType,
    ): void {
      registrations.push({ name, outputSchema });
    },
  } as unknown as Parameters<typeof registerTools>[0];

  registerTools(
    server,
    { actionAvailability: { memoryTools: true, infoTool: true } },
    undefined,
    codeModeConfig,
  );
  return registrations;
}

function capturePublicFlatToolNames(): readonly string[] {
  return capturePublicToolRegistrations().map(({ name }) => name);
}

function canonicalFlatAction(toolName: string): string {
  assert.match(toolName, /^sdl\./);
  return toolName.slice("sdl.".length);
}

function compactKeyRecord(
  action: string,
  resultKind: "record" | "array" | "scalar" | undefined,
  projected: unknown,
): Record<string, unknown> {
  if (resultKind === "scalar") {
    assert.notEqual(projected, undefined, action);
    assert.notEqual(projected, null, action);
    assert.notEqual(typeof projected, "object", action);
    return {};
  }
  const candidate =
    resultKind === "array"
      ? (assert.ok(Array.isArray(projected) && projected.length > 0, action),
        projected[0])
      : projected;
  assert.ok(candidate && typeof candidate === "object", action);
  assert.equal(Array.isArray(candidate), false, action);
  return candidate as Record<string, unknown>;
}

function derivePublicActions(): readonly string[] {
  const flatActions = capturePublicFlatToolNames().map(canonicalFlatAction);
  const codeModeActions = buildCatalog({
    memoryVisible: true,
    infoVisible: true,
  }).map((entry) => entry.action);
  const workflowActions = Object.values(getActiveFnNameMap(true));
  return [
    ...new Set([...flatActions, ...codeModeActions, ...workflowActions]),
  ].sort();
}

describe("response projection inventory", () => {
  it("has exactly one complete profile for every advertised canonical action", () => {
    const publicActions = derivePublicActions();
    const profileActions = Object.keys(PROJECTION_PROFILE_REGISTRY).sort();

    assert.doesNotThrow(() => assertProjectionProfileInventory(publicActions));
    assert.deepEqual(profileActions, publicActions);
    assert.deepEqual([...PROJECTION_PROFILE_ACTIONS].sort(), publicActions);

    for (const action of publicActions) {
      assert.deepEqual(
        Object.keys(
          PROJECTION_PROFILE_REGISTRY[
            action as keyof typeof PROJECTION_PROFILE_REGISTRY
          ],
        ).sort(),
        [
          "budgetClass",
          "defaultDetail",
          "largeResponseStrategy",
          "observabilityProfile",
          "projector",
          "recoveryPolicy",
        ],
        action,
      );
    }
  });

  it("lists every active workflow child exactly once", () => {
    const activeFnNameMap = getActiveFnNameMap(true);

    assert.doesNotThrow(() =>
      assertWorkflowProjectionBindings(activeFnNameMap),
    );
    assert.deepEqual(WORKFLOW_CHILD_ACTION_BINDINGS, activeFnNameMap);
  });

  it("accepts every fixture request through the active public schema", () => {
    const failures: string[] = [];
    for (const fixture of AGENT_OUTPUT_CASES) {
      const definition = ACTION_DEFINITION_BY_ACTION[fixture.action];
      if (!definition) {
        failures.push(`${fixture.action}: missing action definition`);
        continue;
      }
      const parsed = definition.schema.safeParse(fixture.publicRequest);
      if (!parsed.success) {
        failures.push(
          `${fixture.action}: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
    }
    assert.deepEqual(failures, []);
  });

  it("accepts every canonical fixture result through its active output schema", () => {
    const flatRegistrations = capturePublicToolRegistrations();
    const codeModeRegistrations = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    });
    const outputSchemaByAction = new Map<string, ZodType>(
      Object.entries(INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION),
    );
    const failures: string[] = [];

    assert.deepEqual(
      flatRegistrations.slice(0, 2).map(({ name }) => name),
      ["sdl.action.search", "sdl.info"],
    );
    assert.equal(
      new Set(flatRegistrations.map(({ name }) => name)).size,
      flatRegistrations.length,
    );
    for (const registration of [
      ...flatRegistrations,
      ...codeModeRegistrations,
    ]) {
      const action = canonicalFlatAction(registration.name);
      if (!registration.outputSchema) {
        failures.push(`${action}: missing output schema`);
        continue;
      }
      outputSchemaByAction.set(action, registration.outputSchema);
    }

    assert.deepEqual(
      [...outputSchemaByAction.keys()].sort(),
      AGENT_OUTPUT_CASES.map(({ action }) => action).sort(),
    );
    for (const fixture of AGENT_OUTPUT_CASES) {
      const outputSchema = outputSchemaByAction.get(fixture.action);
      if (!outputSchema) {
        failures.push(`${fixture.action}: missing output schema`);
        continue;
      }
      const parsed = outputSchema.safeParse(fixture.canonicalResultFactory());
      if (!parsed.success) {
        failures.push(
          `${fixture.action}: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
    }
    assert.deepEqual(failures, []);
  });

  it("pins one actionable compact fixture for every public action", () => {
    const publicActions = derivePublicActions();
    const fixtureActions = AGENT_OUTPUT_CASES.map(
      ({ action }) => action,
    ).sort();

    assert.deepEqual(fixtureActions, publicActions);
    assert.equal(new Set(fixtureActions).size, fixtureActions.length);

    for (const fixture of AGENT_OUTPUT_CASES) {
      const projected = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        {
          ...fixture.publicRequest,
          detail: "compact",
          includeDiagnostics: false,
        },
      );
      const projectedRecord = compactKeyRecord(
        fixture.action,
        fixture.compactResultKind,
        projected,
      );

      assert.deepEqual(
        Object.keys(projectedRecord),
        fixture.expectedCompactKeys,
        fixture.action,
      );
      for (const key of fixture.requiredActionabilityKeys) {
        assert.ok(
          Object.hasOwn(projectedRecord, key),
          `${fixture.action}:${key}`,
        );
      }
      if (MUTATING_ACTIONS.has(fixture.action)) {
        assert.notEqual(fixture.executionMode, "read-only", fixture.action);
      }
    }
  });

  it("keeps later family RED assertions separate from global parity", () => {
    assert.deepEqual(DEFERRED_FAMILY_ASSERTIONS, [
      "retrieval-family-full-detail",
      "mutation-family-recovery",
      "runtime-family-diagnostics",
    ]);
  });

  it("has a compact determinism entry or diagnostic-only reason per fixture", () => {
    const fixtures = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/integration/determinism.fixtures.json"),
        "utf8",
      ),
    ) as {
      projectionCases?: Array<{
        action: string;
        detail: string;
        includeDiagnostics: boolean;
      }>;
      projectionDiagnosticVolatilityAllowlist?: Array<{
        action: string;
        reason: string;
      }>;
    };

    assert.ok(Array.isArray(fixtures.projectionCases));
    assert.ok(Array.isArray(fixtures.projectionDiagnosticVolatilityAllowlist));

    const projectionCases = fixtures.projectionCases;
    const diagnosticAllowlist =
      fixtures.projectionDiagnosticVolatilityAllowlist;
    const determinismActions = projectionCases.map(({ action }) => action);
    const allowlistedActions = diagnosticAllowlist.map(({ action }) => action);
    const coveredActions = [
      ...new Set([...determinismActions, ...allowlistedActions]),
    ].sort();

    assert.deepEqual(
      coveredActions,
      AGENT_OUTPUT_CASES.map(({ action }) => action).sort(),
    );
    assert.equal(new Set(determinismActions).size, determinismActions.length);
    for (const entry of projectionCases) {
      assert.equal(entry.detail, "compact", entry.action);
      assert.equal(entry.includeDiagnostics, false, entry.action);

      const fixture = AGENT_OUTPUT_CASES.find(
        ({ action }) => action === entry.action,
      );
      assert.ok(fixture, entry.action);
      const args = {
        ...fixture.publicRequest,
        detail: entry.detail,
        includeDiagnostics: entry.includeDiagnostics,
      };
      const first = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        args,
      );
      const second = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        args,
      );
      const firstJson = JSON.stringify(first);
      const secondJson = JSON.stringify(second);
      assert.deepEqual(
        Buffer.from(firstJson, "utf8"),
        Buffer.from(secondJson, "utf8"),
        entry.action,
      );

      const firstRecord = compactKeyRecord(
        fixture.action,
        fixture.compactResultKind,
        first,
      );
      const secondRecord = compactKeyRecord(
        fixture.action,
        fixture.compactResultKind,
        second,
      );
      assert.deepEqual(
        Object.keys(firstRecord),
        fixture.expectedCompactKeys,
        entry.action,
      );
      assert.deepEqual(
        Object.keys(secondRecord),
        fixture.expectedCompactKeys,
        entry.action,
      );
    }
    for (const entry of diagnosticAllowlist) {
      const fixture = AGENT_OUTPUT_CASES.find(
        ({ action }) => action === entry.action,
      );
      assert.ok(
        fixture?.diagnosticExpectation?.includeDiagnostics,
        entry.action,
      );
      assert.ok(entry.reason.trim().length > 0, entry.action);
    }
  });
});
