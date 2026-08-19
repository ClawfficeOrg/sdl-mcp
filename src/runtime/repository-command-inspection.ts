export type CommandDialect = "posix" | "cmd" | "powershell";

export interface CommandTarget {
  kind: "path" | "stdin" | "cwd";
  value: string;
}

export interface InspectedRepositoryCommand {
  command: string;
  targets: CommandTarget[];
  inputRedirections: CommandTarget[];
}

export type CommandInspection =
  | { kind: "parsed"; commands: InspectedRepositoryCommand[] }
  | { kind: "ambiguous"; commands: InspectedRepositoryCommand[] }
  | { kind: "notRecognized"; commands: [] };

const MAX_COMMAND_TEXT_LENGTH = 32_768;
const MAX_SEGMENTS = 64;
const MAX_TOKENS = 256;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_WRAPPER_DEPTH = 2;
const CMD_WRAPPER_SWITCHES = new Set(["/d", "/s"]);
const POWERSHELL_WRAPPER_SWITCHES = new Set(["-noprofile"]);

const AMBIGUOUS = Symbol("ambiguous");
type ParserResult = InspectedRepositoryCommand | null | typeof AMBIGUOUS;

interface Tokenization {
  tokens: string[];
  inputRedirections: string[];
  ambiguous: boolean;
}

interface SplitResult {
  segments: string[];
  ambiguous: boolean;
  incompleteCompound: boolean;
}

/** Inspect command text that may contain multiple shell-separated commands. */
export function inspectCommandText(
  text: string,
  dialect: CommandDialect,
): CommandInspection {
  return inspectCommandTextAtDepth(text, dialect, 0);
}

/** Inspect exactly one simple command; unquoted compound separators are ambiguous. */
export function inspectSimpleCommand(
  text: string,
  dialect: CommandDialect,
): CommandInspection {
  if (text.length > MAX_COMMAND_TEXT_LENGTH) return ambiguousInspection();
  const split = splitCommandSegments(text, dialect);
  if (split.ambiguous || split.incompleteCompound || split.segments.length > 1) {
    return ambiguousInspection();
  }
  if (split.segments.length === 0) return notRecognizedInspection();
  return inspectSegment(split.segments[0] ?? "", dialect, 0);
}

/** Inspect a process argv as literal tokens without applying shell syntax. */
export function inspectSimpleArgv(
  argv: readonly string[],
  dialect: CommandDialect,
): CommandInspection {
  if (
    argv.length > MAX_TOKENS ||
    argv.some((token) => token.length > MAX_TOKEN_LENGTH)
  ) {
    return ambiguousInspection();
  }

  const tokens = [...argv];
  if (isOpaquePackageScript(tokens, dialect)) return notRecognizedInspection();
  if (tokens.length === 0) return notRecognizedInspection();

  // Direct process argv already preserves the wrapper payload as one token.
  const wrapped = inspectWrapper(tokens, dialect, 0);
  if (wrapped !== null) return wrapped;

  const parsed = parseClosedCommand(tokens, [], dialect, false);
  if (parsed === AMBIGUOUS) return ambiguousInspection();
  if (parsed === null) return notRecognizedInspection();
  return { kind: "parsed", commands: [parsed] };
}

function inspectCommandTextAtDepth(
  text: string,
  dialect: CommandDialect,
  depth: number,
): CommandInspection {
  if (text.length > MAX_COMMAND_TEXT_LENGTH) return ambiguousInspection();
  const split = splitCommandSegments(text, dialect);
  if (split.ambiguous || split.incompleteCompound) return ambiguousInspection();

  const commands: InspectedRepositoryCommand[] = [];
  let sawAmbiguous = false;
  for (const segment of split.segments) {
    const result = inspectSegment(segment, dialect, depth);
    commands.push(...result.commands);
    sawAmbiguous ||= result.kind === "ambiguous";
  }
  if (sawAmbiguous) return ambiguousInspection(commands);
  if (commands.length > 0) return { kind: "parsed", commands };
  return notRecognizedInspection();
}

function inspectSegment(
  text: string,
  dialect: CommandDialect,
  depth: number,
): CommandInspection {
  const tokenization = tokenizeSegment(text, dialect);
  if (isOpaquePackageScript(tokenization.tokens, dialect)) {
    return notRecognizedInspection();
  }
  if (tokenization.ambiguous) return ambiguousInspection();
  if (tokenization.tokens.length === 0) return notRecognizedInspection();

  const wrapped = inspectWrapper(tokenization.tokens, dialect, depth);
  if (wrapped !== null) return wrapped;

  const parsed = parseClosedCommand(
    tokenization.tokens,
    tokenization.inputRedirections,
    dialect,
    true,
  );
  if (parsed === AMBIGUOUS) return ambiguousInspection();
  if (parsed === null) return notRecognizedInspection();
  return { kind: "parsed", commands: [parsed] };
}

function inspectWrapper(
  tokens: string[],
  dialect: CommandDialect,
  depth: number,
): CommandInspection | null {
  const name = comparableCommandName(tokens[0] ?? "", dialect);
  let innerDialect: CommandDialect | null = null;
  let expectedFlag = "";
  let allowedSwitches: ReadonlySet<string> | null = null;

  if (name === "sh" || name === "bash") {
    innerDialect = "posix";
    expectedFlag = "-c";
  } else if (name === "cmd" || name === "cmd.exe") {
    innerDialect = "cmd";
    expectedFlag = "/c";
    allowedSwitches = CMD_WRAPPER_SWITCHES;
  } else if (
    name === "powershell" ||
    name === "powershell.exe" ||
    name === "pwsh" ||
    name === "pwsh.exe"
  ) {
    innerDialect = "powershell";
    expectedFlag = "-command";
    allowedSwitches = POWERSHELL_WRAPPER_SWITCHES;
  } else {
    return null;
  }

  let flagIndex = 1;
  const seenSwitches = new Set<string>();
  while (allowedSwitches?.has(normalizeForDialect(tokens[flagIndex] ?? "", innerDialect))) {
    const wrapperSwitch = normalizeForDialect(tokens[flagIndex] ?? "", innerDialect);
    if (seenSwitches.has(wrapperSwitch)) return ambiguousInspection();
    seenSwitches.add(wrapperSwitch);
    flagIndex += 1;
  }
  if (
    tokens.length !== flagIndex + 2 ||
    !equalsForDialect(tokens[flagIndex] ?? "", expectedFlag, innerDialect)
  ) {
    return ambiguousInspection();
  }
  if (depth >= MAX_WRAPPER_DEPTH) return ambiguousInspection();
  const commandText =
    innerDialect === "cmd"
      ? unwrapCmdCommandString(tokens[flagIndex + 1] ?? "")
      : (tokens[flagIndex + 1] ?? "");
  return inspectCommandTextAtDepth(commandText, innerDialect, depth + 1);
}

function unwrapCmdCommandString(commandText: string): string {
  return commandText.length >= 2 && commandText.startsWith('"') && commandText.endsWith('"')
    ? commandText.slice(1, -1)
    : commandText;
}

function parseClosedCommand(
  tokens: string[],
  redirects: string[],
  dialect: CommandDialect,
  allowPowerShellCallOperator: boolean,
): ParserResult {
  let commandTokens = tokens;
  if (
    allowPowerShellCallOperator &&
    dialect === "powershell" &&
    commandTokens[0] === "&"
  ) {
    if (commandTokens.length < 2) return AMBIGUOUS;
    commandTokens = commandTokens.slice(1);
  }

  const name = comparableCommandName(commandTokens[0] ?? "", dialect);
  const args = commandTokens.slice(1);
  let parsed: ParserResult;

  if (dialect === "posix" && (name === "cat" || name === "more")) {
    parsed = parsePathOnly(name, args, true);
  } else if (dialect === "cmd" && (name === "type" || name === "more")) {
    parsed = parsePathOnly(name, args, false, true);
  } else if (dialect === "posix" && (name === "head" || name === "tail")) {
    parsed = parseHeadOrTail(name, args);
  } else if (name === "rg" || name === "ripgrep") {
    parsed = parseRg(args);
  } else if ((dialect === "posix" || dialect === "cmd") && name === "grep") {
    parsed = parseGrep(args);
  } else if (dialect === "cmd" && name === "findstr") {
    parsed = parseFindstr(args);
  } else if (
    dialect === "powershell" &&
    (name === "get-content" || name === "gc" || name === "cat" || name === "type")
  ) {
    parsed = parseGetContent(args);
  } else if (dialect === "powershell" && name === "select-string") {
    parsed = parseSelectString(args);
  } else if ((dialect === "posix" || dialect === "cmd") && name === "sed") {
    parsed = parseSed(args);
  } else if ((dialect === "posix" || dialect === "cmd") && name === "awk") {
    parsed = parseAwk(args);
  } else {
    return null;
  }

  if (parsed === null || parsed === AMBIGUOUS) return parsed;
  parsed.inputRedirections = redirects.map(pathTarget);
  return parsed;
}

function parsePathOnly(
  command: string,
  args: string[],
  supportsEndOfOptions: boolean,
  slashOptions = false,
): ParserResult {
  let paths = args;
  if (supportsEndOfOptions && paths[0] === "--") paths = paths.slice(1);
  if (paths.some((arg) => arg !== "-" && arg.startsWith("-"))) return AMBIGUOUS;
  if (slashOptions && paths.some((arg) => arg.startsWith("/"))) return AMBIGUOUS;
  return commandResult(command, targetsOrStdin(paths));
}

function parseHeadOrTail(command: string, args: string[]): ParserResult {
  const paths: string[] = [];
  let optionsEnded = false;
  let sawPath = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === "-q" || arg === "-v")) {
      if (sawPath) return AMBIGUOUS;
      continue;
    }
    if (
      !optionsEnded &&
      (arg === "-n" || arg === "--lines" || arg === "-c" || arg === "--bytes")
    ) {
      if (sawPath || !isCount(args[index + 1])) return AMBIGUOUS;
      index += 1;
      continue;
    }
    if (!optionsEnded && arg !== "-" && arg.startsWith("-")) return AMBIGUOUS;
    sawPath = true;
    paths.push(arg);
  }
  return commandResult(command, targetsOrStdin(paths));
}

const RG_SWITCH_FLAGS = new Set([
  "-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings",
  "-S", "--smart-case", "-w", "--word-regexp", "--hidden",
]);
const RG_STRING_VALUE_FLAGS = new Set([
  "-g", "--glob", "-t", "--type", "-T", "--type-not",
]);
const RG_COUNT_VALUE_FLAGS = new Set([
  "-m", "--max-count",
  "-A", "--after-context", "-B", "--before-context", "-C", "--context",
]);

function parseRg(args: string[]): ParserResult {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (RG_SWITCH_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (RG_STRING_VALUE_FLAGS.has(arg)) {
      if (!isNonOptionValue(args[index + 1])) return AMBIGUOUS;
      index += 2;
      continue;
    }
    if (RG_COUNT_VALUE_FLAGS.has(arg)) {
      if (!isCount(args[index + 1])) return AMBIGUOUS;
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) return AMBIGUOUS;
    break;
  }
  if (index >= args.length) return AMBIGUOUS;
  const paths = args.slice(index + 1);
  if (paths.some((path) => path !== "-" && path.startsWith("-"))) return AMBIGUOUS;
  return commandResult("rg", paths.length === 0 ? [cwdTarget()] : paths.map(pathTarget));
}

const GREP_FLAGS = new Set(["-n", "-i", "-F", "-E", "-w", "-l"]);

function parseGrep(args: string[]): ParserResult {
  let index = 0;
  while (index < args.length && GREP_FLAGS.has(args[index] ?? "")) index += 1;
  const optionsEnded = args[index] === "--";
  if (optionsEnded) index += 1;
  if (index >= args.length || (args[index] ?? "").startsWith("-")) return AMBIGUOUS;
  const paths = args.slice(index + 1);
  if (!optionsEnded && paths.some((path) => path !== "-" && path.startsWith("-"))) {
    return AMBIGUOUS;
  }
  return commandResult("grep", targetsOrStdin(paths));
}

function parseFindstr(args: string[]): ParserResult {
  let index = 0;
  let inlinePattern: string | null = null;
  const flags = new Set(["/i", "/n", "/s", "/l", "/r", "/x", "/v"]);
  while (index < args.length) {
    const arg = args[index] ?? "";
    const lower = arg.toLowerCase();
    if (flags.has(lower)) {
      index += 1;
      continue;
    }
    if (lower.startsWith("/c:")) {
      if (inlinePattern !== null || arg.slice(3).length === 0) return AMBIGUOUS;
      inlinePattern = arg.slice(3);
      index += 1;
      continue;
    }
    if (arg.startsWith("/")) return AMBIGUOUS;
    break;
  }
  if (inlinePattern === null) {
    if (index >= args.length) return AMBIGUOUS;
    index += 1;
  }
  const paths = args.slice(index);
  if (paths.some((path) => path.startsWith("/"))) return AMBIGUOUS;
  return commandResult("findstr", targetsOrStdin(paths));
}

const GET_CONTENT_SWITCHES = new Set(["-raw"]);
const GET_CONTENT_COUNT_VALUES = new Set([
  "-readcount", "-totalcount", "-tail",
]);

function parseGetContent(args: string[]): ParserResult {
  const paths: string[] = [];
  let pathMode: "positional" | "path" | "literal" | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const lower = arg.toLowerCase();
    if (GET_CONTENT_SWITCHES.has(lower)) continue;
    if (GET_CONTENT_COUNT_VALUES.has(lower)) {
      if (!isCount(args[index + 1])) return AMBIGUOUS;
      index += 1;
      continue;
    }
    if (lower === "-encoding") {
      if (!isNonOptionValue(args[index + 1])) return AMBIGUOUS;
      index += 1;
      continue;
    }
    if (lower === "-path" || lower === "-literalpath") {
      const nextMode = lower === "-path" ? "path" : "literal";
      if (pathMode !== null && pathMode !== nextMode) return AMBIGUOUS;
      pathMode = nextMode;
      const firstPathIndex = index + 1;
      while (
        args[index + 1] !== undefined &&
        ((args[index + 1] ?? "") === "-" || !(args[index + 1] ?? "").startsWith("-"))
      ) {
        paths.push(args[index + 1] ?? "");
        index += 1;
      }
      if (index === firstPathIndex - 1) return AMBIGUOUS;
      continue;
    }
    if (arg !== "-" && arg.startsWith("-")) return AMBIGUOUS;
    if (pathMode !== null && pathMode !== "positional") return AMBIGUOUS;
    pathMode = "positional";
    paths.push(arg);
  }
  return commandResult("get-content", targetsOrStdin(paths));
}

function parseSelectString(args: string[]): ParserResult {
  const paths: string[] = [];
  let sawPattern = false;
  let pathMode: "path" | "literal" | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const lower = (args[index] ?? "").toLowerCase();
    if (lower === "-pattern") {
      if (sawPattern || !isNonOptionValue(args[index + 1])) return AMBIGUOUS;
      sawPattern = true;
      index += 1;
      continue;
    }
    if (lower === "-path" || lower === "-literalpath") {
      const nextMode = lower === "-path" ? "path" : "literal";
      if (pathMode !== null && pathMode !== nextMode) return AMBIGUOUS;
      pathMode = nextMode;
      const start = index;
      while (
        args[index + 1] !== undefined &&
        ((args[index + 1] ?? "") === "-" || !(args[index + 1] ?? "").startsWith("-"))
      ) {
        paths.push(args[index + 1] ?? "");
        index += 1;
      }
      if (index === start) return AMBIGUOUS;
      continue;
    }
    return AMBIGUOUS;
  }
  if (!sawPattern) return AMBIGUOUS;
  return commandResult("select-string", targetsOrStdin(paths));
}

function parseSed(args: string[]): ParserResult {
  let index = 0;
  const flags = new Set(["-n", "-E", "-r"]);
  while (index < args.length && flags.has(args[index] ?? "")) index += 1;
  const optionsEnded = args[index] === "--";
  if (optionsEnded) index += 1;
  if (index >= args.length || (args[index] ?? "").startsWith("-")) return AMBIGUOUS;
  const paths = args.slice(index + 1);
  if (!optionsEnded && paths.some((path) => path !== "-" && path.startsWith("-"))) {
    return AMBIGUOUS;
  }
  return commandResult("sed", targetsOrStdin(paths));
}

function parseAwk(args: string[]): ParserResult {
  if (args.length === 0 || (args[0] ?? "").startsWith("-")) return AMBIGUOUS;
  const paths = args.slice(1);
  if (paths.some((path) => path !== "-" && path.startsWith("-"))) return AMBIGUOUS;
  return commandResult("awk", targetsOrStdin(paths));
}

function splitCommandSegments(text: string, dialect: CommandDialect): SplitResult {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let incompleteCompound = false;
  let awaitingSegment = false;

  const flush = (): boolean => {
    if (current.trim().length > 0) segments.push(current.trim());
    current = "";
    return segments.length <= MAX_SEGMENTS;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (isEscapeCharacter(char, dialect, quote)) {
      current += char;
      escaped = true;
      continue;
    }
    const nextQuote = quoteTransition(char, dialect, quote);
    if (nextQuote !== undefined) {
      quote = nextQuote;
      current += char;
      continue;
    }
    if (quote === null) {
      const width = separatorWidth(text, index, dialect);
      if (width > 0) {
        if (current.trim().length === 0) incompleteCompound = true;
        if (!flush()) {
          return { segments: [], ambiguous: true, incompleteCompound: true };
        }
        awaitingSegment = true;
        index += width - 1;
        continue;
      }
    }
    current += char;
    if (!/\s/u.test(char)) awaitingSegment = false;
  }
  incompleteCompound ||= awaitingSegment;
  if (quote !== null || escaped || !flush()) {
    return { segments: [], ambiguous: true, incompleteCompound: true };
  }
  return { segments, ambiguous: false, incompleteCompound };
}

function tokenizeSegment(text: string, dialect: CommandDialect): Tokenization {
  const tokens: string[] = [];
  const inputRedirections: string[] = [];
  let current = "";
  let active = false;
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let redirectPending = false;
  let ambiguous = false;

  const flush = (): void => {
    if (!active) return;
    if (current.length > MAX_TOKEN_LENGTH) ambiguous = true;
    if (redirectPending) {
      inputRedirections.push(current);
      redirectPending = false;
    } else {
      tokens.push(current);
    }
    current = "";
    active = false;
    if (tokens.length + inputRedirections.length > MAX_TOKENS) ambiguous = true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (escaped) {
      current += char;
      active = true;
      escaped = false;
      continue;
    }
    if (
      dialect === "posix" &&
      quote === "double" &&
      char === "\\" &&
      !new Set(["$", "`", '"', "\\", "\n"]).has(text[index + 1] ?? "")
    ) {
      current += char;
      active = true;
      continue;
    }
    if (isEscapeCharacter(char, dialect, quote)) {
      escaped = true;
      active = true;
      continue;
    }
    if (
      dialect === "powershell" &&
      ((quote === "single" && char === "'") || (quote === "double" && char === '"')) &&
      text[index + 1] === char
    ) {
      current += char;
      active = true;
      index += 1;
      continue;
    }
    const nextQuote = quoteTransition(char, dialect, quote);
    if (nextQuote !== undefined) {
      quote = nextQuote;
      active = true;
      continue;
    }
    if (quote === null && /\s/u.test(char)) {
      flush();
      continue;
    }
    if (
      quote === null &&
      dialect === "posix" &&
      (char === "<" || char === ">") &&
      text[index + 1] === "("
    ) {
      ambiguous = true;
    }
    if (
      quote === null &&
      char === "~" &&
      !active &&
      dialect !== "cmd"
    ) {
      ambiguous = true;
    }
    if (
      quote === null &&
      !active &&
      dialect === "powershell" &&
      (char === "@" || char === "(")
    ) {
      ambiguous = true;
    }
    if (quote === null && char === "<") {
      const adjacentFd = active && /^\d+$/u.test(current) ? current : null;
      if (adjacentFd !== null) {
        current = "";
        active = false;
        if (adjacentFd !== "0") ambiguous = true;
      } else {
        flush();
      }
      if (redirectPending || text[index + 1] === "<") ambiguous = true;
      redirectPending = true;
      continue;
    }
    if (quote === null && char === ">") ambiguous = true;
    if (isDynamicCharacter(text, index, dialect, quote)) ambiguous = true;
    current += char;
    active = true;
  }
  flush();
  if (quote !== null || escaped || redirectPending) ambiguous = true;
  return { tokens, inputRedirections, ambiguous };
}

function separatorWidth(text: string, index: number, dialect: CommandDialect): number {
  const char = text[index] ?? "";
  const pair = text.slice(index, index + 2);
  if (char === "\r" && text[index + 1] === "\n") return 2;
  if (pair === "&&" || pair === "||") return 2;
  if (char === "\r" || char === "\n" || char === "|") return 1;
  if (char === ";" && dialect !== "cmd") return 1;
  if (char === "&" && dialect !== "powershell") return 1;
  return 0;
}

function quoteTransition(
  char: string,
  dialect: CommandDialect,
  quote: "single" | "double" | null,
): "single" | "double" | null | undefined {
  if (char === '"' && quote !== "single") return quote === "double" ? null : "double";
  if (dialect !== "cmd" && char === "'" && quote !== "double") {
    return quote === "single" ? null : "single";
  }
  return undefined;
}

function isEscapeCharacter(
  char: string,
  dialect: CommandDialect,
  quote: "single" | "double" | null,
): boolean {
  if (quote === "single") return false;
  if (dialect === "posix") return char === "\\";
  if (dialect === "cmd") return quote === null && char === "^";
  return char === "`";
}

function isDynamicCharacter(
  text: string,
  index: number,
  dialect: CommandDialect,
  quote: "single" | "double" | null,
): boolean {
  if (quote === "single") return false;
  const char = text[index] ?? "";
  if (dialect === "posix") {
    return char === "$" || char === "`" || (quote === null && (char === "{" || char === "}"));
  }
  if (dialect === "cmd") {
    return char === "%" || char === "!" || (quote === null && (char === "(" || char === ")"));
  }
  return char === "$" || (quote === null && (char === "," || char === "{" || char === "}" || text.slice(index, index + 2) === "@("));
}

function isOpaquePackageScript(tokens: string[], dialect: CommandDialect): boolean {
  const command = comparableCommandName(tokens[0] ?? "", dialect);
  if (!new Set(["npm", "pnpm", "yarn", "bun"]).has(command)) return false;
  const action = normalizeForDialect(tokens[1] ?? "", dialect);
  if (action === "test") return true;
  return action === "run" && tokens[2] !== undefined && tokens[2] !== "";
}

function comparableCommandName(token: string, dialect: CommandDialect): string {
  const separators = dialect === "posix" ? /\//u : /[\\/]/u;
  const base = token.split(separators).at(-1) ?? token;
  const normalized = normalizeForDialect(base, dialect);
  if (dialect !== "posix" && normalized.endsWith(".exe")) return normalized.slice(0, -4);
  return normalized;
}

function normalizeForDialect(value: string, dialect: CommandDialect): string {
  return dialect === "posix" ? value : value.toLowerCase();
}

function equalsForDialect(left: string, right: string, dialect: CommandDialect): boolean {
  return normalizeForDialect(left, dialect) === normalizeForDialect(right, dialect);
}

function isCount(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/u.test(value);
}

function isNonOptionValue(value: string | undefined): boolean {
  return value !== undefined && value !== "" && !value.startsWith("-");
}

function targetsOrStdin(paths: string[]): CommandTarget[] {
  return paths.length === 0 ? [stdinTarget()] : paths.map(pathTarget);
}

function pathTarget(value: string): CommandTarget {
  return value === "-" ? stdinTarget() : { kind: "path", value };
}

function stdinTarget(): CommandTarget {
  return { kind: "stdin", value: "-" };
}

function cwdTarget(): CommandTarget {
  return { kind: "cwd", value: "." };
}

function commandResult(
  command: string,
  targets: CommandTarget[],
): InspectedRepositoryCommand {
  return { command, targets, inputRedirections: [] };
}

function ambiguousInspection(
  commands: InspectedRepositoryCommand[] = [],
): CommandInspection {
  return { kind: "ambiguous", commands };
}

function notRecognizedInspection(): CommandInspection {
  return { kind: "notRecognized", commands: [] };
}
