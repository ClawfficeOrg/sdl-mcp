#!/usr/bin/env node
/**
 * generate-tool-inventory.ts
 *
 * Statically extracts tool names from source files and produces a generated
 * inventory (JSON + Markdown) under docs/generated/.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generate-tool-inventory.ts
 *
 * The script parses source files directly (no build required) and writes:
 *   - docs/generated/tool-inventory.json
 *   - docs/generated/tool-inventory.md
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TOOL_DESCRIPTORS_PATH = resolve(ROOT, "src", "mcp", "tools", "tool-descriptors.ts");
const CODE_MODE_PATH = resolve(ROOT, "src", "code-mode", "index.ts");
const GATEWAY_PATH = resolve(ROOT, "src", "gateway", "index.ts");
const TOOLS_INDEX_PATH = resolve(ROOT, "src", "mcp", "tools", "index.ts");
const OUT_DIR = resolve(ROOT, "docs", "generated");
const OUT_JSON = resolve(OUT_DIR, "tool-inventory.json");
const OUT_MD = resolve(OUT_DIR, "tool-inventory.md");

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract all `name: "sdl.xxx"` values from the flat tool descriptors file.
 */
function extractFlatToolNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "tool-descriptors.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let projections: ts.ArrayLiteralExpression | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "projections"
      && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      projections = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!projections) {
    throw new Error("Could not find the flat tool descriptor projections");
  }

  return projections.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error("Flat tool descriptor projection must be an object literal");
    }
    const action = element.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && property.name.text === "action",
    );
    if (!action || !ts.isStringLiteralLike(action.initializer)) {
      throw new Error("Flat tool descriptor projection is missing a literal action");
    }
    return `sdl.${action.initializer.text}`;
  });
}

/**
 * Extract tool names registered via `server.registerTool("sdl.xxx", ...)` or
 * `registerTool("sdl.xxx", ...)` from a source file.
 */
function extractRegisteredToolNames(source: string): string[] {
  const re = /registerTool\(\s*"(sdl\.[^"]+)"/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function normalizeToolNames(names: string[]): string[] {
  return [...new Set(names)].sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // Read source files
  let toolDescriptorsSource: string;
  let codeModeSource: string;
  let gatewaySource: string;
  let toolsIndexSource: string;

  try {
    toolDescriptorsSource = readFileSync(TOOL_DESCRIPTORS_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${TOOL_DESCRIPTORS_PATH}`);
    process.exit(1);
  }
  try {
    codeModeSource = readFileSync(CODE_MODE_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${CODE_MODE_PATH}`);
    process.exit(1);
  }
  try {
    gatewaySource = readFileSync(GATEWAY_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${GATEWAY_PATH}`);
    process.exit(1);
  }
  try {
    toolsIndexSource = readFileSync(TOOLS_INDEX_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${TOOLS_INDEX_PATH}`);
    process.exit(1);
  }

  // --- Flat tools (from tool-descriptors.ts) ---
  const flatToolNames = normalizeToolNames(extractFlatToolNames(toolDescriptorsSource));
  const flatToolCount = flatToolNames.length;

  // --- Universal tools (shared across every mode) ---
  // sdl.info is registered directly in tools/index.ts via registerTool.
  // sdl.action.search is registered via registerActionSearchTool.
  const universalToolNames = normalizeToolNames([
    "sdl.action.search",
    ...extractRegisteredToolNames(toolsIndexSource),
  ]);
  const universalToolCount = universalToolNames.length;

  // --- Code-mode tools (registered in code-mode/index.ts) ---
  const codeModeRegistered = normalizeToolNames(extractRegisteredToolNames(codeModeSource));
  // The code-mode file registers: sdl.action.search, sdl.manual, sdl.workflow, sdl.context
  const codeModeToolNames = codeModeRegistered.length > 0
    ? codeModeRegistered
    : normalizeToolNames(["sdl.action.search", "sdl.context", "sdl.manual", "sdl.workflow"]);
  const codeModeToolCount = codeModeToolNames.length;

  // --- Gateway tools (registered in gateway/index.ts) ---
  const gatewayRegistered = normalizeToolNames(extractRegisteredToolNames(gatewaySource));
  // The gateway file registers: sdl.query, sdl.code, sdl.repo, sdl.agent
  const gatewayToolNames = gatewayRegistered.length > 0
    ? gatewayRegistered
    : normalizeToolNames(["sdl.query", "sdl.code", "sdl.repo", "sdl.agent"]);
  const gatewayToolCount = gatewayToolNames.length;

  // --- Compute totals ---
  // Flat mode: universal tools + flat tools
  const flatModeTotal = universalToolCount + flatToolCount;

  // Gateway mode: universal tools + gateway tools (no flat tools)
  const gatewayModeTotal = universalToolCount + gatewayToolCount;

  // Gateway + legacy mode: universal tools + gateway tools + flat tools
  const gatewayLegacyModeTotal = universalToolCount + gatewayToolCount + flatToolCount;

  const codeModeExclusiveToolNames = normalizeToolNames([
    ...universalToolNames,
    ...codeModeToolNames,
  ]);
  const codeModeExclusiveTotal = codeModeExclusiveToolNames.length;

  // All unique action names across flat + exclusive Code Mode.
  const allFlatAndCodeModeNames = new Set([
    ...flatToolNames,
    ...codeModeExclusiveToolNames,
  ]);
  const allFlatAndCodeModeActions = allFlatAndCodeModeNames.size;

  // --- Build JSON output ---
  const inventory = {
    generatedAt: new Date().toISOString(),
    counts: {
      flatTools: flatToolCount,
      universalTools: universalToolCount,
      codeModeTools: codeModeToolCount,
      gatewayTools: gatewayToolCount,
      flatModeTotal,
      gatewayModeTotal,
      gatewayLegacyModeTotal,
      codeModeExclusiveTotal,
      allFlatAndCodeModeActions,
    },
    flatToolNames,
    universalToolNames,
    codeModeToolNames,
    gatewayToolNames,
  };

  // --- Write outputs ---
  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(OUT_JSON, JSON.stringify(inventory, null, 2) + "\n", "utf-8");

  const md = buildMarkdown(inventory);
  writeFileSync(OUT_MD, md, "utf-8");

  // --- Print summary ---
  console.log("Tool Inventory Generated");
  console.log("========================");
  console.log(`  Flat tools:                ${flatToolCount}`);
  console.log(`  Universal tools:           ${universalToolCount}`);
  console.log(`  Code-mode tools:           ${codeModeToolCount}`);
  console.log(`  Gateway tools:             ${gatewayToolCount}`);
  console.log("");
  console.log("Mode totals:");
  console.log(`  Flat mode:                 ${flatModeTotal} (universal + flat)`);
  console.log(`  Gateway mode:              ${gatewayModeTotal} (universal + gateway)`);
  console.log(`  Gateway + legacy mode:     ${gatewayLegacyModeTotal} (universal + gateway + flat)`);
  console.log(`  Code-mode exclusive:       ${codeModeExclusiveTotal}`);
  console.log(`  All flat + code-mode actions:        ${allFlatAndCodeModeActions}`);
  console.log("");
  console.log(`Written:`);
  console.log(`  ${OUT_JSON}`);
  console.log(`  ${OUT_MD}`);
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(inventory: {
  generatedAt: string;
  counts: Record<string, number>;
  flatToolNames: string[];
  universalToolNames: string[];
  codeModeToolNames: string[];
  gatewayToolNames: string[];
}): string {
  const lines: string[] = [];
  const codeModeExclusiveToolNames = normalizeToolNames([
    ...inventory.universalToolNames,
    ...inventory.codeModeToolNames,
  ]);

  lines.push("# SDL-MCP Tool Inventory");
  lines.push("");
  lines.push(`> Auto-generated by \`scripts/generate-tool-inventory.ts\` on ${inventory.generatedAt}`);
  lines.push(`>`);
  lines.push(`> Do not edit manually. Run \`npm run docs:tools:generate\` to regenerate.`);
  lines.push("");

  lines.push("## Counts by Mode");
  lines.push("");
  lines.push("| Mode | Tool Count | Composition |");
  lines.push("|------|-----------|-------------|");
  lines.push(`| Flat (default) | ${inventory.counts.flatModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.flatTools} flat |`);
  lines.push(`| Gateway | ${inventory.counts.gatewayModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.gatewayTools} gateway |`);
  lines.push(`| Gateway + legacy | ${inventory.counts.gatewayLegacyModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.gatewayTools} gateway + ${inventory.counts.flatTools} flat |`);
  lines.push(`| Code Mode exclusive | ${inventory.counts.codeModeExclusiveTotal} | ${codeModeExclusiveToolNames.map((name) => `\`${name}\``).join(", ")} |`);
  lines.push(`| All unique actions | ${inventory.counts.allFlatAndCodeModeActions} | flat + code-mode unique |`);
  lines.push("");

  lines.push("## Universal Tools");
  lines.push("");
  lines.push("Shared across every mode, including Code Mode exclusive.");
  lines.push("");
  for (const name of inventory.universalToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  lines.push(`## Flat Tools (${inventory.flatToolNames.length})`);
  lines.push("");
  lines.push("Registered in flat mode (default) via `tool-descriptors.ts`.");
  lines.push("");
  for (const name of inventory.flatToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  lines.push(`## Code-Mode Tools (${inventory.codeModeToolNames.length})`);
  lines.push("");
  lines.push("Registered when Code Mode is enabled. Exclusive mode also includes the universal tools above.");
  lines.push("");
  for (const name of inventory.codeModeToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  lines.push(`## Gateway Tools (${inventory.gatewayToolNames.length})`);
  lines.push("");
  lines.push("Registered when gateway mode is enabled.");
  lines.push("");
  for (const name of inventory.gatewayToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  return lines.join("\n");
}

main();
