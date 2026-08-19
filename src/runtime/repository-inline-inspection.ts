export type InlineInspectionRuleId =
  | "inline.javascript.fs-read-file-sync"
  | "inline.javascript.fs-read-file"
  | "inline.javascript.fs-promises-read-file"
  | "inline.javascript.imported-read-file-sync"
  | "inline.javascript.imported-read-file"
  | "inline.python.open"
  | "inline.python.path-read-text"
  | "inline.python.path-read-bytes";

export interface InlineInspectionCandidate {
  path: string;
  ruleId: InlineInspectionRuleId;
}

export interface InlineJavaScriptInspectionOptions {
  commonJsRequire?: boolean;
}

type Language = "javascript" | "python";
type TokenKind = "identifier" | "string" | "punctuation" | "newline";

interface Token {
  kind: TokenKind;
  text: string;
  value?: string;
  lineBreakBefore?: boolean;
}

interface JavaScriptBindings {
  fs: Set<string>;
  fsPromises: Set<string>;
  readFileSync: Set<string>;
  readFile: Set<string>;
  createRequire: Set<string>;
  require: Set<string>;
  importRanges: Array<[number, number]>;
}

interface PythonBindingStates {
  path: boolean[];
  open: boolean[];
  pathBindings: Map<string, PythonPathBindingEvent[]>;
}

type PythonPathBindingKind = "path" | "namespace";

interface PythonPathBindingEvent {
  index: number;
  kind: PythonPathBindingKind | null;
}

interface PythonBindingState {
  path: boolean;
  open: boolean;
}

interface PythonImportParse {
  nextIndex: number;
  state: PythonBindingState;
}

const MAX_SOURCE_LENGTH = 32_768;
const MAX_TOKENS = 4_096;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_CANDIDATES = 64;

const JAVASCRIPT_PROTECTED_BINDINGS = new Set([
  "fs",
  "readFileSync",
  "readFile",
  "require",
]);

const PYTHON_UNSUPPORTED_STRUCTURES = new Set([
  "def", "class", "for", "while", "with", "try", "del", "lambda",
  "if", "elif", "else", "except", "finally", "match", "case",
  "global", "nonlocal", "async",
]);

/** Recognize closed JavaScript/TypeScript repository-read primitives. */
export function inspectInlineJavaScript(
  source: string,
  options: InlineJavaScriptInspectionOptions = {},
): InlineInspectionCandidate[] {
  const tokens = tokenize(source, "javascript");
  if (tokens === null) return [];
  const commonJsRequire =
    options.commonJsRequire === true && !hasJavaScriptModuleSyntax(tokens);

  const bindings = inspectJavaScriptImports(tokens, commonJsRequire);
  if (bindings === null) return [];
  const protectedNames = javaScriptProtectedNames(bindings);
  const shadowed = collectJavaScriptShadows(
    tokens,
    bindings.importRanges,
    protectedNames,
  );
  const mutations = collectJavaScriptBindingMutations(
    tokens,
    bindings.importRanges,
    protectedNames,
  );
  const candidates: InlineInspectionCandidate[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    let ruleId: InlineInspectionRuleId | null = null;
    let openingParenthesis = -1;
    const bindingName = tokens[index]?.text ?? "";
    const fsAvailable = isJavaScriptBindingAvailable(
      bindings.fs,
      bindingName,
      index,
      shadowed,
      mutations,
    );
    const fsPromisesAvailable = isJavaScriptBindingAvailable(
      bindings.fsPromises,
      bindingName,
      index,
      shadowed,
      mutations,
    );
    const readFileSyncAvailable = isJavaScriptBindingAvailable(
      bindings.readFileSync,
      bindingName,
      index,
      shadowed,
      mutations,
    );
    const readFileAvailable = isJavaScriptBindingAvailable(
      bindings.readFile,
      bindingName,
      index,
      shadowed,
      mutations,
    );

    if (
      fsAvailable &&
      isSequence(tokens, index, [bindingName, ".", "readFileSync", "("])
    ) {
      ruleId = "inline.javascript.fs-read-file-sync";
      openingParenthesis = index + 3;
    } else if (
      fsAvailable &&
      isSequence(tokens, index, [bindingName, ".", "readFile", "("])
    ) {
      ruleId = "inline.javascript.fs-read-file";
      openingParenthesis = index + 3;
    } else if (
      fsAvailable &&
      isSequence(tokens, index, [bindingName, ".", "promises", ".", "readFile", "("])
    ) {
      ruleId = "inline.javascript.fs-promises-read-file";
      openingParenthesis = index + 5;
    } else if (
      fsPromisesAvailable &&
      isSequence(tokens, index, [bindingName, ".", "readFile", "("])
    ) {
      ruleId = "inline.javascript.fs-promises-read-file";
      openingParenthesis = index + 3;
    } else if (
      readFileSyncAvailable &&
      tokens[index + 1]?.text === "(" &&
      tokens[index - 1]?.text !== "."
    ) {
      ruleId = "inline.javascript.imported-read-file-sync";
      openingParenthesis = index + 1;
    } else if (
      readFileAvailable &&
      tokens[index + 1]?.text === "(" &&
      tokens[index - 1]?.text !== "."
    ) {
      ruleId = "inline.javascript.imported-read-file";
      openingParenthesis = index + 1;
    } else {
      const requiredModule = staticFsRequireModule(
        tokens,
        index,
        bindings.require,
        shadowed,
        mutations,
      );
      if (
        requiredModule === "fs" &&
        isSequence(tokens, index + 4, [".", "readFileSync", "("])
      ) {
        ruleId = "inline.javascript.fs-read-file-sync";
        openingParenthesis = index + 6;
      } else if (
        requiredModule === "fs" &&
        isSequence(tokens, index + 4, [".", "readFile", "("])
      ) {
        ruleId = "inline.javascript.fs-read-file";
        openingParenthesis = index + 6;
      } else if (
        requiredModule === "fs" &&
        isSequence(tokens, index + 4, [".", "promises", ".", "readFile", "("])
      ) {
        ruleId = "inline.javascript.fs-promises-read-file";
        openingParenthesis = index + 8;
      } else if (
        requiredModule === "fsPromises" &&
        isSequence(tokens, index + 4, [".", "readFile", "("])
      ) {
        ruleId = "inline.javascript.fs-promises-read-file";
        openingParenthesis = index + 6;
      }
    }

    if (ruleId === null) continue;
    const pathToken = tokens[openingParenthesis + 1];
    const separator = tokens[openingParenthesis + 2]?.text;
    if (
      pathToken?.kind !== "string" ||
      (separator !== "," && separator !== ")")
    ) {
      continue;
    }
    candidates.push({ path: pathToken.value ?? "", ruleId });
    if (candidates.length > MAX_CANDIDATES) return [];
  }

  return candidates;
}

/** Recognize closed Python repository-read primitives. */
export function inspectInlinePython(source: string): InlineInspectionCandidate[] {
  const tokens = tokenize(source, "python");
  if (
    tokens === null ||
    tokens.some((token) => token.text === ";") ||
    hasUnsupportedPythonStructure(tokens)
  ) {
    return [];
  }

  const bindings = inspectPythonBindingStates(tokens);
  if (bindings === null) return [];
  const shadowed = collectPythonShadows(tokens);
  const openGloballyShadowed = shadowed.has("open");
  const pathGloballyShadowed = shadowed.has("Path");
  const candidates: InlineInspectionCandidate[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (
      !openGloballyShadowed &&
      bindings.open[index] === true &&
      tokens[index]?.text === "open" &&
      tokens[index + 1]?.text === "(" &&
      tokens[index - 1]?.text !== "."
    ) {
      const parsed = inspectPythonOpen(tokens, index + 1);
      if (parsed !== null) {
        candidates.push({ path: parsed, ruleId: "inline.python.open" });
      }
    }

    if (
      !pathGloballyShadowed &&
      bindings.path[index] === true &&
      tokens[index]?.text === "Path" &&
      tokens[index + 1]?.text === "(" &&
      tokens[index - 1]?.text !== "."
    ) {
      const path = inspectPythonPathRead(tokens, index + 1);
      if (path !== null) candidates.push(path);
    }

    const bindingName = tokens[index]?.text ?? "";
    const pathBinding = pythonPathBindingAt(
      bindings.pathBindings,
      bindingName,
      index,
    );
    if (
      pathBinding === "path" &&
      tokens[index + 1]?.text === "(" &&
      tokens[index - 1]?.text !== "."
    ) {
      const path = inspectPythonPathRead(tokens, index + 1);
      if (path !== null) candidates.push(path);
    } else if (
      pathBinding === "namespace" &&
      isSequence(tokens, index, [bindingName, ".", "Path", "("])
    ) {
      const path = inspectPythonPathRead(tokens, index + 3);
      if (path !== null) candidates.push(path);
    }

    if (candidates.length > MAX_CANDIDATES) return [];
  }

  return candidates;
}

function tokenize(source: string, language: Language): Token[] | null {
  if (source.length > MAX_SOURCE_LENGTH) return null;
  const tokens: Token[] = [];
  let index = 0;
  let pendingJavaScriptLineBreak = false;

  const push = (token: Token): boolean => {
    if (token.text.length > MAX_TOKEN_LENGTH) return false;
    tokens.push(
      language === "javascript" && pendingJavaScriptLineBreak
        ? { ...token, lineBreakBefore: true }
        : token,
    );
    pendingJavaScriptLineBreak = false;
    return tokens.length <= MAX_TOKENS;
  };

  while (index < source.length) {
    const char = source[index] ?? "";
    if (/\s/u.test(char)) {
      if (language === "javascript" && (char === "\n" || char === "\r")) {
        pendingJavaScriptLineBreak = true;
      }
      if (
        language === "python" &&
        (char === "\n" || char === "\r") &&
        tokens[tokens.length - 1]?.kind !== "newline"
      ) {
        if (!push({ kind: "newline", text: "\n" })) return null;
      }
      index += char === "\r" && source[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    if (language === "javascript" && source.slice(index, index + 2) === "//") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (language === "javascript" && source.slice(index, index + 2) === "/*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return null;
      if (/[\r\n]/u.test(source.slice(index, end + 2))) {
        pendingJavaScriptLineBreak = true;
      }
      index = end + 2;
      continue;
    }
    if (language === "python" && char === "#") {
      index = skipLineComment(source, index + 1);
      continue;
    }
    if (
      language === "python" &&
      (source.slice(index, index + 2) === "/*" ||
        source.slice(index, index + 2) === "*/")
    ) {
      return null;
    }

    if (
      char === "'" ||
      char === '"' ||
      (language === "javascript" && char === "`")
    ) {
      if (language === "python" && source.slice(index, index + 3) === char.repeat(3)) {
        return null;
      }
      const parsed = readStringToken(source, index, language, char);
      if (parsed === null || !push(parsed.token)) return null;
      index = parsed.nextIndex;
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (end < source.length && isIdentifierPart(source[end] ?? "")) end += 1;
      if (!push({ kind: "identifier", text: source.slice(index, end) })) {
        return null;
      }
      index = end;
      continue;
    }

    if (language === "javascript" && char === "/") return null;

    const pair = source.slice(index, index + 2);
    if (
      language === "javascript" &&
      new Set(["=>", "?.", "++", "--", "==", "!=", "&&", "||", "??"]).has(pair)
    ) {
      if (!push({ kind: "punctuation", text: pair })) return null;
      index += 2;
      continue;
    }
    if (!push({ kind: "punctuation", text: char })) return null;
    index += 1;
  }

  return delimitersAreBalanced(tokens) ? tokens : null;
}

function readStringToken(
  source: string,
  start: number,
  language: Language,
  quote: string,
): { token: Token; nextIndex: number } | null {
  let value = "";
  let index = start + 1;

  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === quote) {
      return {
        token: { kind: "string", text: source.slice(start, index + 1), value },
        nextIndex: index + 1,
      };
    }
    if (
      language === "javascript" &&
      quote === "`" &&
      char === "$" &&
      source[index + 1] === "{"
    ) {
      return null;
    }
    if (char === "\\") {
      const decoded = decodeEscape(source, index, language);
      if (decoded === null) return null;
      value += decoded.value;
      index = decoded.nextIndex;
    } else {
      if ((char === "\n" || char === "\r") && quote !== "`") return null;
      value += char;
      index += 1;
    }
    if (index - start > MAX_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) {
      return null;
    }
  }
  return null;
}

function decodeEscape(
  source: string,
  slashIndex: number,
  language: Language,
): { value: string; nextIndex: number } | null {
  const escaped = source[slashIndex + 1];
  if (escaped === undefined) return null;
  const simple = new Map<string, string>([
    ["n", "\n"], ["r", "\r"], ["t", "\t"], ["b", "\b"],
    ["f", "\f"], ["v", "\v"], ["a", "\u0007"], ["0", "\0"], ["\\", "\\"],
    ["'", "'"], ['"', '"'], ["`", "`"], ["$", "$"],
  ]);
  if (language === "python" && /^[0-7]$/u.test(escaped)) {
    let end = slashIndex + 1;
    while (
      end < source.length &&
      end < slashIndex + 4 &&
      /^[0-7]$/u.test(source[end] ?? "")
    ) {
      end += 1;
    }
    return {
      value: String.fromCodePoint(Number.parseInt(source.slice(slashIndex + 1, end), 8)),
      nextIndex: end,
    };
  }
  const simpleValue = simple.get(escaped);
  if (simpleValue !== undefined) {
    return { value: simpleValue, nextIndex: slashIndex + 2 };
  }
  if (escaped === "\n") return { value: "", nextIndex: slashIndex + 2 };
  if (escaped === "\r") {
    return {
      value: "",
      nextIndex: slashIndex + (source[slashIndex + 2] === "\n" ? 3 : 2),
    };
  }
  if (escaped === "x") return decodeFixedHex(source, slashIndex, 2, 2);
  if (escaped === "u") {
    if (language === "javascript" && source[slashIndex + 2] === "{") {
      const end = source.indexOf("}", slashIndex + 3);
      if (end < 0) return null;
      const hex = source.slice(slashIndex + 3, end);
      return decodeCodePoint(hex, end + 1);
    }
    return decodeFixedHex(source, slashIndex, 4, 2);
  }
  if (escaped === "U" && language === "python") {
    return decodeFixedHex(source, slashIndex, 8, 2);
  }
  if (escaped === "N" && language === "python") {
    if (source[slashIndex + 2] !== "{") return null;
    const end = source.indexOf("}", slashIndex + 3);
    if (end < 0) return null;
    const value = decodePythonUnicodeName(source.slice(slashIndex + 3, end));
    return value === null ? null : { value, nextIndex: end + 1 };
  }
  if (language === "python") return null;
  return {
    value: escaped,
    nextIndex: slashIndex + 2,
  };
}

function decodePythonUnicodeName(name: string): string | null {
  const latin = /^LATIN (SMALL|CAPITAL) LETTER ([A-Z])$/u.exec(name);
  if (latin !== null) {
    const letter = latin[2] ?? "";
    return latin[1] === "SMALL" ? letter.toLowerCase() : letter;
  }
  const names = new Map([
    ["DIGIT ZERO", "0"], ["DIGIT ONE", "1"], ["DIGIT TWO", "2"],
    ["DIGIT THREE", "3"], ["DIGIT FOUR", "4"], ["DIGIT FIVE", "5"],
    ["DIGIT SIX", "6"], ["DIGIT SEVEN", "7"], ["DIGIT EIGHT", "8"],
    ["DIGIT NINE", "9"], ["SPACE", " "],
  ]);
  return names.get(name) ?? null;
}

function decodeFixedHex(
  source: string,
  slashIndex: number,
  length: number,
  prefixLength: number,
): { value: string; nextIndex: number } | null {
  const start = slashIndex + prefixLength;
  const hex = source.slice(start, start + length);
  if (hex.length !== length) return null;
  return decodeCodePoint(hex, start + length);
}

function decodeCodePoint(
  hex: string,
  nextIndex: number,
): { value: string; nextIndex: number } | null {
  if (!/^[0-9a-fA-F]+$/u.test(hex)) return null;
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return null;
  }
  return { value: String.fromCodePoint(codePoint), nextIndex };
}

function inspectJavaScriptImports(
  tokens: Token[],
  commonJsRequire: boolean,
): JavaScriptBindings | null {
  const bindings: JavaScriptBindings = {
    fs: new Set<string>(),
    fsPromises: new Set<string>(),
    readFileSync: new Set<string>(),
    readFile: new Set<string>(),
    createRequire: new Set<string>(),
    require: commonJsRequire ? new Set(["require"]) : new Set<string>(),
    importRanges: [],
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index]?.text !== "import" ||
      tokens[index + 1]?.text === "(" ||
      tokens[index + 1]?.text === "."
    ) {
      continue;
    }
    let fromIndex = -1;
    let moduleIndex = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor]?.text === ";") break;
      if (tokens[cursor]?.text === "from") {
        fromIndex = cursor;
        if (tokens[cursor + 1]?.kind === "string") moduleIndex = cursor + 1;
        break;
      }
      if (tokens[cursor]?.kind === "string") {
        moduleIndex = cursor;
        break;
      }
    }
    if (moduleIndex < 0) return null;
    bindings.importRanges.push([index, moduleIndex]);
    const moduleName = tokens[moduleIndex]?.value;
    if (
      moduleName !== "fs" &&
      moduleName !== "node:fs" &&
      moduleName !== "fs/promises" &&
      moduleName !== "node:fs/promises" &&
      moduleName !== "module" &&
      moduleName !== "node:module"
    ) {
      index = moduleIndex;
      continue;
    }
    if (fromIndex < 0) {
      index = moduleIndex;
      continue;
    }
    inspectJavaScriptImportSpecifiers(
      tokens,
      index + 1,
      fromIndex,
      moduleName,
      bindings,
    );
    index = moduleIndex;
  }
  let protectedNames = javaScriptProtectedNames(bindings);
  let shadowed = collectJavaScriptShadows(
    tokens,
    bindings.importRanges,
    protectedNames,
  );
  let mutations = collectJavaScriptBindingMutations(
    tokens,
    bindings.importRanges,
    protectedNames,
  );
  inspectCreateRequireBindings(tokens, bindings, shadowed, mutations);
  protectedNames = javaScriptProtectedNames(bindings);
  shadowed = collectJavaScriptShadows(
    tokens,
    bindings.importRanges,
    protectedNames,
  );
  mutations = collectJavaScriptBindingMutations(
    tokens,
    bindings.importRanges,
    protectedNames,
  );
  inspectCommonJsBindings(tokens, bindings, shadowed, mutations);
  return bindings;
}

function inspectCommonJsBindings(
  tokens: Token[],
  bindings: JavaScriptBindings,
  shadowed: Set<string>,
  mutations: Map<string, number>,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== "const") continue;
    const moduleName = staticFsRequireModule(
      tokens,
      index + 3,
      bindings.require,
      shadowed,
      mutations,
    );
    if (
      tokens[index + 1]?.kind === "identifier" &&
      tokens[index + 2]?.text === "=" &&
      moduleName !== null
    ) {
      const local = tokens[index + 1]?.text ?? "";
      (moduleName === "fs" ? bindings.fs : bindings.fsPromises).add(local);
      bindings.importRanges.push([index, index + 6]);
      index += 6;
      continue;
    }
    if (
      tokens[index + 1]?.text === "{" &&
      (tokens[index + 2]?.text === "readFileSync" ||
        tokens[index + 2]?.text === "readFile") &&
      tokens[index + 3]?.text === "}" &&
      tokens[index + 4]?.text === "=" &&
      staticFsRequireModule(
        tokens,
        index + 5,
        bindings.require,
        shadowed,
        mutations,
      ) !== null
    ) {
      const binding = tokens[index + 2]?.text;
      if (binding === "readFileSync") bindings.readFileSync.add(binding);
      if (binding === "readFile") bindings.readFile.add(binding);
      bindings.importRanges.push([index, index + 8]);
      index += 8;
    }
  }
}

function inspectCreateRequireBindings(
  tokens: Token[],
  bindings: JavaScriptBindings,
  shadowed: ReadonlySet<string>,
  mutations: ReadonlyMap<string, number>,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!new Set(["const", "let", "var"]).has(tokens[index]?.text ?? "")) {
      continue;
    }
    const local = tokens[index + 1]?.text ?? "";
    const factory = tokens[index + 3]?.text ?? "";
    if (
      local === "" ||
      tokens[index + 1]?.kind !== "identifier" ||
      tokens[index + 2]?.text !== "=" ||
      !isJavaScriptBindingAvailable(
        bindings.createRequire,
        factory,
        index + 3,
        shadowed,
        mutations,
      ) ||
      !isSequence(tokens, index + 4, [
        "(",
        "import",
        ".",
        "meta",
        ".",
        "url",
        ")",
      ])
    ) {
      continue;
    }
    bindings.require.add(local);
    bindings.importRanges.push([index, index + 10]);
    index += 10;
  }
}

function javaScriptProtectedNames(
  bindings: JavaScriptBindings,
): Set<string> {
  return new Set([
    ...JAVASCRIPT_PROTECTED_BINDINGS,
    ...bindings.fs,
    ...bindings.fsPromises,
    ...bindings.readFileSync,
    ...bindings.readFile,
    ...bindings.createRequire,
    ...bindings.require,
  ]);
}

function isJavaScriptBindingAvailable(
  bindings: ReadonlySet<string>,
  name: string,
  index: number,
  shadowed: ReadonlySet<string>,
  mutations: ReadonlyMap<string, number>,
): boolean {
  const mutationIndex = mutations.get(name);
  return (
    bindings.has(name) &&
    !shadowed.has(name) &&
    (mutationIndex === undefined || mutationIndex >= index)
  );
}

function staticFsRequireModule(
  tokens: Token[],
  index: number,
  requireBindings: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
  mutations: ReadonlyMap<string, number>,
): "fs" | "fsPromises" | null {
  const binding = tokens[index]?.text ?? "";
  if (
    !isJavaScriptBindingAvailable(
      requireBindings,
      binding,
      index,
      shadowed,
      mutations,
    )
  ) {
    return null;
  }
  if (
    tokens[index - 1]?.text === "." ||
    tokens[index + 1]?.text !== "(" ||
    tokens[index + 2]?.kind !== "string" ||
    tokens[index + 3]?.text !== ")"
  ) {
    return null;
  }
  const moduleName = tokens[index + 2]?.value;
  if (moduleName === "fs" || moduleName === "node:fs") return "fs";
  if (moduleName === "fs/promises" || moduleName === "node:fs/promises") {
    return "fsPromises";
  }
  return null;
}

function hasJavaScriptModuleSyntax(tokens: Token[]): boolean {
  return tokens.some(
    (token, index) =>
      token.kind === "identifier" &&
      tokens[index - 1]?.text !== "." &&
      ((token.text === "import" && tokens[index + 1]?.text !== "(") ||
        token.text === "export"),
  );
}

function inspectJavaScriptImportSpecifiers(
  tokens: Token[],
  start: number,
  end: number,
  moduleName: string,
  bindings: JavaScriptBindings,
): void {
  const fsModule = moduleName === "fs" || moduleName === "node:fs";
  const promisesModule =
    moduleName === "fs/promises" || moduleName === "node:fs/promises";
  const moduleModule = moduleName === "module" || moduleName === "node:module";
  let index = start;
  if (tokens[index]?.text === "type") return;
  if (tokens[index]?.kind === "identifier" && tokens[index]?.text !== "type") {
    if (fsModule && tokens[index]?.text === "fs") bindings.fs.add("fs");
    while (index < end && tokens[index]?.text !== ",") index += 1;
    if (tokens[index]?.text === ",") index += 1;
  }
  if (
    tokens[index]?.text === "*" &&
    tokens[index + 1]?.text === "as" &&
    tokens[index + 2]?.kind === "identifier"
  ) {
    const local = tokens[index + 2]?.text ?? "";
    if (fsModule && local === "fs") bindings.fs.add(local);
    if (promisesModule) bindings.fsPromises.add(local);
    return;
  }
  while (index < end && tokens[index]?.text !== "{") index += 1;
  if (tokens[index]?.text !== "{") return;
  index += 1;
  while (index < end && tokens[index]?.text !== "}") {
    const imported = tokens[index]?.text;
    if (tokens[index]?.kind !== "identifier") {
      index += 1;
      continue;
    }
    let local = imported;
    if (tokens[index + 1]?.text === "as") {
      local = tokens[index + 2]?.text;
      index += 3;
    } else {
      index += 1;
    }
    if (fsModule && imported === "promises" && local) {
      bindings.fsPromises.add(local);
    }
    if (fsModule && imported === local && imported === "readFileSync") {
      bindings.readFileSync.add(imported);
    }
    if (fsModule && imported === local && imported === "readFile") {
      bindings.readFile.add(imported);
    }
    if (promisesModule && imported === "readFile" && local) {
      bindings.readFile.add(local);
    }
    if (moduleModule && imported === "createRequire" && local) {
      bindings.createRequire.add(local);
    }
    while (index < end && tokens[index]?.text !== "," && tokens[index]?.text !== "}") {
      index += 1;
    }
    if (tokens[index]?.text === ",") index += 1;
  }
}

function collectJavaScriptShadows(
  tokens: Token[],
  importRanges: Array<[number, number]>,
  protectedNames: ReadonlySet<string>,
): Set<string> {
  const shadowed = new Set<string>();
  const inImport = (index: number): boolean =>
    importRanges.some(([start, end]) => index >= start && index <= end);

  for (let index = 0; index < tokens.length; index += 1) {
    if (inImport(index)) continue;
    const text = tokens[index]?.text;
    if (text === "function") {
      let cursor = index + 1;
      if (tokens[cursor]?.text === "*") cursor += 1;
      if (protectedNames.has(tokens[cursor]?.text ?? "")) {
        shadowed.add(tokens[cursor]?.text ?? "");
      }
      while (cursor < tokens.length && tokens[cursor]?.text !== "(") cursor += 1;
      const close = findMatching(tokens, cursor);
      if (close !== null) {
        collectProtectedNames(
          tokens,
          cursor + 1,
          close,
          shadowed,
          protectedNames,
        );
      }
    } else if (text === "catch") {
      const open = tokens[index + 1]?.text === "(" ? index + 1 : -1;
      const close = findMatching(tokens, open);
      if (close !== null) {
        collectProtectedNames(
          tokens,
          open + 1,
          close,
          shadowed,
          protectedNames,
        );
      }
    } else if (text === "class") {
      const name = tokens[index + 1]?.text ?? "";
      if (protectedNames.has(name)) shadowed.add(name);
    } else if (text === "const" || text === "let" || text === "var") {
      collectJavaScriptDeclarationNames(
        tokens,
        index + 1,
        shadowed,
        protectedNames,
      );
    } else if (text === "=>") {
      const previous = tokens[index - 1];
      if (protectedNames.has(previous?.text ?? "")) {
        shadowed.add(previous?.text ?? "");
      } else if (previous?.text === ")") {
        const open = findOpening(tokens, index - 1);
        if (open !== null) {
          collectProtectedNames(
            tokens,
            open + 1,
            index - 1,
            shadowed,
            protectedNames,
          );
        }
      }
    } else if (text === "(") {
      const close = findMatching(tokens, index);
      if (
        close !== null &&
        (tokens[close + 1]?.text === "{" || tokens[close + 1]?.text === ":")
      ) {
        collectProtectedNames(
          tokens,
          index + 1,
          close,
          shadowed,
          protectedNames,
        );
      }
    }
  }
  return shadowed;
}

function collectJavaScriptBindingMutations(
  tokens: Token[],
  importRanges: Array<[number, number]>,
  protectedNames: ReadonlySet<string>,
): Map<string, number> {
  const mutations = new Map<string, number>();
  const inImport = (index: number): boolean =>
    importRanges.some(([start, end]) => index >= start && index <= end);
  const record = (name: string, index: number): void => {
    if (!mutations.has(name)) mutations.set(name, index);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (inImport(index)) continue;
    const text = tokens[index]?.text ?? "";
    if (
      protectedNames.has(text) &&
      isJavaScriptBindingMutation(tokens, index)
    ) {
      record(text, index);
    }
    if (text !== "{" && text !== "[") continue;
    const close = findMatching(tokens, index);
    if (close === null || tokens[close + 1]?.text !== "=") continue;
    const activationIndex = findJavaScriptAssignmentActivationIndex(tokens, close + 2);
    collectJavaScriptAssignmentPatternBindings(
      tokens.slice(index, close + 1),
      (binding) => record(binding, activationIndex),
      protectedNames,
    );
    index = close;
  }
  return mutations;
}

function findJavaScriptAssignmentActivationIndex(
  tokens: Token[],
  rhsStart: number,
): number {
  let depth = 0;
  let sawRhsToken = false;
  for (let index = rhsStart; index < tokens.length; index += 1) {
    const token = tokens[index];
    const text = token?.text ?? "";
    if (
      token?.lineBreakBefore === true &&
      depth === 0 &&
      sawRhsToken &&
      !continuesJavaScriptExpression(tokens, index)
    ) {
      return index - 1;
    }
    if (text === "(" || text === "[" || text === "{") {
      depth += 1;
      sawRhsToken = true;
      continue;
    }
    if (text === ")" || text === "]" || text === "}") {
      if (depth === 0) return index;
      depth -= 1;
      sawRhsToken = true;
      continue;
    }
    if (depth === 0 && (text === "," || text === ";")) return index;
    sawRhsToken = true;
  }
  return tokens.length;
}

function continuesJavaScriptExpression(tokens: Token[], boundaryIndex: number): boolean {
  const continuation = new Set([
    ".", "?", ":", "+", "-", "*", "/", "%", "&", "|", "^",
    "=", "<", ">", "!", "~", ",", "(", "[", "{", "&&", "||",
    "??", "?.", "==", "!=",
  ]);
  return (
    continuation.has(tokens[boundaryIndex - 1]?.text ?? "") ||
    continuation.has(tokens[boundaryIndex]?.text ?? "")
  );
}

function collectJavaScriptAssignmentPatternBindings(
  pattern: Token[],
  record: (binding: string) => void,
  protectedNames: ReadonlySet<string> = JAVASCRIPT_PROTECTED_BINDINGS,
): void {
  const opening = pattern[0]?.text;
  if ((opening !== "{" && opening !== "[") || pattern.length < 2) return;
  const elements = splitArguments(pattern, 1, pattern.length - 1);
  if (elements === null) return;

  for (const element of elements) {
    if (element.length === 0) continue;
    const colon = opening === "{" ? findTopLevelToken(element, ":") : -1;
    let target = colon >= 0 ? element.slice(colon + 1) : element;
    const defaultValue = findTopLevelToken(target, "=");
    if (defaultValue >= 0) target = target.slice(0, defaultValue);
    while (target[0]?.text === ".") target = target.slice(1);
    collectJavaScriptBindingTarget(target, record, protectedNames);
  }
}

function collectJavaScriptBindingTarget(
  target: Token[],
  record: (binding: string) => void,
  protectedNames: ReadonlySet<string>,
): void {
  if (target.length === 1) {
    const binding = target[0]?.text ?? "";
    if (protectedNames.has(binding)) record(binding);
    return;
  }
  if (target[0]?.text !== "{" && target[0]?.text !== "[") return;
  const close = findMatching(target, 0);
  if (close === target.length - 1) {
    collectJavaScriptAssignmentPatternBindings(target, record, protectedNames);
  }
}

function findTopLevelToken(tokens: Token[], target: string): number {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index]?.text ?? "";
    if (depth === 0 && text === target) return index;
    if (text === "(" || text === "[" || text === "{") depth += 1;
    if (text === ")" || text === "]" || text === "}") depth -= 1;
  }
  return -1;
}

function isJavaScriptBindingMutation(tokens: Token[], index: number): boolean {
  if (tokens[index - 1]?.text === ".") return false;
  const after = tokens
    .slice(index + 1, index + 5)
    .map((token) => token.text)
    .join("");
  const before = tokens
    .slice(Math.max(0, index - 3), index)
    .map((token) => token.text)
    .join("");
  if (after.startsWith("++") || after.startsWith("--")) return true;
  if (before.endsWith("++") || before.endsWith("--")) return true;
  if (after.startsWith("=") && !after.startsWith("==") && !after.startsWith("=>")) {
    return true;
  }
  return [
    "+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=",
    "&=", "^=", "|=", "&&=", "||=", "??=",
  ].some((operator) => after.startsWith(operator));
}

function collectJavaScriptDeclarationNames(
  tokens: Token[],
  start: number,
  shadowed: Set<string>,
  protectedNames: ReadonlySet<string>,
): void {
  let depth = 0;
  let scanningBinding = true;
  for (let index = start; index < tokens.length; index += 1) {
    const text = tokens[index]?.text ?? "";
    if (text === ";" && depth === 0) return;
    if (text === "," && depth === 0) {
      scanningBinding = true;
      continue;
    }
    if (text === "=" && depth === 0) {
      scanningBinding = false;
      continue;
    }
    if (scanningBinding && protectedNames.has(text)) {
      shadowed.add(text);
    }
    if (text === "{" || text === "[" || text === "(") depth += 1;
    if (text === "}" || text === "]" || text === ")") depth -= 1;
  }
}

function collectProtectedNames(
  tokens: Token[],
  start: number,
  end: number,
  result: Set<string>,
  protectedNames: ReadonlySet<string>,
): void {
  for (let index = start; index < end; index += 1) {
    const text = tokens[index]?.text ?? "";
    if (protectedNames.has(text)) result.add(text);
  }
}

function inspectPythonBindingStates(tokens: Token[]): PythonBindingStates | null {
  const result: PythonBindingStates = {
    path: Array<boolean>(tokens.length).fill(false),
    open: Array<boolean>(tokens.length).fill(true),
    pathBindings: new Map<string, PythonPathBindingEvent[]>(),
  };
  let state: PythonBindingState = { path: false, open: true };
  for (let index = 0; index < tokens.length; index += 1) {
    result.path[index] = state.path;
    result.open[index] = state.open;
    if (tokens[index]?.text === "import") {
      const parsed = inspectPlainPythonImport(
        tokens,
        index + 1,
        state,
        result.pathBindings,
        index,
      );
      state = parsed.state;
      index = parsed.nextIndex;
      continue;
    }
    if (tokens[index]?.text !== "from") {
      continue;
    }
    const parsed = inspectFromPythonImport(
      tokens,
      index + 1,
      state,
      result.pathBindings,
      index,
    );
    if (parsed === null) return null;
    state = parsed.state;
    index = parsed.nextIndex;
  }
  collectPythonAliasMutations(tokens, result.pathBindings);
  for (const events of result.pathBindings.values()) {
    events.sort((left, right) => left.index - right.index);
  }
  return result;
}

function hasUnsupportedPythonStructure(tokens: Token[]): boolean {
  return tokens.some(
    (token) =>
      token.kind === "identifier" && PYTHON_UNSUPPORTED_STRUCTURES.has(token.text),
  );
}

function inspectFromPythonImport(
  tokens: Token[],
  start: number,
  initialState: PythonBindingState,
  pathBindings: Map<string, PythonPathBindingEvent[]>,
  eventIndex: number,
): PythonImportParse | null {
    let path = initialState.path;
    let open = initialState.open;
    const moduleParts: string[] = [];
    let importIndex = start;
    while (
      importIndex < tokens.length &&
      tokens[importIndex]?.text !== "import" &&
      tokens[importIndex]?.kind !== "newline"
    ) {
      moduleParts.push(tokens[importIndex]?.text ?? "");
      importIndex += 1;
    }
    if (tokens[importIndex]?.text !== "import") {
      return { nextIndex: importIndex, state: initialState };
    }
    const moduleName = moduleParts.join("");

    let cursor = importIndex + 1;
    let depth = 0;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      const text = token?.text ?? "";
      if (token?.kind === "newline" && depth === 0) break;
      if (text === "(") {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (text === ")") {
        depth -= 1;
        cursor += 1;
        continue;
      }
      if (text === "*") return null;
      if (token?.kind !== "identifier") {
        cursor += 1;
        continue;
      }

      const imported = text;
      let local = imported;
      let aliased = false;
      if (tokens[cursor + 1]?.text === "as") {
        local = tokens[cursor + 2]?.text ?? "";
        aliased = true;
        cursor += 3;
      } else {
        cursor += 1;
      }
      if (
        moduleName === "pathlib" &&
        imported === "Path" &&
        local === "Path" &&
        !aliased
      ) {
        path = true;
      } else if (moduleName === "pathlib" && imported === "Path" && local) {
        recordPythonPathBinding(pathBindings, local, eventIndex, "path");
      } else if (local === "Path" || local === "open") {
        if (local === "Path") path = false;
        if (local === "open") open = false;
      } else if (local) {
        recordPythonPathBinding(pathBindings, local, eventIndex, null);
      }
    }
    return { nextIndex: cursor, state: { path, open } };
}

function inspectPlainPythonImport(
  tokens: Token[],
  start: number,
  initialState: PythonBindingState,
  pathBindings: Map<string, PythonPathBindingEvent[]>,
  eventIndex: number,
): PythonImportParse {
  let path = initialState.path;
  let open = initialState.open;
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor]?.kind !== "newline") {
    if (tokens[cursor]?.kind !== "identifier") {
      cursor += 1;
      continue;
    }
    const importedRoot = tokens[cursor]?.text ?? "";
    cursor += 1;
    while (tokens[cursor]?.text === "." && tokens[cursor + 1]?.kind === "identifier") {
      cursor += 2;
    }
    let local = importedRoot;
    if (tokens[cursor]?.text === "as") {
      local = tokens[cursor + 1]?.text ?? "";
      cursor += 2;
    }
    if (local) {
      recordPythonPathBinding(
        pathBindings,
        local,
        eventIndex,
        importedRoot === "pathlib" ? "namespace" : null,
      );
    }
    if (local === "Path") {
      path = false;
    } else if (local === "open") {
      open = false;
    }
    while (
      cursor < tokens.length &&
      tokens[cursor]?.kind !== "newline" &&
      tokens[cursor]?.text !== ","
    ) {
      cursor += 1;
    }
    if (tokens[cursor]?.text === ",") cursor += 1;
  }
  return { nextIndex: cursor, state: { path, open } };
}

function recordPythonPathBinding(
  bindings: Map<string, PythonPathBindingEvent[]>,
  name: string,
  index: number,
  kind: PythonPathBindingKind | null,
): void {
  const events = bindings.get(name) ?? [];
  events.push({ index, kind });
  bindings.set(name, events);
}

function collectPythonAliasMutations(
  tokens: Token[],
  bindings: Map<string, PythonPathBindingEvent[]>,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index]?.text ?? "";
    if (!bindings.has(name) || !isPythonBindingOccurrence(tokens, index)) {
      continue;
    }
    recordPythonPathBinding(bindings, name, index, null);
  }
}

function pythonPathBindingAt(
  bindings: ReadonlyMap<string, readonly PythonPathBindingEvent[]>,
  name: string,
  index: number,
): PythonPathBindingKind | null {
  let active: PythonPathBindingKind | null = null;
  for (const event of bindings.get(name) ?? []) {
    if (event.index >= index) break;
    active = event.kind;
  }
  return active;
}

function collectPythonShadows(tokens: Token[]): Set<string> {
  const shadowed = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index]?.text;
    if (
      (text === "open" || text === "Path") &&
      tokens[index - 1]?.text !== "." &&
      isPythonBindingOccurrence(tokens, index)
    ) {
      shadowed.add(text);
    }
  }
  return shadowed;
}

function isPythonBindingOccurrence(tokens: Token[], index: number): boolean {
  const next = tokens[index + 1]?.text;
  if (next === "=" || next === ":") return true;
  if (isPythonAugmentedAssignment(tokens, index + 1)) return true;
  if (next !== "," && next !== ")" && next !== "]") return false;
  let depth = delimiterDepthThrough(tokens, index);
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor]?.kind === "newline" && depth === 0) return false;
    if (tokens[cursor]?.text === "=") return true;
    if (new Set(["(", "[", "{"]).has(tokens[cursor]?.text ?? "")) depth += 1;
    if (new Set([")", "]", "}"]).has(tokens[cursor]?.text ?? "")) depth -= 1;
  }
  return false;
}

function delimiterDepthThrough(tokens: Token[], end: number): number {
  let depth = 0;
  for (let index = 0; index <= end; index += 1) {
    if (new Set(["(", "[", "{"]).has(tokens[index]?.text ?? "")) depth += 1;
    if (new Set([")", "]", "}"]).has(tokens[index]?.text ?? "")) depth -= 1;
  }
  return depth;
}

function isPythonAugmentedAssignment(tokens: Token[], operatorIndex: number): boolean {
  const first = tokens[operatorIndex]?.text;
  const singleCharacter = new Set(["+", "-", "*", "/", "%", "@", "&", "|", "^"]);
  if (singleCharacter.has(first ?? "") && tokens[operatorIndex + 1]?.text === "=") {
    return true;
  }
  return (
    new Set(["*", "/", "<", ">"]).has(first ?? "") &&
    tokens[operatorIndex + 1]?.text === first &&
    tokens[operatorIndex + 2]?.text === "="
  );
}

function inspectPythonOpen(tokens: Token[], openIndex: number): string | null {
  const closeIndex = findMatching(tokens, openIndex);
  if (closeIndex === null) return null;
  const arguments_ = splitArguments(tokens, openIndex + 1, closeIndex);
  if (arguments_ === null || arguments_.length === 0) return null;

  let path: string | null = null;
  let mode: string | null = null;
  let sawPath = false;
  let sawMode = false;
  let sawOpener = false;
  let positionalIndex = 0;
  let sawKeyword = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? [];
    if (argument.length === 0) {
      if (index === arguments_.length - 1) continue;
      return null;
    }
    if (argument[0]?.text === "*") return null;
    if (argument[1]?.text === "=") {
      sawKeyword = true;
      if (argument[0]?.text === "opener") {
        if (sawOpener || argument.length !== 3 || argument[2]?.text !== "None") {
          return null;
        }
        sawOpener = true;
        continue;
      }
      if (argument[0]?.text === "file") {
        if (sawPath || argument.length !== 3 || argument[2]?.kind !== "string") {
          return null;
        }
        path = argument[2]?.value ?? "";
        sawPath = true;
      } else if (argument[0]?.text === "mode") {
        if (sawMode || argument.length !== 3 || argument[2]?.kind !== "string") {
          return null;
        }
        mode = argument[2]?.value ?? "";
        sawMode = true;
      }
      continue;
    }
    if (sawKeyword) return null;
    if (positionalIndex === 0) {
      if (sawPath || argument.length !== 1 || argument[0]?.kind !== "string") {
        return null;
      }
      path = argument[0]?.value ?? "";
      sawPath = true;
    } else if (positionalIndex === 1) {
      if (argument.length !== 1 || argument[0]?.kind !== "string") return null;
      mode = argument[0]?.value ?? "";
      sawMode = true;
    } else if (positionalIndex === 7) {
      if (sawOpener || argument.length !== 1 || argument[0]?.text !== "None") {
        return null;
      }
      sawOpener = true;
    } else if (positionalIndex > 7) {
      return null;
    }
    positionalIndex += 1;
  }
  if (!sawPath || path === null) return null;
  if (sawMode && (mode === null || !pythonModePermitsRead(mode))) return null;
  return path;
}

function inspectPythonPathRead(
  tokens: Token[],
  openIndex: number,
): InlineInspectionCandidate | null {
  const closePath = findMatching(tokens, openIndex);
  if (closePath === null) return null;
  const pathArguments = splitArguments(tokens, openIndex + 1, closePath);
  if (
    pathArguments === null ||
    pathArguments.length !== 1 ||
    pathArguments[0]?.length !== 1 ||
    pathArguments[0]?.[0]?.kind !== "string"
  ) {
    return null;
  }
  if (tokens[closePath + 1]?.text !== ".") return null;
  const method = tokens[closePath + 2]?.text;
  if (method !== "read_text" && method !== "read_bytes") return null;
  const methodOpen = closePath + 3;
  if (tokens[methodOpen]?.text !== "(" || findMatching(tokens, methodOpen) === null) {
    return null;
  }
  return {
    path: pathArguments[0]?.[0]?.value ?? "",
    ruleId:
      method === "read_text"
        ? "inline.python.path-read-text"
        : "inline.python.path-read-bytes",
  };
}

function pythonModePermitsRead(mode: string): boolean {
  if (mode.length === 0 || !new Set(["r", "w", "a", "x"]).has(mode[0] ?? "")) {
    return false;
  }
  const remainder = mode.slice(1);
  if (!/^[bt+]*$/u.test(remainder)) return false;
  if ((remainder.match(/b/gu)?.length ?? 0) > 1) return false;
  if ((remainder.match(/t/gu)?.length ?? 0) > 1) return false;
  if ((remainder.match(/\+/gu)?.length ?? 0) > 1) return false;
  if (remainder.includes("b") && remainder.includes("t")) return false;
  return mode.startsWith("r") || remainder.includes("+");
}

function splitArguments(
  tokens: Token[],
  start: number,
  end: number,
): Token[][] | null {
  const result: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token?.kind === "newline") continue;
    const text = token?.text ?? "";
    if (text === "(" || text === "[" || text === "{") depth += 1;
    if (text === ")" || text === "]" || text === "}") depth -= 1;
    if (depth < 0) return null;
    if (text === "," && depth === 0) {
      result.push(current);
      current = [];
    } else if (token !== undefined) {
      current.push(token);
    }
  }
  if (depth !== 0) return null;
  if (current.length > 0 || result.length > 0) result.push(current);
  return result;
}

function findMatching(tokens: Token[], openIndex: number): number | null {
  const opening = tokens[openIndex]?.text;
  const closing = opening === "(" ? ")" : opening === "[" ? "]" : opening === "{" ? "}" : null;
  if (closing === null) return null;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.text === opening) depth += 1;
    if (tokens[index]?.text === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function findOpening(tokens: Token[], closeIndex: number): number | null {
  const closing = tokens[closeIndex]?.text;
  const opening = closing === ")" ? "(" : closing === "]" ? "[" : closing === "}" ? "{" : null;
  if (opening === null) return null;
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (tokens[index]?.text === closing) depth += 1;
    if (tokens[index]?.text === opening) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function delimitersAreBalanced(tokens: Token[]): boolean {
  const stack: string[] = [];
  const closing = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
  for (const token of tokens) {
    if (closing.has(token.text)) {
      stack.push(token.text);
      continue;
    }
    if (token.text === ")" || token.text === "]" || token.text === "}") {
      const opening = stack.pop();
      if (opening === undefined || closing.get(opening) !== token.text) return false;
    }
  }
  return stack.length === 0;
}

function isSequence(tokens: Token[], start: number, values: string[]): boolean {
  return values.every((value, offset) => tokens[start + offset]?.text === value);
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/u.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char);
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end;
}
