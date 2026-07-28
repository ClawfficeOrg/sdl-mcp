import ts from "typescript";

const TEST_IDENTIFIERS = new Set(["describe", "it", "test"]);
const TEST_MODIFIERS = new Set(["only", "skip", "todo"]);
const MAX_TITLE_CODE_POINTS = 256;
const MAX_TITLES = 64;
const MAX_TOTAL_TITLE_CODE_POINTS = 2_048;

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

function isSupportedTestCallee(expression: ts.LeftHandSideExpression): boolean {
  if (ts.isIdentifier(expression)) {
    return TEST_IDENTIFIERS.has(expression.text);
  }

  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.questionDotToken === undefined &&
    ts.isIdentifier(expression.expression) &&
    TEST_IDENTIFIERS.has(expression.expression.text) &&
    TEST_MODIFIERS.has(expression.name.text)
  );
}

/** Extract bounded, static test contract text for module-level lexical search. */
export function extractStaticTestTitleSearchText(
  sourceText: string,
  filePath: string,
): string {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const titles: string[] = [];
  const seen = new Set<string>();
  let totalCodePoints = 0;
  let stopped = false;

  const visit = (node: ts.Node): void => {
    if (stopped) return;

    if (ts.isCallExpression(node) && isSupportedTestCallee(node.expression)) {
      const titleNode = node.arguments[0];
      if (
        titleNode &&
        (ts.isStringLiteral(titleNode) ||
          ts.isNoSubstitutionTemplateLiteral(titleNode))
      ) {
        const normalized = titleNode.text.replace(/\s+/gu, " ").trim();
        const title = Array.from(normalized)
          .slice(0, MAX_TITLE_CODE_POINTS)
          .join("");

        if (title && !seen.has(title)) {
          const remaining = MAX_TOTAL_TITLE_CODE_POINTS - totalCodePoints;
          const boundedTitle = Array.from(title).slice(0, remaining).join("");

          if (boundedTitle) {
            seen.add(title);
            titles.push(boundedTitle);
            totalCodePoints += Array.from(boundedTitle).length;
          }

          if (
            boundedTitle !== title ||
            titles.length >= MAX_TITLES ||
            totalCodePoints >= MAX_TOTAL_TITLE_CODE_POINTS
          ) {
            stopped = true;
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return titles.join("\n");
}
