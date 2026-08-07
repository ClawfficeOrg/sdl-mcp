import { ParserAdapterContractError } from "../domain/errors.js";
import type { NativeContentParserCapability } from "./rustIndexer.js";

export type ParserEngine = "native" | "typescript";

export interface ParserContract {
  readonly engine: ParserEngine;
  readonly engineContract: string;
  readonly adapterKey: string;
  readonly language: string;
}

export const BUILTIN_TYPESCRIPT_PARSER_CONTRACT: ParserContract = {
  engine: "typescript",
  engineContract: "typescript:1",
  adapterKey: "builtin:typescript:typescript:1",
  language: "typescript",
};

const NATIVE_PARSER_CONTRACT: ParserContract = {
  engine: "native",
  engineContract: "native:1",
  adapterKey: "native:native:1",
  language: "typescript",
};

export function selectParserContract(input: {
  repoRelativePath: string;
  language: string;
  nativeCapability: NativeContentParserCapability;
  adapterContract?: ParserContract;
}): ParserContract {
  if (
    input.language === "typescript" &&
    input.repoRelativePath.toLowerCase().endsWith(".mjs") &&
    input.nativeCapability.available &&
    input.nativeCapability.contract === "native:1"
  ) {
    return NATIVE_PARSER_CONTRACT;
  }
  if (input.adapterContract) return input.adapterContract;
  throw new ParserAdapterContractError(
    input.repoRelativePath,
    "declared parser adapter contract",
  );
}

export function createPluginParserContract(input: {
  pluginIdentity: string;
  pluginPackageVersion: string;
  adapterIdentity?: string;
  adapterContractVersion?: string;
  language: string;
}): ParserContract | undefined {
  if (!input.adapterIdentity || !input.adapterContractVersion) return undefined;
  return {
    engine: "typescript",
    engineContract: input.adapterContractVersion,
    adapterKey: JSON.stringify([
      "plugin",
      input.pluginIdentity,
      input.pluginPackageVersion,
      input.adapterIdentity,
      input.adapterContractVersion,
    ]),
    language: input.language,
  };
}

export function assertParserContractCompatible(
  recorded: ParserContract,
  current: ParserContract,
  repoRelativePath: string,
): void {
  if (
    recorded.engine !== current.engine ||
    recorded.engineContract !== current.engineContract ||
    recorded.adapterKey !== current.adapterKey ||
    recorded.language !== current.language
  ) {
    throw new ParserAdapterContractError(repoRelativePath, recorded.adapterKey);
  }
}
