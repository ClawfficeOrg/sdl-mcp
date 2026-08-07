import { extname } from "node:path";

import {
  ParserContractMismatchError,
  ParserEngineUnavailableError,
} from "../domain/errors.js";
import {
  getAdapterForExtension,
  getAdapterParserContract,
} from "../indexer/adapter/registry.js";
import type { LanguageAdapter } from "../indexer/adapter/LanguageAdapter.js";
import {
  NATIVE_PARSER_CONTRACT,
  type ParserContract,
} from "../indexer/parser-provenance.js";
import {
  extensionToLanguage,
  getNativeContentParserCapability,
  parseContentRust,
  type RustExtractedSymbol,
} from "../indexer/rustIndexer.js";
import type {
  ExtractedCall,
  ExtractedSymbol,
} from "../indexer/treesitter/extractCalls.js";
import type { ExtractedImport } from "../indexer/treesitter/extractImports.js";
import { normalizePath } from "../util/paths.js";

export interface DraftSourceParseInput {
  repoId: string;
  repoRelativePath: string;
  content: string;
  contract: ParserContract;
}

export interface DraftSourceExtraction {
  contract: ParserContract;
  symbols: Array<ExtractedSymbol | RustExtractedSymbol>;
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  tree?: ReturnType<LanguageAdapter["parse"]>;
}

export interface DraftSourceParserDeps {
  getNativeContentParserCapability: typeof getNativeContentParserCapability;
  parseContentRust: typeof parseContentRust;
  getAdapterForExtension: typeof getAdapterForExtension;
  getAdapterParserContract: typeof getAdapterParserContract;
}

const DEFAULT_DEPS: DraftSourceParserDeps = {
  getNativeContentParserCapability,
  parseContentRust,
  getAdapterForExtension,
  getAdapterParserContract,
};

function engineUnavailable(
  input: DraftSourceParseInput,
): ParserEngineUnavailableError {
  return new ParserEngineUnavailableError(
    input.repoRelativePath,
    input.contract.engineContract,
  );
}

function contractsMatch(
  recorded: ParserContract,
  available: ParserContract | undefined,
): boolean {
  return (
    available?.engine === recorded.engine &&
    available.engineContract === recorded.engineContract &&
    available.adapterKey === recorded.adapterKey &&
    available.language === recorded.language
  );
}

/** Parses drafts with their recorded engine; no cross-engine fallback is valid. */
export async function parseDraftSource(
  input: DraftSourceParseInput,
  deps: DraftSourceParserDeps = DEFAULT_DEPS,
): Promise<DraftSourceExtraction> {
  const repoRelativePath = normalizePath(input.repoRelativePath);
  const normalizedInput = { ...input, repoRelativePath };

  if (input.contract.engine === "native") {
    if (!contractsMatch(input.contract, NATIVE_PARSER_CONTRACT)) {
      throw new ParserContractMismatchError(
        repoRelativePath,
        input.contract.engineContract,
      );
    }
    const capability = deps.getNativeContentParserCapability();
    if (!capability.available) {
      if (capability.reason === "contract-version-mismatch") {
        throw new ParserContractMismatchError(
          repoRelativePath,
          input.contract.engineContract,
        );
      }
      throw engineUnavailable(normalizedInput);
    }
    if (capability.contract !== input.contract.engineContract) {
      throw new ParserContractMismatchError(
        repoRelativePath,
        input.contract.engineContract,
      );
    }

    let parsed: Awaited<ReturnType<typeof parseContentRust>>;
    try {
      parsed = await deps.parseContentRust({
        repoId: input.repoId,
        relPath: repoRelativePath,
        language: extensionToLanguage(
          extname(repoRelativePath).slice(1).toLowerCase(),
        ),
        content: input.content,
      });
    } catch {
      throw engineUnavailable(normalizedInput);
    }
    if (!parsed.available) {
      if (parsed.reason === "contract-version-mismatch") {
        throw new ParserContractMismatchError(
          repoRelativePath,
          input.contract.engineContract,
        );
      }
      throw engineUnavailable(normalizedInput);
    }
    if (parsed.contract !== input.contract.engineContract) {
      throw new ParserContractMismatchError(
        repoRelativePath,
        input.contract.engineContract,
      );
    }
    if (parsed.result.parseError) {
      throw engineUnavailable(normalizedInput);
    }
    return {
      contract: input.contract,
      symbols: parsed.result.symbols,
      imports: parsed.result.imports,
      calls: parsed.result.calls,
    };
  }

  const extension = extname(repoRelativePath);
  const adapter = deps.getAdapterForExtension(extension);
  const adapterContract = deps.getAdapterParserContract(extension);
  if (!adapter || !contractsMatch(input.contract, adapterContract)) {
    throw new ParserContractMismatchError(
      repoRelativePath,
      input.contract.engineContract,
    );
  }

  try {
    const tree = adapter.parse(input.content, repoRelativePath);
    if (!tree) {
      throw engineUnavailable(normalizedInput);
    }
    const symbols = adapter.extractSymbols(
      tree,
      input.content,
      repoRelativePath,
    );
    return {
      contract: input.contract,
      tree,
      symbols,
      imports: adapter.extractImports(tree, input.content, repoRelativePath),
      calls: adapter.extractCalls(
        tree,
        input.content,
        repoRelativePath,
        symbols,
      ),
    };
  } catch {
    throw engineUnavailable(normalizedInput);
  }
}
