import Parser, { Tree } from "tree-sitter";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import type { EdgeResolutionStrategy, TestCaseFacet } from "../../domain/types.js";

export interface StructuralMatcherDescriptor {
  /**
   * Conservative tree-sitter node types that can be treated as identifiers for
   * AST-aware search.edit replacement. Keep this narrow to avoid touching
   * comments, strings, or grammar-specific generic tokens.
   */
  identifierNodeTypes: readonly string[];

  /**
   * Compile a grammar-native tree-sitter query. Implementations must throw for
   * invalid query syntax so callers can distinguish "no matches" from
   * "malformed query".
   */
  createQuery(queryString: string): Parser.Query;
}

export interface CallResolutionContext {
  call: ExtractedCall;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  nameToSymbolIds: Map<string, string[]>;
}

export interface AdapterResolvedCall {
  symbolId: string | null;
  isResolved: boolean;
  confidence?: number;
  strategy?: EdgeResolutionStrategy;
  candidateCount?: number;
  targetName?: string;
}

export type TestCaseCandidate =
  | {
      mode: "attach";
      targetName: string;
      targetKinds: Array<"function" | "method">;
      constructRange: ExtractedSymbol["range"];
      testCase: TestCaseFacet;
    }
  | {
      mode: "synthetic";
      kind: "function";
      name: string;
      nodeId: string;
      constructRange: ExtractedSymbol["range"];
      sourceFingerprint: string;
      testCase: TestCaseFacet;
    };

export interface LanguageAdapter {
  languageId: string;

  fileExtensions: readonly string[];

  getParser(): Parser | null;

  parse(content: string, filePath: string): Tree | null;

  parseAsync?(content: string, filePath: string): Promise<Tree | null>;

  extractAll?(
    content: string,
    filePath: string,
  ): Promise<{
    tree: Tree | null;
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
  }>;

  detectTestCases?(params: {
    tree: Tree | null;
    content: string;
    filePath: string;
    symbols: readonly ExtractedSymbol[];
  }): TestCaseCandidate[];

  extractSymbols(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedSymbol[];

  extractImports(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedImport[];

  extractCalls(
    tree: Tree,
    content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[];

  /**
   * Optional language-specific call target resolver.
   * Can improve precision beyond generic fallback heuristics.
   */
  resolveCall?(context: CallResolutionContext): AdapterResolvedCall | null;
}
