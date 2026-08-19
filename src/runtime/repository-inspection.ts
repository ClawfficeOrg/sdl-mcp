import { realpathSync } from "node:fs";
import path from "node:path";

import {
  inspectCommandText,
  inspectSimpleArgv,
  type CommandDialect,
  type CommandInspection,
  type CommandTarget,
} from "./repository-command-inspection.js";
import {
  inspectInlineJavaScript,
  inspectInlinePython,
  type InlineInspectionCandidate,
} from "./repository-inline-inspection.js";

export type RuntimeName =
  | "node"
  | "typescript"
  | "python"
  | "shell"
  | "powershell"
  | "ruby"
  | "php"
  | "perl"
  | "r"
  | "elixir"
  | "go"
  | "java"
  | "kotlin"
  | "rust"
  | "c"
  | "cpp"
  | "csharp";

export interface RuntimeRepositoryInspectionRequest {
  repoRoot: string;
  registeredRepoRoot?: string;
  cwd: string;
  runtime: RuntimeName;
  executable: string;
  args: readonly string[];
  code?: string;
  stdin?: string;
  platform?: NodeJS.Platform;
}

export type RuntimeRepositoryInspectionDecision =
  | { decision: "allow" }
  | {
      decision: "deny";
      category:
        | "directReader"
        | "repositorySearch"
        | "inlineStaticRead"
        | "inputRedirection";
      ruleId: string;
    };

const DIRECT_READERS = new Set([
  "cat",
  "more",
  "head",
  "tail",
  "type",
  "get-content",
]);

const REPOSITORY_SEARCHES = new Set([
  "rg",
  "grep",
  "findstr",
  "select-string",
  "sed",
  "awk",
]);

const COMMAND_EXECUTABLES = new Set([
  ...DIRECT_READERS,
  ...REPOSITORY_SEARCHES,
  "ripgrep",
  "gc",
  "sh",
  "bash",
  "cmd",
  "powershell",
  "pwsh",
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

const NODE_SOURCE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const NODE_STDIN_SWITCHES = new Set([
  "--no-warnings",
  "--experimental-strip-types",
  "-i",
]);
const PYTHON_STDIN_SWITCHES = new Set([
  "-B",
  "-b",
  "-d",
  "-E",
  "-i",
  "-I",
  "-O",
  "-OO",
  "-P",
  "-q",
  "-s",
  "-S",
  "-u",
  "-v",
  "-V",
  "-x",
]);

/** Classify stable, lexical attempts to inspect files in the current repository. */
export function classifyRuntimeRepositoryInspection(
  request: RuntimeRepositoryInspectionRequest,
): RuntimeRepositoryInspectionDecision {
  const dialect = commandDialect(request);

  if (request.code !== undefined) {
    return inspectRuntimeCode(request, dialect, request.code);
  }

  const directInspection = inspectDirectInvocation(request, dialect);
  if (directInspection?.kind === "ambiguous") return { decision: "allow" };
  if (directInspection?.kind === "parsed") {
    const decision = classifyCommands(directInspection, request);
    if (decision.decision === "deny") return decision;
  }

  if (request.runtime === "node" || request.runtime === "typescript") {
    const source = nodeInvocationSource(request.args, request.stdin);
    return source === null
      ? { decision: "allow" }
      : classifyInline(
          inspectInlineJavaScript(source.source, {
            commonJsRequire:
              request.runtime === "node" && source.commonJsRequire,
          }),
          request,
        );
  }

  if (request.runtime === "python") {
    const source = pythonInvocationSource(request.args, request.stdin);
    return source === null
      ? { decision: "allow" }
      : classifyInline(inspectInlinePython(source), request);
  }

  return { decision: "allow" };
}

function inspectRuntimeCode(
  request: RuntimeRepositoryInspectionRequest,
  dialect: CommandDialect,
  source: string,
): RuntimeRepositoryInspectionDecision {
  if (request.runtime === "node" || request.runtime === "typescript") {
    return classifyInline(inspectInlineJavaScript(source), request);
  }
  if (request.runtime === "python") {
    return classifyInline(inspectInlinePython(source), request);
  }
  if (request.runtime === "shell" || request.runtime === "powershell") {
    const inspection = inspectCommandText(source, dialect);
    if (inspection.kind !== "parsed") return { decision: "allow" };
    return classifyCommands(inspection, request);
  }
  return { decision: "allow" };
}

function inspectDirectInvocation(
  request: RuntimeRepositoryInspectionRequest,
  dialect: CommandDialect,
): CommandInspection | null {
  const name = executableName(request.executable, request.platform);
  if (!COMMAND_EXECUTABLES.has(name)) return null;
  return inspectSimpleArgv([request.executable, ...request.args], dialect);
}

function classifyCommands(
  inspection: Extract<CommandInspection, { kind: "parsed" }>,
  request: RuntimeRepositoryInspectionRequest,
): RuntimeRepositoryInspectionDecision {
  for (const command of inspection.commands) {
    for (const target of command.targets) {
      if (!targetInspectsRepository(target, request)) continue;
      if (REPOSITORY_SEARCHES.has(command.command)) {
        return {
          decision: "deny",
          category: "repositorySearch",
          ruleId: `command.repository-search.${command.command}`,
        };
      }
      return {
        decision: "deny",
        category: "directReader",
        ruleId: `command.direct-reader.${command.command}`,
      };
    }
    for (const target of command.inputRedirections) {
      if (targetInspectsRepository(target, request)) {
        return {
          decision: "deny",
          category: "inputRedirection",
          ruleId: `command.input-redirection.${command.command}`,
        };
      }
    }
  }
  return { decision: "allow" };
}

function classifyInline(
  candidates: readonly InlineInspectionCandidate[],
  request: RuntimeRepositoryInspectionRequest,
): RuntimeRepositoryInspectionDecision {
  for (const candidate of candidates) {
    if (pathInspectsRepository(candidate.path, request)) {
      return {
        decision: "deny",
        category: "inlineStaticRead",
        ruleId: candidate.ruleId,
      };
    }
  }
  return { decision: "allow" };
}

function targetInspectsRepository(
  target: CommandTarget,
  request: RuntimeRepositoryInspectionRequest,
): boolean {
  if (target.kind === "stdin") return false;
  return pathInspectsRepository(target.value, request);
}

function pathInspectsRepository(
  target: string,
  request: RuntimeRepositoryInspectionRequest,
): boolean {
  if (target === "" || target === "-" || target.includes("\0")) return false;

  const platform = request.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedTarget = normalizeWindowsDevicePath(target, platform);
  const normalizedRepoRoot = normalizeWindowsDevicePath(request.repoRoot, platform);
  const normalizedCwd = normalizeWindowsDevicePath(request.cwd, platform);
  if (!pathApi.isAbsolute(normalizedRepoRoot)) return false;
  if (platform === "win32" && isUncertainWindowsPath(normalizedTarget)) return false;
  if (!pathApi.isAbsolute(normalizedCwd)) return false;
  if (platform === "win32" && isUncertainWindowsPath(normalizedCwd)) return false;

  const staticTarget = staticPathPrefix(normalizedTarget, pathApi.sep);
  if (staticTarget === null) return false;

  const repoRoot = pathApi.resolve(normalizedRepoRoot);
  const cwd = pathApi.resolve(normalizedCwd);
  const resolvedTarget = pathApi.resolve(cwd, staticTarget);
  const roots = [repoRoot, canonicalExistingPath(repoRoot, platform)];
  if (
    request.registeredRepoRoot !== undefined &&
    pathApi.isAbsolute(
      normalizeWindowsDevicePath(request.registeredRepoRoot, platform),
    ) &&
    !(
      platform === "win32" &&
      isUncertainWindowsPath(
        normalizeWindowsDevicePath(request.registeredRepoRoot, platform),
      )
    )
  ) {
    const registeredRoot = pathApi.resolve(
      normalizeWindowsDevicePath(request.registeredRepoRoot, platform),
    );
    roots.push(registeredRoot, canonicalExistingPath(registeredRoot, platform));
  }
  const targets = [resolvedTarget, canonicalExistingPath(resolvedTarget, platform)];
  return targets.some((candidate) =>
    roots.some((root) =>
      isPathWithinRoot(candidate, root, platform, pathApi.sep),
    ),
  );
}

function normalizeWindowsDevicePath(
  value: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return value;
  return /^\\\\\?\\[A-Za-z]:\\/u.test(value) ? value.slice(4) : value;
}

function canonicalExistingPath(
  value: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== process.platform) return value;
  try {
    return normalizeWindowsDevicePath(realpathSync.native(value), platform);
  } catch {
    return value;
  }
}

function isPathWithinRoot(
  target: string,
  root: string,
  platform: NodeJS.Platform,
  separator: string,
): boolean {
  const comparableRoot = comparablePath(root, platform);
  const comparableTarget = comparablePath(target, platform);
  const rootPrefix = comparableRoot.endsWith(separator)
    ? comparableRoot
    : `${comparableRoot}${separator}`;
  return comparableTarget === comparableRoot || comparableTarget.startsWith(rootPrefix);
}

function staticPathPrefix(target: string, separator: string): string | null {
  const globIndex = target.search(/[?*[\]]/u);
  if (globIndex < 0) return target;

  const dynamicSuffix = target.slice(globIndex);
  const dotSegment = new RegExp(
    `(?:^|[${separator === "\\" ? "\\\\/" : "/"}])\\.\\.(?:[${separator === "\\" ? "\\\\/" : "/"}]|$)`,
    "u",
  );
  if (dotSegment.test(dynamicSuffix)) return null;

  const prefix = target.slice(0, globIndex);
  const lastSeparator = Math.max(
    prefix.lastIndexOf("/"),
    prefix.lastIndexOf("\\"),
  );
  return lastSeparator < 0 ? "." : prefix.slice(0, lastSeparator + 1);
}

function isUncertainWindowsPath(value: string): boolean {
  return (
    /^[A-Za-z]:(?:[^\\/]|$)/u.test(value) ||
    /^\\\\[.?]\\/u.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]/u.test(value)
  );
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function commandDialect(
  request: RuntimeRepositoryInspectionRequest,
): CommandDialect {
  if (request.runtime === "powershell") return "powershell";
  return (request.platform ?? process.platform) === "win32" ? "cmd" : "posix";
}

function executableName(
  executable: string,
  platform: NodeJS.Platform | undefined,
): string {
  const separators =
    (platform ?? process.platform) === "win32" ? /[\\/]/u : /\//u;
  const base = executable.split(separators).at(-1)!.toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function nodeInvocationSource(
  args: readonly string[],
  stdin: string | undefined,
): { source: string; commonJsRequire: boolean } | null {
  let index = 0;
  let commonJsRequire = true;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (NODE_SOURCE_FLAGS.has(arg)) {
      const source = args[index + 1];
      if (
        source === undefined ||
        hasNodeSourceArgumentBeforeEndOfOptions(args.slice(index + 2))
      ) {
        return null;
      }
      return { source, commonJsRequire };
    }
    const attachedSource = nodeAttachedSource(arg);
    if (attachedSource !== undefined) {
      return hasNodeSourceArgumentBeforeEndOfOptions(args.slice(index + 1))
        ? null
        : { source: attachedSource, commonJsRequire };
    }
    if (arg === "-") {
      return stdin === undefined ? null : { source: stdin, commonJsRequire };
    }
    if (arg === "--") {
      return index === args.length - 1 && stdin !== undefined
        ? { source: stdin, commonJsRequire }
        : null;
    }
    if (arg === "--input-type") {
      const mode = nodeInputTypeUsesCommonJs(args[index + 1]);
      if (mode === null) return null;
      commonJsRequire = mode;
      index += 2;
      continue;
    }
    if (arg.startsWith("--input-type=")) {
      const mode = nodeInputTypeUsesCommonJs(arg.slice("--input-type=".length));
      if (mode === null) return null;
      commonJsRequire = mode;
      index += 1;
      continue;
    }
    if (NODE_STDIN_SWITCHES.has(arg)) {
      index += 1;
      continue;
    }
    return null;
  }
  return stdin === undefined ? null : { source: stdin, commonJsRequire };
}

function nodeInputTypeUsesCommonJs(value: string | undefined): boolean | null {
  if (value === "commonjs" || value === "commonjs-typescript") return true;
  if (value === "module" || value === "module-typescript") return false;
  return null;
}

function pythonInvocationSource(
  args: readonly string[],
  stdin: string | undefined,
): string | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "-c") {
      const source = args[index + 1];
      if (source === undefined) return null;
      // Python stops option parsing at -c; every later token belongs to sys.argv.
      return source;
    }
    const attachedSource = pythonAttachedSource(arg);
    if (attachedSource !== undefined) {
      return attachedSource;
    }
    if (arg === "-") return stdin ?? null;
    if (PYTHON_STDIN_SWITCHES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "-W" || arg === "-X") {
      if (args[index + 1] === undefined) return null;
      index += 2;
      continue;
    }
    return null;
  }
  return stdin ?? null;
}

function nodeAttachedSource(argument: string): string | undefined {
  for (const prefix of ["--eval=", "--print="]) {
    if (argument.startsWith(prefix)) return argument.slice(prefix.length);
  }
  if (
    argument.length > 2 &&
    (argument.startsWith("-e") || argument.startsWith("-p"))
  ) {
    return argument.slice(2);
  }
  return undefined;
}

function isNodeSourceArgument(argument: string): boolean {
  return (
    NODE_SOURCE_FLAGS.has(argument) ||
    nodeAttachedSource(argument) !== undefined
  );
}

function hasNodeSourceArgumentBeforeEndOfOptions(
  args: readonly string[],
): boolean {
  const endOfOptions = args.indexOf("--");
  const options = endOfOptions === -1 ? args : args.slice(0, endOfOptions);
  return options.some(isNodeSourceArgument);
}

function pythonAttachedSource(argument: string): string | undefined {
  return argument.length > 2 && argument.startsWith("-c")
    ? argument.slice(2)
    : undefined;
}
