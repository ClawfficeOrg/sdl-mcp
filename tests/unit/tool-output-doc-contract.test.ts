import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_INVENTORY_FILE_OPERATIONS,
  compareCodeUnits,
  extractOutputProfilesFromSources,
  extractRegisteredToolNames,
  writeInventoryOutputs,
  type ToolInventory,
} from "../../scripts/generate-tool-inventory.ts";

import { OUTPUT_BUDGET_TOKEN_LIMITS } from "../../dist/mcp/response-projection/budgets.js";
import { PROJECTION_PROFILE_REGISTRY } from "../../dist/mcp/response-projection/registry.js";
import { AGENT_OUTPUT_TOKEN_BUDGETS } from "../fixtures/response-projection/agent-output-cases.ts";

interface OutputProfileInventoryRow {
  readonly action: string;
  readonly projector: string;
  readonly budgetClass: keyof typeof OUTPUT_BUDGET_TOKEN_LIMITS;
  readonly budgetTokenLimit: number;
  readonly largeResponseStrategy: string;
  readonly recoveryPolicy: string;
  readonly observabilityProfile: string;
}

function readInventoryRows(): readonly OutputProfileInventoryRow[] {
  const inventory = JSON.parse(
    readFileSync(
      join(process.cwd(), "docs/generated/tool-inventory.json"),
      "utf8",
    ),
  ) as { outputProfiles?: OutputProfileInventoryRow[] };
  assert.ok(
    Array.isArray(inventory.outputProfiles),
    "generated inventory must include output-profile metadata",
  );
  return inventory.outputProfiles;
}

describe("tool output documentation contract", () => {
  it("extracts literal registrations through supported AST call forms", () => {
    const source = `
      function registerTools(server: unknown): void {
        server
          .registerTool(
            'sdl.qualified',
            "Qualified registration",
          );
        registerTool(
          "sdl.identifier",
          "Identifier registration",
        );
      }
    `;

    assert.deepEqual(
      extractRegisteredToolNames(
        "fixtures/registrations.ts",
        source,
        ["registerTools"],
      ),
      ["sdl.identifier", "sdl.qualified"],
    );
  });

  it("fails closed for dynamic or empty expected registration containers", () => {
    assert.throws(
      () =>
        extractRegisteredToolNames(
          "fixtures/dynamic.ts",
          `function registerTools(server: unknown, name: string) {
            server.registerTool(name, "dynamic");
          }`,
          ["registerTools"],
        ),
      /fixtures\/dynamic\.ts.*registerTools.*literal first argument/s,
    );
    assert.throws(
      () =>
        extractRegisteredToolNames(
          "fixtures/empty.ts",
          "function registerTools(): void {}",
          ["registerTools"],
        ),
      /fixtures\/empty\.ts.*registerTools.*zero recognized registrations/s,
    );
  });

  it("rejects malformed registry and budget TypeScript before extraction", () => {
    assert.throws(
      () =>
        extractOutputProfilesFromSources(
          "const PROFILE_ENTRIES = [",
          "export const OUTPUT_BUDGET_TOKEN_LIMITS = Object.freeze({ compact: 1 });",
        ),
      /registry\.ts.*parse diagnostics/s,
    );
    assert.throws(
      () =>
        extractOutputProfilesFromSources(
          "const PROFILE_ENTRIES = [];",
          "export const OUTPUT_BUDGET_TOKEN_LIMITS = Object.freeze({",
        ),
      /budgets\.ts.*parse diagnostics/s,
    );
  });

  it("uses one code-unit comparator for mixed punctuation and case", () => {
    const values = ["a", "A", "a.b", "a-b", "_a", "0", "Z"];
    assert.deepEqual(values.sort(compareCodeUnits), [
      "0",
      "A",
      "Z",
      "_a",
      "a",
      "a-b",
      "a.b",
    ]);
  });

  it("keeps generated JSON keys and action rows in exact code-unit order", () => {
    const inventory = JSON.parse(
      readFileSync(
        join(process.cwd(), "docs/generated/tool-inventory.json"),
        "utf8",
      ),
    ) as ToolInventory;

    assert.deepEqual(Object.keys(inventory), [
      "generatedAt",
      "counts",
      "flatToolNames",
      "universalToolNames",
      "codeModeToolNames",
      "gatewayToolNames",
      "outputProfiles",
    ]);
    assert.deepEqual(Object.keys(inventory.counts), [
      "flatTools",
      "universalTools",
      "codeModeTools",
      "gatewayTools",
      "flatModeTotal",
      "gatewayModeTotal",
      "gatewayLegacyModeTotal",
      "codeModeExclusiveTotal",
      "allFlatAndCodeModeActions",
      "outputProfiles",
    ]);
    for (const row of inventory.outputProfiles) {
      assert.deepEqual(Object.keys(row), [
        "action",
        "projector",
        "budgetClass",
        "largeResponseStrategy",
        "recoveryPolicy",
        "observabilityProfile",
        "budgetTokenLimit",
      ]);
    }
    for (const names of [
      inventory.flatToolNames,
      inventory.universalToolNames,
      inventory.codeModeToolNames,
      inventory.gatewayToolNames,
      inventory.outputProfiles.map((row) => row.action),
    ]) {
      assert.deepEqual(names, [...names].sort(compareCodeUnits));
    }
  });

  it("leaves both outputs unchanged when staging the second file fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "sdl-tool-inventory-"));
    const jsonPath = join(directory, "tool-inventory.json");
    const markdownPath = join(directory, "tool-inventory.md");
    const originalJson = "{\"original\":\"json\"}\n";
    const originalMarkdown = "original markdown\n";
    writeFileSync(jsonPath, originalJson, "utf8");
    writeFileSync(markdownPath, originalMarkdown, "utf8");

    try {
      const inventory = JSON.parse(
        readFileSync(
          join(process.cwd(), "docs/generated/tool-inventory.json"),
          "utf8",
        ),
      ) as ToolInventory;
      let stagedWrites = 0;

      assert.throws(
        () =>
          writeInventoryOutputs(
            inventory,
            { jsonPath, markdownPath },
            {
              ...DEFAULT_INVENTORY_FILE_OPERATIONS,
              writeFileExclusive(path, content) {
                stagedWrites += 1;
                if (stagedWrites === 2) {
                  throw new Error("injected second-stage failure");
                }
                DEFAULT_INVENTORY_FILE_OPERATIONS.writeFileExclusive(
                  path,
                  content,
                );
              },
            },
          ),
        /injected second-stage failure/,
      );
      assert.equal(readFileSync(jsonPath, "utf8"), originalJson);
      assert.equal(readFileSync(markdownPath, "utf8"), originalMarkdown);
      assert.deepEqual(
        readdirSync(directory).sort(compareCodeUnits),
        ["tool-inventory.json", "tool-inventory.md"],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("can be imported through a Windows path without running the CLI", () => {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), "scripts/generate-tool-inventory.ts"),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("keeps the generated JSON profile rows identical to the closed registry", () => {
    const expected = Object.entries(PROJECTION_PROFILE_REGISTRY)
      .map(([action, profile]) => ({
        action,
        projector: profile.projector,
        budgetClass: profile.budgetClass,
        budgetTokenLimit: OUTPUT_BUDGET_TOKEN_LIMITS[profile.budgetClass],
        largeResponseStrategy: profile.largeResponseStrategy,
        recoveryPolicy: profile.recoveryPolicy,
        observabilityProfile: profile.observabilityProfile,
      }))
      .sort((left, right) => compareCodeUnits(left.action, right.action));

    assert.deepEqual(readInventoryRows(), expected);
  });

  it("keeps the tracked action/profile authoring table synchronized", () => {
    const markdown = readFileSync(
      join(process.cwd(), "docs/generated/tool-inventory.md"),
      "utf8",
    );
    assert.match(markdown, /^## Output Contract Profiles$/m);

    for (const row of readInventoryRows()) {
      const expectedRow =
        `| \`${row.action}\` | \`${row.projector}\` | \`${row.budgetClass}\` (${row.budgetTokenLimit}) | \`${row.largeResponseStrategy}\` | \`${row.recoveryPolicy}\` | \`${row.observabilityProfile}\` |`;
      assert.ok(markdown.includes(expectedRow), `missing documentation row: ${row.action}`);
    }
  });

  it("resolves fixture and profile budget names through the canonical budget map", () => {
    const actualFixtureTotals = Object.fromEntries(
      Object.keys(OUTPUT_BUDGET_TOKEN_LIMITS).map((name) => [
        name,
        AGENT_OUTPUT_TOKEN_BUDGETS[
          name as keyof typeof AGENT_OUTPUT_TOKEN_BUDGETS
        ],
      ]),
    );
    const allowedRegistryTotals = { ...OUTPUT_BUDGET_TOKEN_LIMITS };

    assert.deepEqual(
      actualFixtureTotals,
      allowedRegistryTotals,
      `actual fixture totals=${JSON.stringify(actualFixtureTotals)}; allowed registry totals=${JSON.stringify(allowedRegistryTotals)}; update fixtures and generated docs intentionally`,
    );

    for (const row of readInventoryRows()) {
      assert.equal(
        row.budgetTokenLimit,
        OUTPUT_BUDGET_TOKEN_LIMITS[row.budgetClass],
        `${row.action}: budget class ${row.budgetClass} must resolve through budgets.ts`,
      );
    }
  });
});
