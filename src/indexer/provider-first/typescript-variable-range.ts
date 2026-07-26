import ts from "typescript";

import type { Range } from "../../domain/types.js";
import { VARIABLE_DECLARATION_SCAN_LINE_LIMIT } from "../../util/source-lines.js";

export function findTypeScriptVariableStatementRange(
  sourceLines: ReadonlyMap<number, string>,
  definitionRange: Range,
  relPath: string,
): Range | undefined {
  const sourceStartLine = definitionRange.startLine - 1;
  const lines: string[] = [];
  for (
    let offset = 0;
    offset < VARIABLE_DECLARATION_SCAN_LINE_LIMIT;
    offset++
  ) {
    const line = sourceLines.get(sourceStartLine + offset);
    if (line === undefined) break;
    lines.push(line);
  }
  if (lines.length === 0) return undefined;

  const sourceText = lines.join("\n");
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const definitionPosition = sourceFile.getPositionOfLineAndCharacter(
    0,
    Math.min(definitionRange.startCol, lines[0].length),
  );
  const statement = sourceFile.statements.find(
    (candidate): candidate is ts.VariableStatement =>
      ts.isVariableStatement(candidate) &&
      candidate.getStart(sourceFile) <= definitionPosition &&
      definitionPosition <= candidate.getEnd(),
  );
  if (!statement) return undefined;

  const syntaxDiagnostics = ts.transpileModule(sourceText, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
    },
    fileName: relPath,
    reportDiagnostics: true,
  }).diagnostics;
  const statementEnd = statement.getEnd();
  const hasRelevantSyntaxDiagnostic = syntaxDiagnostics?.some(
    (diagnostic) =>
      diagnostic.start === undefined || diagnostic.start <= statementEnd,
  );
  // Parser recovery can fabricate a statement ending at the bounded fragment EOF.
  if (hasRelevantSyntaxDiagnostic) return undefined;

  const start = sourceFile.getLineAndCharacterOfPosition(
    statement.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd());
  return {
    startLine: definitionRange.startLine + start.line,
    startCol: start.character,
    endLine: definitionRange.startLine + end.line,
    endCol: end.character,
  };
}
