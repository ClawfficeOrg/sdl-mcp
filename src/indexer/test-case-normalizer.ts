import { Buffer } from "node:buffer";

import type { TestCaseCandidate } from "./adapter/LanguageAdapter.js";
import type {
  ExtractedCall,
  ExtractedSymbol,
} from "./treesitter/extractCalls.js";
import type { SymbolWithNodeId } from "./worker.js";
import { hashContent } from "../util/hashing.js";
import {
  normalizeTestCaseFacet,
  serializeTestCaseFacet,
} from "../util/test-case.js";

type Range = ExtractedSymbol["range"];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRanges(left: Range, right: Range): number {
  return (
    left.startLine - right.startLine ||
    left.startCol - right.startCol ||
    left.endLine - right.endLine ||
    left.endCol - right.endCol
  );
}

function compareCandidates(left: TestCaseCandidate, right: TestCaseCandidate): number {
  const leftKey =
    left.mode === "attach"
      ? `${[...left.targetKinds].sort(compareText).join(",")}\0${left.targetName}`
      : `${left.kind}\0${left.name}`;
  const rightKey =
    right.mode === "attach"
      ? `${[...right.targetKinds].sort(compareText).join(",")}\0${right.targetName}`
      : `${right.kind}\0${right.name}`;
  return (
    compareRanges(left.constructRange, right.constructRange) ||
    compareText(left.mode, right.mode) ||
    compareText(leftKey, rightKey) ||
    compareText(
      left.mode === "synthetic" ? left.sourceFingerprint : "",
      right.mode === "synthetic" ? right.sourceFingerprint : "",
    ) ||
    compareText(
      serializeTestCaseFacet(left.testCase) ?? "",
      serializeTestCaseFacet(right.testCase) ?? "",
    )
  );
}

function comparePositions(
  left: Pick<Range, "startLine" | "startCol">,
  right: Pick<Range, "startLine" | "startCol">,
): number {
  return left.startLine - right.startLine || left.startCol - right.startCol;
}

function rangesOverlap(left: Range, right: Range): boolean {
  const leftStart = { startLine: left.startLine, startCol: left.startCol };
  const leftEnd = { startLine: left.endLine, startCol: left.endCol };
  const rightStart = { startLine: right.startLine, startCol: right.startCol };
  const rightEnd = { startLine: right.endLine, startCol: right.endCol };
  const leftZeroWidth = comparePositions(leftStart, leftEnd) === 0;
  const rightZeroWidth = comparePositions(rightStart, rightEnd) === 0;
  if (leftZeroWidth && rightZeroWidth) {
    return comparePositions(leftStart, rightStart) === 0;
  }
  if (leftZeroWidth) {
    return (
      comparePositions(leftStart, rightStart) >= 0 &&
      comparePositions(leftStart, rightEnd) < 0
    );
  }
  if (rightZeroWidth) {
    return (
      comparePositions(rightStart, leftStart) >= 0 &&
      comparePositions(rightStart, leftEnd) < 0
    );
  }
  return (
    comparePositions(leftStart, rightEnd) < 0 &&
    comparePositions(rightStart, leftEnd) < 0
  );
}

function rangeContains(outer: Range, inner: Range): boolean {
  return (
    comparePositions(
      { startLine: outer.startLine, startCol: outer.startCol },
      { startLine: inner.startLine, startCol: inner.startCol },
    ) <= 0 &&
    comparePositions(
      { startLine: inner.endLine, startCol: inner.endCol },
      { startLine: outer.endLine, startCol: outer.endCol },
    ) <= 0
  );
}

function rangeSize(symbolRange: Range): number {
  return (
    (symbolRange.endLine - symbolRange.startLine) * 1000 +
    symbolRange.endCol -
    symbolRange.startCol
  );
}

function compareOwners(
  left: SymbolWithNodeId,
  right: SymbolWithNodeId,
  syntheticNodeIds: ReadonlySet<string>,
): number {
  const leftContainsRight = rangeContains(left.range, right.range);
  const rightContainsLeft = rangeContains(right.range, left.range);
  if (leftContainsRight !== rightContainsLeft) {
    return leftContainsRight ? 1 : -1;
  }
  return (
    rangeSize(left.range) - rangeSize(right.range) ||
    Number(syntheticNodeIds.has(left.nodeId)) -
      Number(syntheticNodeIds.has(right.nodeId)) ||
    compareText(left.nodeId, right.nodeId)
  );
}

function utf16IndexForByteColumn(line: string, byteColumn: number): number {
  let byteIndex = 0;
  let utf16Index = 0;
  for (const codePoint of line) {
    if (byteIndex >= byteColumn) break;
    byteIndex += Buffer.byteLength(codePoint, "utf8");
    utf16Index += codePoint.length;
  }
  return utf16Index;
}

function sourceSlice(content: string, range: Range): string {
  const lines = content.split("\n");
  let startOffset = 0;
  for (let index = 0; index < range.startLine - 1; index++) {
    startOffset += (lines[index]?.length ?? 0) + 1;
  }
  let endOffset = 0;
  for (let index = 0; index < range.endLine - 1; index++) {
    endOffset += (lines[index]?.length ?? 0) + 1;
  }
  return content.slice(
    startOffset + utf16IndexForByteColumn(lines[range.startLine - 1] ?? "", range.startCol),
    endOffset + utf16IndexForByteColumn(lines[range.endLine - 1] ?? "", range.endCol),
  );
}

export function sourceFingerprintForTestCase(
  content: string,
  range: ExtractedSymbol["range"],
  occurrenceOrdinal: number,
): string {
  return hashContent(
    `sdl-test-case-v1\0${sourceSlice(content, range)}\0${occurrenceOrdinal}`,
  );
}

export function applyTestCaseCandidates(params: {
  relPath: string;
  symbols: readonly SymbolWithNodeId[];
  calls: readonly ExtractedCall[];
  candidates: readonly TestCaseCandidate[];
}): {
  symbols: SymbolWithNodeId[];
  calls: ExtractedCall[];
  diagnostics: string[];
} {
  if (params.candidates.length === 0) {
    return {
      symbols: [...params.symbols],
      calls: [...params.calls],
      diagnostics: [],
    };
  }

  const symbols = params.symbols.map((symbol) => ({ ...symbol }));
  const ordinaryCount = symbols.length;
  const syntheticNodeIds = new Set<string>();
  const syntheticSymbols: SymbolWithNodeId[] = [];
  const diagnostics: string[] = [];

  // Normalize in source order so adapter traversal order cannot affect rows or IDs.
  for (const candidate of [...params.candidates].sort(compareCandidates)) {
    const testCase = normalizeTestCaseFacet(candidate.testCase);
    if (!testCase) {
      diagnostics.push(`${params.relPath}: invalid test-case facet`);
      continue;
    }

    if (candidate.mode === "attach") {
      const matches: number[] = [];
      for (let index = 0; index < ordinaryCount; index++) {
        const symbol = symbols[index];
        if (
          symbol.name === candidate.targetName &&
          (symbol.kind === "function" || symbol.kind === "method") &&
          candidate.targetKinds.includes(symbol.kind) &&
          rangesOverlap(symbol.range, candidate.constructRange)
        ) {
          matches.push(index);
        }
      }
      if (matches.length !== 1) {
        diagnostics.push(
          `${params.relPath}: test-case attach "${candidate.targetName}" matched ${matches.length} symbols`,
        );
        continue;
      }
      const matchIndex = matches[0];
      symbols[matchIndex] = { ...symbols[matchIndex], testCase };
      continue;
    }

    const syntheticSymbol: SymbolWithNodeId = {
      nodeId: candidate.nodeId,
      kind: candidate.kind,
      name: candidate.name,
      exported: false,
      range: candidate.constructRange,
      astFingerprint: candidate.sourceFingerprint,
      testCase,
    };
    syntheticNodeIds.add(candidate.nodeId);
    syntheticSymbols.push(syntheticSymbol);
    symbols.push(syntheticSymbol);
  }

  if (syntheticSymbols.length === 0) {
    return {
      symbols,
      calls: [...params.calls],
      diagnostics: diagnostics.sort(compareText),
    };
  }

  const ordinarySymbolsByNodeId = new Map(
    params.symbols.map((symbol) => [symbol.nodeId, symbol] as const),
  );
  const preferredOrdinaryByRange = new Map<string, SymbolWithNodeId>();
  for (const symbol of params.symbols) {
    const key = JSON.stringify(symbol.range);
    const current = preferredOrdinaryByRange.get(key);
    if (!current || compareText(symbol.nodeId, current.nodeId) < 0) {
      preferredOrdinaryByRange.set(key, symbol);
    }
  }
  // Existing ownership supplies the smallest ordinary range; normalize its tie before synthesis.
  const calls = params.calls.map((call) => {
    let owner = ordinarySymbolsByNodeId.get(call.callerNodeId);
    if (owner) {
      owner = preferredOrdinaryByRange.get(JSON.stringify(owner.range)) ?? owner;
    }
    let affected = false;
    for (const syntheticSymbol of syntheticSymbols) {
      if (!rangeContains(syntheticSymbol.range, call.range)) continue;
      affected = true;
      if (!owner || compareOwners(syntheticSymbol, owner, syntheticNodeIds) < 0) {
        owner = syntheticSymbol;
      }
    }
    if (!affected) return call;
    return owner ? { ...call, callerNodeId: owner.nodeId } : { ...call };
  });

  return { symbols, calls, diagnostics: diagnostics.sort(compareText) };
}
