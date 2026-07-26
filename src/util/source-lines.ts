export const VARIABLE_DECLARATION_SCAN_LINE_LIMIT = 200;

export function findVariableDeclarationEndLine(
  lines: readonly string[],
  startLine: number,
): number {
  let depth = 0;
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(
    lines.length,
    startIdx + VARIABLE_DECLARATION_SCAN_LINE_LIMIT,
  );
  for (let i = startIdx; i < endIdx; i++) {
    for (const char of lines[i]) {
      if (char === "{" || char === "(" || char === "[") depth++;
      if (char === "}" || char === ")" || char === "]") {
        depth = Math.max(0, depth - 1);
      }
    }
    // ponytail: bounded scan; parser-backed ranges can replace this if needed.
    if (depth === 0 && lines[i].trimEnd().endsWith(";")) return i + 1;
  }
  return startLine;
}
