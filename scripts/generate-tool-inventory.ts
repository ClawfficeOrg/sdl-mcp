#!/usr/bin/env node
/**
 * Generate or verify the tracked tool and model-output contract inventory.
 *
 * The generator statically parses source so contributor checks do not depend
 * on importing the built server or executing tool handlers.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export interface OutputProfileInventoryRow {
  readonly action: string;
  readonly projector: string;
  readonly budgetClass: string;
  readonly budgetTokenLimit: number;
  readonly largeResponseStrategy: string;
  readonly recoveryPolicy: string;
  readonly observabilityProfile: string;
}

export interface ToolInventory {
  readonly generatedAt: string;
  readonly counts: Record<string, number>;
  readonly flatToolNames: string[];
  readonly universalToolNames: string[];
  readonly codeModeToolNames: string[];
  readonly gatewayToolNames: string[];
  readonly outputProfiles: OutputProfileInventoryRow[];
}

export interface InventoryOutputPaths {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export interface InventoryFileOperations {
  readonly exists: (path: string) => boolean;
  readonly writeFileExclusive: (path: string, content: string) => void;
  readonly rename: (source: string, destination: string) => void;
  readonly remove: (path: string) => void;
}

export const DEFAULT_INVENTORY_FILE_OPERATIONS: InventoryFileOperations = Object.freeze({
  exists: existsSync,
  writeFileExclusive(path, content) {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  },
  rename: renameSync,
  remove(path) {
    rmSync(path, { force: true });
  },
});

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface OutputContractObligationInventories {
  readonly profileRegistryActions?: ReadonlySet<string>;
  readonly generatedInventoryActions?: ReadonlySet<string>;
  readonly fixtureActions?: ReadonlySet<string>;
  readonly compactDeterminismActions?: ReadonlySet<string>;
  readonly fullDeterminismActions?: ReadonlySet<string>;
  readonly observabilityExtractorActions?: ReadonlySet<string>;
  readonly budgetStrategyActions?: ReadonlySet<string>;
  readonly budgetFixtureActions?: ReadonlySet<string>;
  readonly largeResponseStrategyActions?: ReadonlySet<string>;
  readonly recoveryPolicyActions?: ReadonlySet<string>;
  readonly schemaActions?: ReadonlySet<string>;
  readonly projectorActions?: ReadonlySet<string>;
  readonly documentationActions?: ReadonlySet<string>;
}

const OUTPUT_CONTRACT_OBLIGATIONS = [
  ["profileRegistryActions", "profile registry entry"],
  ["generatedInventoryActions", "generated inventory row"],
  ["fixtureActions", "agent-output fixture"],
  ["compactDeterminismActions", "compact determinism entry"],
  ["fullDeterminismActions", "full determinism entry"],
  ["observabilityExtractorActions", "observability extractor"],
  ["budgetStrategyActions", "budget strategy"],
  ["budgetFixtureActions", "budget fixture"],
  ["largeResponseStrategyActions", "large-response strategy"],
  ["recoveryPolicyActions", "recovery policy"],
  ["schemaActions", "output schema"],
  ["projectorActions", "projector"],
  ["documentationActions", "documentation row"],
] as const satisfies readonly [
  keyof OutputContractObligationInventories,
  string,
][];

/**
 * Report every missing obligation supplied by the caller. Optional inventories
 * let each check path name only contracts it actually inspected.
 */
export function auditOutputContractObligations(
  action: string,
  inventories: Readonly<OutputContractObligationInventories>,
): string[] {
  const diagnostics: string[] = [];
  for (const [inventoryName, obligation] of OUTPUT_CONTRACT_OBLIGATIONS) {
    const inventory = inventories[inventoryName];
    if (inventory !== undefined && !inventory.has(action)) {
      diagnostics.push(`${action}: missing ${obligation}`);
    }
  }
  return diagnostics;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TOOL_DESCRIPTORS_PATH = resolve(ROOT, "src", "mcp", "tools", "tool-descriptors.ts");
const CODE_MODE_PATH = resolve(ROOT, "src", "code-mode", "index.ts");
const GATEWAY_PATH = resolve(ROOT, "src", "gateway", "index.ts");
const TOOLS_INDEX_PATH = resolve(ROOT, "src", "mcp", "tools", "index.ts");
const PROFILE_REGISTRY_PATH = resolve(ROOT, "src", "mcp", "response-projection", "registry.ts");
const BUDGETS_PATH = resolve(ROOT, "src", "mcp", "response-projection", "budgets.ts");
const OUT_JSON = resolve(ROOT, "docs", "generated", "tool-inventory.json");
const OUT_MD = resolve(ROOT, "docs", "generated", "tool-inventory.md");

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function parseSource(sourceName: string, source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    sourceName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostics = sourceFile.parseDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join("; ");
    throw new Error(`${sourceName}: parse diagnostics: ${diagnostics}`);
  }
  return sourceFile;
}

function declarations(sourceName: string, source: string): Map<string, ts.Expression> {
  const sourceFile = parseSource(sourceName, source);
  const result = new Map<string, ts.Expression>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      result.set(node.name.text, unwrap(node.initializer));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function nameOf(property: ts.ObjectLiteralElementLike): string | undefined {
  if (
    !ts.isPropertyAssignment(property)
    && !ts.isShorthandPropertyAssignment(property)
    && !ts.isMethodDeclaration(property)
  ) {
    return undefined;
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
    ? property.name.text
    : undefined;
}

function stringLiteral(
  expression: ts.Expression | undefined,
  obligation: string,
): string {
  if (!expression || !ts.isStringLiteralLike(unwrap(expression))) {
    throw new Error(`missing ${obligation}: expected a string literal`);
  }
  return (unwrap(expression) as ts.StringLiteralLike).text;
}

function numericValue(
  expression: ts.Expression,
  values: ReadonlyMap<string, number>,
): number | undefined {
  const candidate = unwrap(expression);
  if (ts.isNumericLiteral(candidate)) {
    return Number(candidate.text);
  }
  if (ts.isIdentifier(candidate)) {
    return values.get(candidate.text);
  }
  return undefined;
}

function extractBudgetLimits(source: string): Readonly<Record<string, number>> {
  const sourceDeclarations = declarations("budgets.ts", source);
  const values = new Map<string, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of sourceDeclarations) {
      if (values.has(name)) {
        continue;
      }
      const value = numericValue(initializer, values);
      if (value !== undefined) {
        values.set(name, value);
        changed = true;
      }
    }
  }

  const frozen = sourceDeclarations.get("OUTPUT_BUDGET_TOKEN_LIMITS");
  if (!frozen || !ts.isCallExpression(frozen)) {
    throw new Error("missing budget strategy: OUTPUT_BUDGET_TOKEN_LIMITS");
  }
  const object = frozen.arguments[0] && unwrap(frozen.arguments[0]);
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw new Error("missing budget strategy: canonical budget object");
  }

  const budgets: Record<string, number> = {};
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = nameOf(property);
    const value = numericValue(property.initializer, values);
    if (!name || value === undefined) {
      throw new Error(`missing budget strategy: unresolved ${name ?? "budget"}`);
    }
    budgets[name] = value;
  }
  return Object.freeze(budgets);
}

export function extractOutputProfilesFromSources(
  registrySource: string,
  budgetSource: string,
): OutputProfileInventoryRow[] {
  const sourceDeclarations = declarations("registry.ts", registrySource);
  const budgets = extractBudgetLimits(budgetSource);
  const profiles = new Map<
    string,
    Omit<OutputProfileInventoryRow, "action" | "budgetTokenLimit">
  >();

  for (const [name, initializer] of sourceDeclarations) {
    if (
      !ts.isCallExpression(initializer)
      || !ts.isIdentifier(initializer.expression)
      || initializer.expression.text !== "profile"
    ) {
      continue;
    }
    const args = initializer.arguments;
    profiles.set(name, {
      projector: stringLiteral(args[0], `${name} projector`),
      budgetClass: stringLiteral(args[1], `${name} budget strategy`),
      largeResponseStrategy: stringLiteral(
        args[2],
        `${name} large-response strategy`,
      ),
      recoveryPolicy: stringLiteral(args[3], `${name} recovery policy`),
      observabilityProfile: stringLiteral(
        args[4],
        `${name} observability extractor`,
      ),
    });
  }

  const extractorCall = sourceDeclarations.get(
    "PROJECTION_OBSERVABILITY_EXTRACTORS",
  );
  if (!extractorCall || !ts.isCallExpression(extractorCall)) {
    throw new Error("missing observability extractor registry");
  }
  const extractorObject =
    extractorCall.arguments[0] && unwrap(extractorCall.arguments[0]);
  if (!extractorObject || !ts.isObjectLiteralExpression(extractorObject)) {
    throw new Error("missing observability extractor registry object");
  }
  const extractors = new Set(
    extractorObject.properties
      .map(nameOf)
      .filter((name): name is string => name !== undefined),
  );

  const entries = sourceDeclarations.get("PROFILE_ENTRIES");
  if (!entries || !ts.isArrayLiteralExpression(entries)) {
    throw new Error("missing profile registry entry: PROFILE_ENTRIES");
  }

  return entries.elements
    .map((element): OutputProfileInventoryRow => {
      const tuple = unwrap(element);
      if (!ts.isArrayLiteralExpression(tuple) || tuple.elements.length !== 2) {
        throw new Error("missing profile registry entry tuple");
      }
      const action = stringLiteral(tuple.elements[0], "profile registry action");
      const profileReference = unwrap(tuple.elements[1]);
      if (!ts.isIdentifier(profileReference)) {
        throw new Error(`${action}: missing profile registry entry reference`);
      }
      const profile = profiles.get(profileReference.text);
      if (!profile) {
        throw new Error(`${action}: missing profile metadata`);
      }
      const budgetTokenLimit = budgets[profile.budgetClass];
      if (budgetTokenLimit === undefined) {
        throw new Error(
          `${action}: missing budget strategy ${profile.budgetClass}`,
        );
      }
      if (!extractors.has(profile.observabilityProfile)) {
        throw new Error(
          `${action}: missing observability extractor ${profile.observabilityProfile}`,
        );
      }
      return { action, ...profile, budgetTokenLimit };
    })
    .sort((left, right) => compareCodeUnits(left.action, right.action));
}

function extractFlatToolNames(source: string): string[] {
  const projections = declarations("tool-descriptors.ts", source).get(
    "projections",
  );
  if (!projections || !ts.isArrayLiteralExpression(projections)) {
    throw new Error("missing flat tool descriptor projections");
  }
  return projections.elements.map((element) => {
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) {
      throw new Error("flat tool projection must be an object literal");
    }
    const action = object.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && nameOf(property) === "action",
    );
    return `sdl.${stringLiteral(action?.initializer, "flat tool action")}`;
  });
}

function isSupportedRegisterToolCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "registerTool";
  }
  return (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "server"
    && expression.name.text === "registerTool"
  );
}

/**
 * Extract literal registrations only from the named public registration
 * containers. Proxy forwarding such as target.registerTool(name, ...) is not a
 * public registration and is deliberately ignored.
 */
export function extractRegisteredToolNames(
  sourcePath: string,
  source: string,
  expectedContainers: readonly string[],
): string[] {
  const sourceFile = parseSource(sourcePath, source);
  const expected = new Set(expectedContainers);
  const found = new Set<string>();
  const recognized = new Map<string, number>();
  const names: string[] = [];

  function visitContainer(node: ts.Node, container: string): void {
    if (
      ts.isCallExpression(node)
      && isSupportedRegisterToolCallee(node.expression)
    ) {
      const firstArgument = node.arguments[0];
      if (!firstArgument || !ts.isStringLiteralLike(unwrap(firstArgument))) {
        throw new Error(
          `${sourcePath}: ${container}: registerTool requires a literal first argument`,
        );
      }
      const action = (unwrap(firstArgument) as ts.StringLiteralLike).text;
      if (!action.startsWith("sdl.")) {
        throw new Error(
          `${sourcePath}: ${container}: registerTool literal must start with sdl.`,
        );
      }
      names.push(action);
      recognized.set(container, (recognized.get(container) ?? 0) + 1);
    }
    ts.forEachChild(node, (child) => visitContainer(child, container));
  }

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && expected.has(node.name.text)
    ) {
      const container = node.name.text;
      found.add(container);
      visitContainer(node, container);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  for (const container of expectedContainers) {
    if (!found.has(container)) {
      throw new Error(
        `${sourcePath}: missing expected registration container ${container}`,
      );
    }
    if ((recognized.get(container) ?? 0) === 0) {
      throw new Error(
        `${sourcePath}: ${container}: zero recognized registrations`,
      );
    }
  }
  return sortedUnique(names);
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort(compareCodeUnits);
}

export function buildInventory(generatedAt = new Date().toISOString()): ToolInventory {
  const flatToolNames = sortedUnique(
    extractFlatToolNames(readFileSync(TOOL_DESCRIPTORS_PATH, "utf8")),
  );
  const universalToolNames = sortedUnique([
    "sdl.action.search",
    ...extractRegisteredToolNames(
      TOOLS_INDEX_PATH,
      readFileSync(TOOLS_INDEX_PATH, "utf8"),
      ["registerTools"],
    ),
  ]);
  const codeModeToolNames = sortedUnique(
    extractRegisteredToolNames(
      CODE_MODE_PATH,
      readFileSync(CODE_MODE_PATH, "utf8"),
      ["registerActionSearchTool", "registerCodeModeTools"],
    ),
  );
  const gatewayToolNames = sortedUnique(
    extractRegisteredToolNames(
      GATEWAY_PATH,
      readFileSync(GATEWAY_PATH, "utf8"),
      ["registerGatewayTools"],
    ),
  );
  const codeModeExclusive = sortedUnique([
    ...universalToolNames,
    ...codeModeToolNames,
  ]);
  const outputProfiles = extractOutputProfilesFromSources(
    readFileSync(PROFILE_REGISTRY_PATH, "utf8"),
    readFileSync(BUDGETS_PATH, "utf8"),
  );

  return {
    generatedAt,
    counts: {
      flatTools: flatToolNames.length,
      universalTools: universalToolNames.length,
      codeModeTools: codeModeToolNames.length,
      gatewayTools: gatewayToolNames.length,
      flatModeTotal: universalToolNames.length + flatToolNames.length,
      gatewayModeTotal: universalToolNames.length + gatewayToolNames.length,
      gatewayLegacyModeTotal:
        universalToolNames.length + gatewayToolNames.length + flatToolNames.length,
      codeModeExclusiveTotal: codeModeExclusive.length,
      allFlatAndCodeModeActions: new Set([
        ...flatToolNames,
        ...codeModeExclusive,
      ]).size,
      outputProfiles: outputProfiles.length,
    },
    flatToolNames,
    universalToolNames,
    codeModeToolNames,
    gatewayToolNames,
    outputProfiles,
  };
}

export function buildMarkdown(inventory: ToolInventory): string {
  const lines: string[] = [
    "# SDL-MCP Tool Inventory",
    "",
    `> Auto-generated by \`scripts/generate-tool-inventory.ts\` on ${inventory.generatedAt}`,
    ">",
    "> Do not edit manually. Run `npm run docs:tools:generate` to regenerate.",
    "",
    "## Counts by Mode",
    "",
    "| Mode | Tool Count | Composition |",
    "|------|-----------|-------------|",
    `| Flat (default) | ${inventory.counts.flatModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.flatTools} flat |`,
    `| Gateway | ${inventory.counts.gatewayModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.gatewayTools} gateway |`,
    `| Gateway + legacy | ${inventory.counts.gatewayLegacyModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.gatewayTools} gateway + ${inventory.counts.flatTools} flat |`,
    `| Code Mode exclusive | ${inventory.counts.codeModeExclusiveTotal} | ${sortedUnique([...inventory.universalToolNames, ...inventory.codeModeToolNames]).map((name) => `\`${name}\``).join(", ")} |`,
    `| All unique actions | ${inventory.counts.allFlatAndCodeModeActions} | flat + code-mode unique |`,
    "",
  ];

  const sections: readonly [string, string, readonly string[]][] = [
    ["Universal Tools", "Shared across every mode, including Code Mode exclusive.", inventory.universalToolNames],
    [`Flat Tools (${inventory.flatToolNames.length})`, "Registered in flat mode (default) via `tool-descriptors.ts`.", inventory.flatToolNames],
    [`Code-Mode Tools (${inventory.codeModeToolNames.length})`, "Registered when Code Mode is enabled. Exclusive mode also includes the universal tools above.", inventory.codeModeToolNames],
    [`Gateway Tools (${inventory.gatewayToolNames.length})`, "Registered when gateway mode is enabled.", inventory.gatewayToolNames],
  ];
  for (const [heading, description, names] of sections) {
    lines.push(`## ${heading}`, "", description, "");
    for (const name of names) {
      lines.push(`- \`${name}\``);
    }
    lines.push("");
  }

  lines.push(
    "## Output Contract Profiles",
    "",
    "This generated table is the contributor-facing action/profile inventory. Budget totals resolve from `budgets.ts`.",
    "",
    "| Action | Projector | Budget Class (tokens) | Large Response | Recovery | Observability |",
    "|--------|-----------|-----------------------|----------------|----------|---------------|",
  );
  for (const row of inventory.outputProfiles) {
    lines.push(
      `| \`${row.action}\` | \`${row.projector}\` | \`${row.budgetClass}\` (${row.budgetTokenLimit}) | \`${row.largeResponseStrategy}\` | \`${row.recoveryPolicy}\` | \`${row.observabilityProfile}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function comparableInventory(inventory: ToolInventory): Omit<ToolInventory, "generatedAt"> {
  const { generatedAt: _generatedAt, ...comparable } = inventory;
  return comparable;
}

function runCheck(): void {
  const committed = JSON.parse(
    readFileSync(OUT_JSON, "utf8"),
  ) as ToolInventory;
  const expected = buildInventory(committed.generatedAt);
  const markdown = readFileSync(OUT_MD, "utf8");
  const sourceActions = new Set(
    expected.outputProfiles.map(({ action }) => action),
  );
  const generatedInventoryActions = new Set(
    (committed.outputProfiles ?? []).map(({ action }) => action),
  );
  const documentationActions = new Set(
    [...sourceActions].filter((action) =>
      markdown.includes(`| \`${action}\` |`)
    ),
  );
  const obligationDiagnostics = [...sourceActions].flatMap((action) =>
    auditOutputContractObligations(action, {
      generatedInventoryActions,
      documentationActions,
    })
  );
  const jsonMatches =
    JSON.stringify(comparableInventory(committed))
    === JSON.stringify(comparableInventory(expected));
  const markdownMatches = markdown === buildMarkdown(expected);

  if (
    obligationDiagnostics.length > 0
    || !jsonMatches
    || !markdownMatches
  ) {
    console.error("check-tool-inventory: DRIFT DETECTED");
    for (const diagnostic of obligationDiagnostics) {
      console.error(`  ${diagnostic}`);
    }
    if (!jsonMatches) {
      console.error("  generated inventory serialization differs from source");
    }
    if (!markdownMatches) {
      console.error("  generated documentation serialization differs from source");
    }
    console.error("Run 'npm run docs:tools:generate' to update.");
    process.exitCode = 1;
    return;
  }
  console.log("check-tool-inventory: OK -- inventory and output contract match source");
}

let inventoryTempSequence = 0;

function siblingTemporaryPath(
  target: string,
  kind: "stage" | "backup",
  operations: InventoryFileOperations,
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    inventoryTempSequence += 1;
    const candidate =
      `${target}.${process.pid}.${inventoryTempSequence}.${kind}.tmp`;
    if (!operations.exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${target}: unable to allocate sibling temporary file`);
}

function cleanupPaths(
  paths: readonly string[],
  operations: InventoryFileOperations,
): unknown[] {
  const errors: unknown[] = [];
  for (const path of paths) {
    try {
      if (operations.exists(path)) {
        operations.remove(path);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function writeInventoryOutputs(
  inventory: ToolInventory,
  paths: InventoryOutputPaths,
  operations: InventoryFileOperations = DEFAULT_INVENTORY_FILE_OPERATIONS,
): void {
  const outputs = [
    {
      target: paths.jsonPath,
      content: `${JSON.stringify(inventory, null, 2)}\n`,
    },
    {
      target: paths.markdownPath,
      content: buildMarkdown(inventory),
    },
  ];
  const pending = outputs.map(({ target }) => ({
    target,
    stage: siblingTemporaryPath(target, "stage", operations),
    backup: undefined as string | undefined,
    committed: false,
  }));
  const staged: string[] = [];

  try {
    for (let index = 0; index < outputs.length; index += 1) {
      operations.writeFileExclusive(
        pending[index].stage,
        outputs[index].content,
      );
      staged.push(pending[index].stage);
    }
  } catch (error) {
    const cleanupErrors = cleanupPaths(staged, operations);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "inventory staging failed and temporary cleanup was incomplete",
      );
    }
    throw error;
  }

  try {
    for (const output of pending) {
      if (operations.exists(output.target)) {
        output.backup = siblingTemporaryPath(
          output.target,
          "backup",
          operations,
        );
        operations.rename(output.target, output.backup);
      }
      operations.rename(output.stage, output.target);
      output.committed = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const output of [...pending].reverse()) {
      try {
        if (output.committed && operations.exists(output.target)) {
          operations.remove(output.target);
        }
        if (output.backup && operations.exists(output.backup)) {
          operations.rename(output.backup, output.target);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    rollbackErrors.push(...cleanupPaths(
      pending.map(({ stage }) => stage),
      operations,
    ));
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "inventory commit failed and rollback was incomplete",
      );
    }
    throw error;
  }

  // A process crash between the two renames can leave a recoverable sibling
  // backup; all synchronous commit failures above are rolled back.
  const cleanupErrors = cleanupPaths(
    pending.flatMap(({ stage, backup }) =>
      backup === undefined ? [stage] : [stage, backup]
    ),
    operations,
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "inventory outputs were replaced but temporary cleanup was incomplete",
    );
  }
}

function runGenerate(): void {
  const inventory = buildInventory();
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeInventoryOutputs(inventory, {
    jsonPath: OUT_JSON,
    markdownPath: OUT_MD,
  });
  console.log(
    `Tool inventory generated: ${inventory.counts.allFlatAndCodeModeActions} public actions, ${inventory.counts.outputProfiles} output profiles`,
  );
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined
  && resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes("--check")) {
    runCheck();
  } else {
    runGenerate();
  }
}
