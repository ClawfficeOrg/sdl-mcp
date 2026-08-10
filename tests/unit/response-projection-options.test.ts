import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  registerActionSearchTool,
  registerCodeModeTools,
} from "../../dist/code-mode/index.js";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import { parseWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import { buildCompactJsonSchema } from "../../dist/gateway/compact-schema.js";
import { extractProjectionRequestOptions } from "../../dist/mcp/request-normalization.js";
import {
  ProjectionRequestOptionShape,
  ProjectionRequestOptionsSchema,
  withProjectionRequestOptionsJsonSchema,
} from "../../dist/mcp/response-projection/request-options.js";
import {
  IndexRefreshRequestSchema,
  RepoStatusRequestSchema,
  RepoUnregisterRequestSchema,
  SemanticEnrichmentStatusRequestSchema,
} from "../../dist/mcp/tools.js";
import { buildFlatToolDescriptors } from "../../dist/mcp/tools/tool-descriptors.js";

type PublicSchema = {
  parse(value: unknown): unknown;
};

type RegisteredTool = {
  schema: PublicSchema;
  handler: (args: unknown) => Promise<unknown>;
  wireSchema?: Record<string, unknown>;
};

const CODE_MODE_CONFIG = {
  enabled: true,
  exclusive: true,
  maxWorkflowSteps: 20,
  maxWorkflowTokens: 50_000,
  maxWorkflowDurationMs: 30_000,
  ladderValidation: "warn",
  etagCaching: false,
};

function findJsonProperty(
  schema: unknown,
  name: string,
  root: unknown = schema,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return undefined;
  const record = schema as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === "object"
      ? (record.properties as Record<string, unknown>)
      : undefined;
  const property = properties?.[name];
  if (property && typeof property === "object" && !Array.isArray(property)) {
    const propertyRecord = property as Record<string, unknown>;
    if (
      typeof propertyRecord.$ref === "string" &&
      propertyRecord.$ref.startsWith("#/$defs/") &&
      root &&
      typeof root === "object" &&
      !Array.isArray(root)
    ) {
      const definitions = (root as Record<string, unknown>).$defs;
      if (definitions && typeof definitions === "object") {
        const resolved = (definitions as Record<string, unknown>)[
          propertyRecord.$ref.slice("#/$defs/".length)
        ];
        if (
          resolved &&
          typeof resolved === "object" &&
          !Array.isArray(resolved)
        ) {
          return resolved as Record<string, unknown>;
        }
      }
    }
    return propertyRecord;
  }
  for (const branchName of ["anyOf", "oneOf", "allOf"]) {
    const branches = record[branchName];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found = findJsonProperty(branch, name, root);
      if (found) return found;
    }
  }
  return undefined;
}

function capturePublicSchemas(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const fakeServer = {
    registerTool(
      name: string,
      _description: string,
      schema: PublicSchema,
      handler: (args: unknown) => Promise<unknown>,
      wireSchema?: Record<string, unknown>,
    ) {
      tools.set(name, { schema, handler, wireSchema });
    },
  };

  registerActionSearchTool(fakeServer as never, {} as never);
  registerCodeModeTools(
    fakeServer as never,
    {} as never,
    CODE_MODE_CONFIG as never,
  );
  return tools;
}

describe("projection request options", () => {
  it("advertises the shared projection options on every direct flat schema", () => {
    const descriptors = buildFlatToolDescriptors({
      actionAvailability: { memoryTools: true, infoTool: true },
    } as never);

    for (const descriptor of descriptors) {
      const jsonSchema = buildCompactJsonSchema(descriptor.schema);
      const detail = findJsonProperty(jsonSchema, "detail");
      const includeDiagnostics = findJsonProperty(
        jsonSchema,
        "includeDiagnostics",
      );
      assert.deepEqual(
        detail?.enum,
        ["compact", "standard", "full"],
        descriptor.name + " detail",
      );
      assert.equal(
        includeDiagnostics?.type,
        "boolean",
        descriptor.name + " includeDiagnostics",
      );
    }
  });

  it("composes projection options into every top-level gateway without leaking projection-only fields", () => {
    const tools = capturePublicSchemas();
    const cases = [
      {
        name: "sdl.action.search",
        input: { query: "repo.status" },
        keepsDetail: true,
        keepsDiagnostics: false,
      },
      {
        name: "sdl.manual",
        input: {},
        keepsDetail: true,
        keepsDiagnostics: false,
      },
      {
        name: "sdl.retrieve",
        input: {
          repoId: "repo",
          op: "symbolSearch",
          args: { query: "target" },
        },
        keepsDetail: false,
        keepsDiagnostics: false,
      },
      {
        name: "sdl.context",
        input: {
          repoId: "repo",
          taskType: "explain",
          taskText: "explain target",
          budget: { maxTokens: 1234 },
        },
        keepsDetail: false,
        keepsDiagnostics: false,
      },
      {
        name: "sdl.file",
        input: { repoId: "repo", op: "read", filePath: "README.md" },
        keepsDetail: false,
        keepsDiagnostics: true,
      },
      {
        name: "sdl.workflow",
        input: {
          repoId: "repo",
          steps: [{ fn: "repoStatus", args: {} }],
        },
        keepsDetail: true,
        keepsDiagnostics: true,
      },
    ];

    for (const testCase of cases) {
      const registered = tools.get(testCase.name);
      assert.ok(registered, testCase.name);
      const parsed = registered.schema.parse({
        ...testCase.input,
        detail: "standard",
        includeDiagnostics: true,
      }) as Record<string, unknown>;

      assert.equal(
        Object.hasOwn(parsed, "detail"),
        testCase.keepsDetail,
        testCase.name + " handler detail",
      );
      assert.equal(
        Object.hasOwn(parsed, "includeDiagnostics"),
        testCase.keepsDiagnostics,
        testCase.name + " handler includeDiagnostics",
      );
      if (testCase.keepsDetail) assert.equal(parsed.detail, "standard");
      if (testCase.keepsDiagnostics) {
        assert.equal(parsed.includeDiagnostics, true);
      }

      const detail = findJsonProperty(registered.wireSchema, "detail");
      const includeDiagnostics = findJsonProperty(
        registered.wireSchema,
        "includeDiagnostics",
      );
      assert.deepEqual(
        detail?.enum,
        ["compact", "standard", "full"],
        testCase.name + " wire detail",
      );
      assert.equal(
        includeDiagnostics?.type,
        "boolean",
        testCase.name + " wire includeDiagnostics",
      );
    }
  });

  it("retains domain-owned options and strips projection-only options at direct dispatch", () => {
    const cases = [
      {
        name: "repo.status",
        schema: RepoStatusRequestSchema,
        input: { repoId: "repo", detail: "standard", includeDiagnostics: true },
        expected: { detail: "standard", includeDiagnostics: false },
      },
      {
        name: "index.refresh",
        schema: IndexRefreshRequestSchema,
        input: {
          repoId: "repo",
          mode: "incremental",
          detail: "standard",
          includeDiagnostics: true,
        },
        expected: { detail: false, includeDiagnostics: true },
      },
      {
        name: "repo.unregister",
        schema: RepoUnregisterRequestSchema,
        input: {
          repoId: "repo",
          confirmRepoId: "repo",
          detail: "standard",
          includeDiagnostics: true,
        },
        expected: { detail: false, includeDiagnostics: false },
      },
    ];

    for (const testCase of cases) {
      const parsed = testCase.schema.parse(testCase.input) as Record<
        string,
        unknown
      >;
      assert.equal(
        Object.hasOwn(parsed, "detail"),
        testCase.expected.detail !== false,
        testCase.name + " detail",
      );
      if (testCase.expected.detail !== false) {
        assert.equal(parsed.detail, testCase.expected.detail);
      }
      assert.equal(
        Object.hasOwn(parsed, "includeDiagnostics"),
        testCase.expected.includeDiagnostics !== false,
        testCase.name + " includeDiagnostics",
      );
      if (testCase.expected.includeDiagnostics !== false) {
        assert.equal(
          parsed.includeDiagnostics,
          testCase.expected.includeDiagnostics,
        );
      }
    }
  });

  it("resolves every workflow-child precedence branch independently", () => {
    const cases = [
      {
        name: "child wins and explicit false overrides workflow true",
        workflow: { detail: "standard", includeDiagnostics: true },
        child: { detail: "full", includeDiagnostics: false },
        direct: { detail: "compact", includeDiagnostics: true },
        expected: { detail: "full", includeDiagnostics: false },
      },
      {
        name: "workflow wins when child omits options",
        workflow: { detail: "standard", includeDiagnostics: true },
        child: {},
        direct: { detail: "full", includeDiagnostics: false },
        expected: { detail: "standard", includeDiagnostics: true },
      },
      {
        name: "direct call wins when envelopes omit options",
        workflow: {},
        child: {},
        direct: { detail: "full", includeDiagnostics: true },
        expected: { detail: "full", includeDiagnostics: true },
      },
      {
        name: "profile default is the final fallback",
        workflow: {},
        child: {},
        direct: {},
        expected: { detail: "compact", includeDiagnostics: false },
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = parseWorkflowRequest({
        repoId: "repo",
        ...testCase.workflow,
        steps: [
          {
            fn: "repoStatus",
            args: testCase.direct,
            ...testCase.child,
          },
        ],
      });
      assert.equal(parsed.ok, true, testCase.name);
      if (!parsed.ok) continue;
      assert.deepEqual(
        parsed.request.steps[0]?.projectionOptions,
        testCase.expected,
        testCase.name,
      );
      assert.deepEqual(
        parsed.request.steps[0]?.args,
        testCase.direct,
        testCase.name + " options stay out of args",
      );
    }
  });

  it("passes effective options to the projector while keeping canonical results for references and usage", async () => {
    const parsed = parseWorkflowRequest({
      repoId: "repo",
      steps: [
        {
          fn: "repoStatus",
          detail: "standard",
          includeDiagnostics: false,
          args: { detail: "full", includeDiagnostics: true },
        },
        {
          fn: "repoStatus",
          args: { fromPrevious: "$0.diagnostics.detail" },
        },
      ],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const handlerArgs: Array<Record<string, unknown>> = [];
    const projectedOptions: unknown[] = [];
    const response = await executeWorkflow(
      parsed.request,
      {
        "repo.status": {
          schema: z.object({
            repoId: z.string(),
            detail: z.enum(["compact", "standard", "full"]).optional(),
            fromPrevious: z.string().optional(),
          }),
          handler: async (args: unknown) => {
            const record = args as Record<string, unknown>;
            handlerArgs.push(record);
            return {
              call: handlerArgs.length,
              diagnostics: {
                detail:
                  typeof record.detail === "string"
                    ? record.detail
                    : record.fromPrevious,
              },
              rawOnly: true,
            };
          },
        },
      },
      CODE_MODE_CONFIG as never,
      undefined,
      undefined,
      (
        _fn: string,
        result: unknown,
        _args: Record<string, unknown>,
        options?: unknown,
      ) => {
        projectedOptions.push(options);
        const record = result as Record<string, unknown>;
        return { projected: true, call: record.call };
      },
    );

    assert.equal(handlerArgs[0]?.detail, "full");
    assert.equal(
      Object.hasOwn(handlerArgs[0] ?? {}, "includeDiagnostics"),
      false,
    );
    assert.equal(handlerArgs[1]?.fromPrevious, "full");
    assert.deepEqual(projectedOptions[0], {
      detail: "standard",
      includeDiagnostics: false,
    });
    assert.deepEqual(response.results[0]?.result, { projected: true, call: 1 });
    assert.deepEqual(response.results[1]?.result, { projected: true, call: 2 });
  });
});

it("uses one exported projection option inventory for Zod and JSON composition", () => {
  const optionKeys = Object.keys(ProjectionRequestOptionShape);

  assert.deepEqual(optionKeys, ["detail", "includeDiagnostics"]);
  assert.deepEqual(ProjectionRequestOptionsSchema.keyof().options, optionKeys);
  assert.equal(
    ProjectionRequestOptionsSchema.shape.detail,
    ProjectionRequestOptionShape.detail,
  );
  assert.equal(
    ProjectionRequestOptionsSchema.shape.includeDiagnostics,
    ProjectionRequestOptionShape.includeDiagnostics,
  );

  const sharedJsonSchema = z.toJSONSchema(ProjectionRequestOptionsSchema, {
    io: "input",
  });
  const composedJsonSchema = withProjectionRequestOptionsJsonSchema(
    { type: "object", properties: {} },
    ProjectionRequestOptionsSchema,
  );
  assert.deepEqual(composedJsonSchema.properties, sharedJsonSchema.properties);
  assert.deepEqual(
    ProjectionRequestOptionsSchema.parse({
      detail: "standard",
      includeDiagnostics: false,
    }),
    { detail: "standard", includeDiagnostics: false },
  );
  assert.equal(
    ProjectionRequestOptionsSchema.safeParse({ detail: "minimal" }).success,
    false,
  );
});

it("keeps standard for projection while adapting semantic status to legacy compact detail", () => {
  const input = {
    repoId: "repo",
    detail: "standard",
    includeDiagnostics: true,
  };

  assert.deepEqual(extractProjectionRequestOptions(input), {
    detail: "standard",
    includeDiagnostics: true,
  });
  const handlerRequest = SemanticEnrichmentStatusRequestSchema.parse(input);
  assert.equal(handlerRequest.detail, "compact");
});
