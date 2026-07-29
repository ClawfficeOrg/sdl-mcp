import ts from "typescript";

import type { TestCaseCandidate } from "./adapter/LanguageAdapter.js";
import { sourceFingerprintForTestCase } from "./test-case-normalizer.js";
import { normalizeTestCaseFacet } from "../util/test-case.js";

const TEST_NAMES = new Set(["describe", "it", "test"]);
const MODIFIERS = new Set(["only", "skip", "todo", "each"]);
const FRAMEWORK_PRIORITY = ["node:test", "vitest", "jest"] as const;
const MAX_TITLE_CODE_POINTS = 256;
const MAX_TITLES = 64;
const MAX_TOTAL_TITLE_CODE_POINTS = 2_048;

type Framework = (typeof FRAMEWORK_PRIORITY)[number];
type TestName = "describe" | "it" | "test";
type Modifier = "skip" | "todo" | "only" | "parameterized";
type CalleeInfo = {
  testName: TestName;
  modifiers: Modifier[];
  eachFactory: boolean;
};

type PendingCase = {
  range: TestCaseCandidate["constructRange"];
  sourceSlice: string;
  title: string;
  suitePath: string[];
  modifiers: Modifier[];
};

function scriptKindFor(filePath: string): ts.ScriptKind {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lowerPath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    lowerPath.endsWith(".js") ||
    lowerPath.endsWith(".mjs") ||
    lowerPath.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function frameworkForModule(moduleName: string): Framework | undefined {
  if (moduleName === "node:test") return "node:test";
  if (moduleName === "vitest") return "vitest";
  if (moduleName === "jest" || moduleName === "@jest/globals") return "jest";
  return undefined;
}

function staticString(node: ts.Expression | undefined): string | undefined {
  if (
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

function normalizeText(value: string): string {
  return Array.from(value.replace(/\s+/gu, " ").trim())
    .slice(0, MAX_TITLE_CODE_POINTS)
    .join("");
}

function requireModuleName(node: ts.Expression | undefined): string | undefined {
  if (
    !node ||
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "require"
  ) {
    return undefined;
  }
  return staticString(node.arguments[0]);
}

function collectBindings(sourceFile: ts.SourceFile): {
  bindings: Map<string, TestName>;
  namespaces: Set<string>;
  framework: Framework;
} {
  const bindings = new Map<string, TestName>([
    ["describe", "describe"],
    ["it", "it"],
    ["test", "test"],
  ]);
  const namespaces = new Set<string>();
  const frameworks = new Set<Framework>();

  const bindNamed = (name: ts.ObjectBindingPattern): void => {
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const importedName = element.propertyName?.getText(sourceFile) ?? element.name.text;
      if (TEST_NAMES.has(importedName)) {
        bindings.set(element.name.text, importedName as TestName);
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const framework = frameworkForModule(statement.moduleSpecifier.text);
      if (!framework) continue;
      frameworks.add(framework);
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) bindings.set(clause.name.text, "test");
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        namespaces.add(named.name.text);
      } else if (named) {
        for (const element of named.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (TEST_NAMES.has(importedName)) {
            bindings.set(element.name.text, importedName as TestName);
          }
        }
      }
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const moduleName = requireModuleName(declaration.initializer);
      const framework = moduleName ? frameworkForModule(moduleName) : undefined;
      if (!framework) continue;
      frameworks.add(framework);
      if (ts.isIdentifier(declaration.name)) {
        bindings.set(declaration.name.text, "test");
        namespaces.add(declaration.name.text);
      } else if (ts.isObjectBindingPattern(declaration.name)) {
        bindNamed(declaration.name);
      }
    }
  }

  const framework =
    FRAMEWORK_PRIORITY.find((candidate) => frameworks.has(candidate)) ?? "jest";
  return { bindings, namespaces, framework };
}

function calleeInfo(
  expression: ts.LeftHandSideExpression,
  bindings: ReadonlyMap<string, TestName>,
  namespaces: ReadonlySet<string>,
): CalleeInfo | undefined {
  if (ts.isIdentifier(expression)) {
    const testName = bindings.get(expression.text);
    return testName ? { testName, modifiers: [], eachFactory: false } : undefined;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text) &&
      TEST_NAMES.has(expression.name.text)
    ) {
      return {
        testName: expression.name.text as TestName,
        modifiers: [],
        eachFactory: false,
      };
    }
    if (!MODIFIERS.has(expression.name.text)) return undefined;
    const base = calleeInfo(expression.expression, bindings, namespaces);
    if (!base) return undefined;
    const modifier: Modifier =
      expression.name.text === "each"
        ? "parameterized"
        : (expression.name.text as Exclude<Modifier, "parameterized">);
    return {
      ...base,
      modifiers: [...base.modifiers, modifier],
    };
  }

  if (ts.isCallExpression(expression)) {
    const base = calleeInfo(expression.expression, bindings, namespaces);
    return base?.modifiers.includes("parameterized")
      ? { ...base, eachFactory: true }
      : undefined;
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    const base = calleeInfo(expression.tag, bindings, namespaces);
    return base?.modifiers.includes("parameterized")
      ? { ...base, eachFactory: true }
      : undefined;
  }

  return undefined;
}

function byteColumn(sourceFile: ts.SourceFile, position: number): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(position);
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
  return Buffer.byteLength(sourceFile.text.slice(lineStart, position), "utf8");
}

function constructRange(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
): TestCaseCandidate["constructRange"] {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    startLine: startPosition.line + 1,
    startCol: byteColumn(sourceFile, start),
    endLine: endPosition.line + 1,
    endCol: byteColumn(sourceFile, end),
  };
}

function compareRange(
  left: TestCaseCandidate["constructRange"],
  right: TestCaseCandidate["constructRange"],
): number {
  return (
    left.startLine - right.startLine ||
    left.startCol - right.startCol ||
    left.endLine - right.endLine ||
    left.endCol - right.endCol
  );
}

export function detectTypeScriptTestCases(params: {
  content: string;
  filePath: string;
}): TestCaseCandidate[] {
  if (
    !/\b(?:describe|it|test)\s*(?:\.|\()/u.test(params.content) &&
    !/["'](?:node:test|vitest|@jest\/globals|jest)["'][\s\S]*\(/u.test(
      params.content,
    )
  ) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    params.filePath,
    params.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(params.filePath),
  );
  const { bindings, namespaces, framework } = collectBindings(sourceFile);
  const pending: PendingCase[] = [];
  let totalCodePoints = 0;

  const visit = (node: ts.Node, suitePath: string[]): void => {
    if (pending.length >= MAX_TITLES || totalCodePoints >= MAX_TOTAL_TITLE_CODE_POINTS) {
      return;
    }

    if (ts.isCallExpression(node)) {
      const info = calleeInfo(node.expression, bindings, namespaces);
      if (info) {
        const title = normalizeText(staticString(node.arguments[0]) ?? "");
        const callback = node.arguments.find(
          (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
            ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
        );

        if (info.testName === "describe") {
          if (callback) {
            visit(callback.body, title ? [...suitePath, title] : suitePath);
          }
          return;
        }

        if (
          info.modifiers.includes("parameterized") &&
          !info.eachFactory
        ) {
          ts.forEachChild(node, (child) => visit(child, suitePath));
          return;
        }

        if (title) {
          const remaining = MAX_TOTAL_TITLE_CODE_POINTS - totalCodePoints;
          const boundedTitle = Array.from(title).slice(0, remaining).join("");
          if (boundedTitle) {
            const range = constructRange(sourceFile, node);
            pending.push({
              range,
              sourceSlice: params.content.slice(
                node.getStart(sourceFile),
                node.getEnd(),
              ),
              title: boundedTitle,
              suitePath,
              modifiers: info.modifiers,
            });
            totalCodePoints += Array.from(boundedTitle).length;
          }
          return;
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, suitePath));
  };

  visit(sourceFile, []);
  pending.sort((left, right) => compareRange(left.range, right.range));
  const occurrences = new Map<string, number>();

  return pending.flatMap((candidate) => {
    const occurrenceOrdinal = (occurrences.get(candidate.sourceSlice) ?? 0) + 1;
    occurrences.set(candidate.sourceSlice, occurrenceOrdinal);
    const fingerprint = sourceFingerprintForTestCase(
      params.content,
      candidate.range,
      occurrenceOrdinal,
    );
    const testCase = normalizeTestCaseFacet({
      framework,
      title: candidate.title,
      suitePath: candidate.suitePath,
      modifiers: candidate.modifiers,
    });
    return testCase
      ? [
          {
            mode: "synthetic" as const,
            kind: "function" as const,
            name: testCase.title,
            nodeId: `sdl:test-case:${fingerprint}`,
            constructRange: candidate.range,
            sourceFingerprint: fingerprint,
            testCase,
          },
        ]
      : [];
  });
}
