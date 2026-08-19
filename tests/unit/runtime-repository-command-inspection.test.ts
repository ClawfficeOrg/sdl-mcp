import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  inspectCommandText,
  inspectSimpleArgv,
  inspectSimpleCommand,
  type CommandDialect,
} from "../../dist/runtime/repository-command-inspection.js";

interface ParsedCase {
  dialect: CommandDialect;
  input: string;
  command: string;
  targets: Array<["path" | "stdin" | "cwd", string]>;
  redirects?: Array<["path" | "stdin" | "cwd", string]>;
}

function targetPairs(
  targets: ReadonlyArray<{ kind: "path" | "stdin" | "cwd"; value: string }>,
): Array<["path" | "stdin" | "cwd", string]> {
  return targets.map(({ kind, value }) => [kind, value]);
}

function assertParsed(testCase: ParsedCase): void {
  const result = inspectSimpleCommand(testCase.input, testCase.dialect);
  assert.equal(result.kind, "parsed", testCase.input);
  if (result.kind !== "parsed") return;
  assert.equal(result.commands.length, 1, testCase.input);
  assert.equal(result.commands[0]?.command, testCase.command, testCase.input);
  assert.deepEqual(
    targetPairs(result.commands[0]?.targets ?? []),
    testCase.targets,
    testCase.input,
  );
  assert.deepEqual(
    targetPairs(result.commands[0]?.inputRedirections ?? []),
    testCase.redirects ?? [],
    testCase.input,
  );
}

describe("inspectSimpleCommand closed reader grammar", () => {
  const parsedCases: ParsedCase[] = [
    { dialect: "posix", input: "cat src/main.ts", command: "cat", targets: [["path", "src/main.ts"]] },
    { dialect: "posix", input: "cat -- 'a b.ts' -", command: "cat", targets: [["path", "a b.ts"], ["stdin", "-"]] },
    { dialect: "posix", input: "cat \"a\\q.txt\"", command: "cat", targets: [["path", "a\\q.txt"]] },
    { dialect: "posix", input: "more README.md", command: "more", targets: [["path", "README.md"]] },
    { dialect: "posix", input: "head -n 5", command: "head", targets: [["stdin", "-"]] },
    { dialect: "posix", input: "head --lines 2 src/main.ts", command: "head", targets: [["path", "src/main.ts"]] },
    { dialect: "posix", input: "head -", command: "head", targets: [["stdin", "-"]] },
    { dialect: "posix", input: "head -c 10 -q -v a b", command: "head", targets: [["path", "a"], ["path", "b"]] },
    { dialect: "posix", input: "tail --bytes 2 -- -odd", command: "tail", targets: [["path", "-odd"]] },
    { dialect: "posix", input: "tail --lines 2 --", command: "tail", targets: [["stdin", "-"]] },
    { dialect: "posix", input: "rg -g '*.ts' pattern src", command: "rg", targets: [["path", "src"]] },
    { dialect: "posix", input: "ripgrep -n -i -F -S -w --hidden pattern", command: "rg", targets: [["cwd", "."]] },
    { dialect: "posix", input: "rg --line-number --ignore-case --fixed-strings --smart-case --word-regexp --glob '*.ts' --type ts --type-not test --max-count 3 --after-context 1 --before-context 2 --context 4 pattern src", command: "rg", targets: [["path", "src"]] },
    { dialect: "posix", input: "rg -t ts -T test -m 3 -A 1 -B 2 -C 4 pattern -", command: "rg", targets: [["stdin", "-"]] },
    { dialect: "posix", input: "grep -n -i -F -E -w -l -- pattern src", command: "grep", targets: [["path", "src"]] },
    { dialect: "posix", input: "grep pattern", command: "grep", targets: [["stdin", "-"]] },
    { dialect: "cmd", input: "TYPE README.md", command: "type", targets: [["path", "README.md"]] },
    { dialect: "cmd", input: "more.exe \"a b.txt\"", command: "more", targets: [["path", "a b.txt"]] },
    { dialect: "cmd", input: "findstr /i /n /s /l /r /x /v pattern src\\*.ts", command: "findstr", targets: [["path", "src\\*.ts"]] },
    { dialect: "cmd", input: "findstr /c:exact README.md", command: "findstr", targets: [["path", "README.md"]] },
    { dialect: "powershell", input: "Get-Content -Raw src/main.ts", command: "get-content", targets: [["path", "src/main.ts"]] },
    { dialect: "powershell", input: "gc -ReadCount 10 -TotalCount 2 -Path a b", command: "get-content", targets: [["path", "a"], ["path", "b"]] },
    { dialect: "powershell", input: "cat -Tail 5 -Encoding utf8 -LiteralPath 'a b'", command: "get-content", targets: [["path", "a b"]] },
    { dialect: "powershell", input: "Get-Content -LiteralPath 'a''b.txt'", command: "get-content", targets: [["path", "a'b.txt"]] },
    { dialect: "powershell", input: "Get-Content '@paths'", command: "get-content", targets: [["path", "@paths"]] },
    { dialect: "powershell", input: "Get-Content `@paths", command: "get-content", targets: [["path", "@paths"]] },
    { dialect: "powershell", input: "Get-Content '(literal)'", command: "get-content", targets: [["path", "(literal)"]] },
    { dialect: "powershell", input: "Get-Content `(literal`)", command: "get-content", targets: [["path", "(literal)"]] },
    { dialect: "powershell", input: "TYPE file.txt", command: "get-content", targets: [["path", "file.txt"]] },
    { dialect: "powershell", input: "Get-Content -", command: "get-content", targets: [["stdin", "-"]] },
    { dialect: "powershell", input: "Get-Content \"a` b.txt\"", command: "get-content", targets: [["path", "a b.txt"]] },
    { dialect: "powershell", input: "Select-String -Pattern todo -Path src test", command: "select-string", targets: [["path", "src"], ["path", "test"]] },
    { dialect: "powershell", input: "select-string -LiteralPath file.txt -Pattern 'a b'", command: "select-string", targets: [["path", "file.txt"]] },
    { dialect: "posix", input: "sed -n -E -r -- 's/a/b/' src/main.ts", command: "sed", targets: [["path", "src/main.ts"]] },
    { dialect: "posix", input: "sed 's/a/b/'", command: "sed", targets: [["stdin", "-"]] },
    { dialect: "posix", input: "awk '{print $1}' data.txt", command: "awk", targets: [["path", "data.txt"]] },
    { dialect: "cmd", input: "rg.exe pattern .", command: "rg", targets: [["path", "."]] },
    { dialect: "powershell", input: "C:\\Tools\\RG.EXE pattern file", command: "rg", targets: [["path", "file"]] },
    { dialect: "posix", input: "cat < input.txt", command: "cat", targets: [["stdin", "-"]], redirects: [["path", "input.txt"]] },
    { dialect: "posix", input: "grep pattern 0<\"input file\"", command: "grep", targets: [["stdin", "-"]], redirects: [["path", "input file"]] },
  ];

  for (const testCase of parsedCases) {
    it(`parses ${testCase.dialect}: ${testCase.input}`, () => assertParsed(testCase));
  }

  const ambiguousCases: Array<[CommandDialect, string]> = [
    ["posix", "cat --unknown file"],
    ["posix", "head -n"],
    ["posix", "head -n nope file"],
    ["posix", "head -5 file"],
    ["posix", "tail -nv file"],
    ["posix", "rg -g pattern"],
    ["posix", "rg --glob=*.ts pattern"],
    ["posix", "rg -g -n pattern file"],
    ["posix", "rg -m nope pattern file"],
    ["posix", "rg --context -i pattern file"],
    ["posix", "rg pattern --json"],
    ["posix", "grep -ni pattern file"],
    ["posix", "grep pattern --binary-files=text"],
    ["posix", "grep"],
    ["cmd", "findstr /z pattern file"],
    ["cmd", "findstr /c:one /c:two file"],
    ["cmd", "findstr pattern /z"],
    ["cmd", "type /?"],
    ["cmd", "more /unknown"],
    ["powershell", "Get-Content -Unknown file"],
    ["powershell", "Get-Content -Path a,b"],
    ["powershell", "Get-Content @paths"],
    ["powershell", "Select-String -Pattern todo -Path @paths"],
    ["powershell", "Get-Content (Get-PathExpression)"],
    ["powershell", "Get-Content -ReadCount nope file"],
    ["powershell", "Get-Content -TotalCount -Raw file"],
    ["powershell", "Get-Content -Tail missing file"],
    ["powershell", "Get-Content -Encoding -Raw file"],
    ["powershell", "Get-Content -Path a -LiteralPath b"],
    ["powershell", "Get-Content positional -Path named"],
    ["powershell", "Select-String pattern file"],
    ["powershell", "Select-String -Pattern"],
    ["powershell", "Select-String -Pattern -Path file"],
    ["powershell", "Select-String -Pattern -x"],
    ["posix", "sed -i s/a/b/ file"],
    ["posix", "sed s/a/b/ -i"],
    ["posix", "sed"],
    ["posix", "awk -F, '{print $1}' file"],
    ["posix", "awk '{print $1}' -F"],
    ["posix", "awk"],
    ["posix", "cat \"unterminated"],
    ["cmd", "type %FILE%"],
    ["cmd", "type (file.txt)"],
    ["powershell", "Get-Content $(Get-Item x)"],
    ["powershell", "Get-Content { $_.Name }"],
    ["posix", "cat $(printf file)"],
    ["posix", "cat `printf file`"],
    ["posix", "cat {safe.txt,../outside.txt}"],
    ["posix", "cat ~/safe.txt"],
    ["powershell", "Get-Content ~/safe.txt"],
    ["posix", "cat <(printf safe.txt)"],
    ["posix", "cat >(tee output.txt)"],
    ["posix", "cat > output.txt"],
    ["posix", "cat <<EOF"],
    ["powershell", "& $reader file"],
  ];

  for (const [dialect, input] of ambiguousCases) {
    it(`allows ambiguous ${dialect} syntax: ${input}`, () => {
      assert.equal(inspectSimpleCommand(input, dialect).kind, "ambiguous");
    });
  }

  const unrecognizedCases: Array<[CommandDialect, string]> = [
    ["posix", "type package.json"],
    ["posix", "rg.exe pattern src"],
    ["posix", "echo src/main.ts"],
    ["cmd", "cat file.txt"],
    ["cmd", "npx rg pattern src"],
    ["powershell", "npm exec rg pattern src"],
  ];

  for (const [dialect, input] of unrecognizedCases) {
    it(`does not recognize ${dialect}: ${input}`, () => {
      assert.equal(inspectSimpleCommand(input, dialect).kind, "notRecognized");
    });
  }

  it("uses stdin or cwd for every grammar without an explicit path", () => {
    const cases: ParsedCase[] = [
      { dialect: "posix", input: "cat", command: "cat", targets: [["stdin", "-"]] },
      { dialect: "posix", input: "more", command: "more", targets: [["stdin", "-"]] },
      { dialect: "posix", input: "head", command: "head", targets: [["stdin", "-"]] },
      { dialect: "posix", input: "tail", command: "tail", targets: [["stdin", "-"]] },
      { dialect: "posix", input: "rg pattern", command: "rg", targets: [["cwd", "."]] },
      { dialect: "posix", input: "grep pattern", command: "grep", targets: [["stdin", "-"]] },
      { dialect: "cmd", input: "type", command: "type", targets: [["stdin", "-"]] },
      { dialect: "cmd", input: "more", command: "more", targets: [["stdin", "-"]] },
      { dialect: "cmd", input: "findstr pattern", command: "findstr", targets: [["stdin", "-"]] },
      { dialect: "cmd", input: "findstr /c:pattern", command: "findstr", targets: [["stdin", "-"]] },
      { dialect: "powershell", input: "Get-Content", command: "get-content", targets: [["stdin", "-"]] },
      { dialect: "powershell", input: "Select-String -Pattern value", command: "select-string", targets: [["stdin", "-"]] },
      { dialect: "posix", input: "sed program", command: "sed", targets: [["stdin", "-"]] },
      { dialect: "posix", input: "awk program", command: "awk", targets: [["stdin", "-"]] },
    ];
    for (const testCase of cases) assertParsed(testCase);
  });
});

describe("inspectSimpleCommand single-command boundary", () => {
  const compoundCases: Array<[CommandDialect, string]> = [
    ["posix", "cat safe.txt; rm safe.txt"],
    ["cmd", "type safe.txt & del safe.txt"],
    ["powershell", "Get-Content safe.txt; Remove-Item safe.txt"],
  ];

  for (const [dialect, input] of compoundCases) {
    it(`rejects compound ${dialect} text: ${input}`, () => {
      assert.equal(inspectSimpleCommand(input, dialect).kind, "ambiguous");
    });
  }

  const incompleteCompoundCases: Array<[CommandDialect, string]> = [
    ["posix", "cat safe.txt |"],
    ["posix", "| cat safe.txt"],
    ["posix", "cat safe.txt &&"],
    ["posix", "cat safe.txt ||"],
    ["posix", "cat safe.txt;"],
    ["posix", "& cat safe.txt"],
    ["posix", "cat safe.txt\n"],
    ["cmd", "type safe.txt &"],
    ["cmd", "&& type safe.txt"],
    ["cmd", "type safe.txt ||"],
    ["cmd", "type safe.txt |"],
    ["powershell", "Get-Content safe.txt;"],
    ["powershell", "| Get-Content safe.txt"],
    ["powershell", "Get-Content safe.txt &&"],
    ["powershell", "Get-Content safe.txt ||"],
  ];

  for (const [dialect, input] of incompleteCompoundCases) {
    it(`rejects incomplete ${dialect} compound syntax: ${JSON.stringify(input)}`, () => {
      assert.equal(inspectSimpleCommand(input, dialect).kind, "ambiguous");
    });
  }

  it("keeps quoted separators inside one simple command", () => {
    assertParsed({
      dialect: "posix",
      input: "cat 'safe;name.txt'",
      command: "cat",
      targets: [["path", "safe;name.txt"]],
    });
  });
});

describe("inspectSimpleArgv literal argument boundary", () => {
  it("keeps Windows environment-looking rg operands as literal targets", () => {
    const result = inspectSimpleArgv(
      ["rg.exe", "needle", "..\\README.md", "%FILE%", "!FILE!"],
      "cmd",
    );
    assert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    assert.deepEqual(targetPairs(result.commands[0]?.targets ?? []), [
      ["path", "..\\README.md"],
      ["path", "%FILE%"],
      ["path", "!FILE!"],
    ]);
  });

  it("keeps separator and redirection characters inside one literal path token", () => {
    const result = inspectSimpleArgv(["cat", "dir/a;&|<b.txt"], "posix");
    assert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    assert.deepEqual(targetPairs(result.commands[0]?.targets ?? []), [
      ["path", "dir/a;&|<b.txt"],
    ]);
    assert.deepEqual(result.commands[0]?.inputRedirections, []);
  });

  it("keeps named package scripts opaque", () => {
    assert.equal(inspectSimpleArgv(["npm", "test", "%FILE%"], "cmd").kind, "notRecognized");
    assert.equal(inspectSimpleArgv(["pnpm", "run", "unit", "a|b"], "posix").kind, "notRecognized");
  });

  it("unwraps only the outer cmd command-string quote pair", () => {
    assert.deepEqual(
      inspectSimpleArgv(["cmd.exe", "/c", '"type README.md"'], "cmd"),
      {
        kind: "parsed",
        commands: [
          {
            command: "type",
            inputRedirections: [],
            targets: [{ kind: "path", value: "README.md" }],
          },
        ],
      },
    );
    assert.deepEqual(
      inspectSimpleArgv(
        ["cmd.exe", "/c", '"type "C:\\Outside Dir\\file.txt""'],
        "cmd",
      ),
      {
        kind: "parsed",
        commands: [
          {
            command: "type",
            inputRedirections: [],
            targets: [{ kind: "path", value: "C:\\Outside Dir\\file.txt" }],
          },
        ],
      },
    );
  });

  it("treats a PowerShell call operator as a literal argv executable", () => {
    assert.equal(
      inspectSimpleArgv(["&", "Get-Content", "safe.txt"], "powershell").kind,
      "notRecognized",
    );
  });

  it("enforces argv token count and token length bounds", () => {
    const tooMany = ["cat", ...Array.from({ length: 256 }, (_, index) => `p${index}`)];
    assert.equal(inspectSimpleArgv(tooMany, "posix").kind, "ambiguous");
    assert.equal(
      inspectSimpleArgv(["cat", "a".repeat(8_193)], "posix").kind,
      "ambiguous",
    );
  });
});

describe("inspectCommandText scanning and wrappers", () => {
  it("parses all POSIX segments and respects quoted or escaped separators", () => {
    const result = inspectCommandText(
      "echo ok; cat 'a;b'; grep pattern a\\|b && rg pattern src | tail -n 2",
      "posix",
    );
    assert.equal(result.kind, "parsed");
    assert.deepEqual(
      result.commands.map(({ command, targets }) => [command, targetPairs(targets)]),
      [
        ["cat", [["path", "a;b"]]],
        ["grep", [["path", "a|b"]]],
        ["rg", [["path", "src"]]],
        ["tail", [["stdin", "-"]]],
      ],
    );
  });

  it("uses cmd separators and caret escaping", () => {
    const result = inspectCommandText("echo ok & type a^&b && more c || findstr x d | type e", "cmd");
    assert.equal(result.kind, "parsed");
    assert.deepEqual(result.commands.map(({ command }) => command), ["type", "more", "findstr", "type"]);
    assert.deepEqual(targetPairs(result.commands[0]?.targets ?? []), [["path", "a&b"]]);
  });

  it("does not split PowerShell's standalone call operator", () => {
    const result = inspectCommandText("& Get-Content a; gc b && type c || cat d | Select-String -Pattern x -Path e", "powershell");
    assert.equal(result.kind, "parsed");
    assert.deepEqual(result.commands.map(({ command }) => command), ["get-content", "get-content", "get-content", "get-content", "select-string"]);
  });

  it("normalizes recognized wrappers through depth two", () => {
    const cases: Array<[CommandDialect, string, string[]]> = [
      ["posix", "sh -c \"cat a; rg p b\"", ["cat", "rg"]],
      ["posix", "bash -c \"cat a\"", ["cat"]],
      ["cmd", "cmd.exe /c \"type a & findstr p b\"", ["type", "findstr"]],
      ["cmd", "cmd /C \"type a\"", ["type"]],
      ["powershell", "powershell -Command \"Get-Content a\"", ["get-content"]],
      ["powershell", "powershell.exe -Command \"Get-Content a\"", ["get-content"]],
      ["powershell", "pwsh -Command \"Get-Content a\"", ["get-content"]],
      ["powershell", "pwsh.exe -Command \"Get-Content a; gc b\"", ["get-content", "get-content"]],
      ["posix", "pwsh -Command \"Get-Content a\"", ["get-content"]],
      ["posix", "sh -c \"cmd /c \\\"type a\\\"\"", ["type"]],
    ];
    for (const [dialect, input, commands] of cases) {
      const result = inspectCommandText(input, dialect);
      assert.equal(result.kind, "parsed", input);
      assert.deepEqual(result.commands.map(({ command }) => command), commands, input);
    }
  });

  it("allows wrapper depth greater than two as ambiguous", () => {
    assert.equal(
      inspectCommandText("sh -c \"sh -c 'sh -c \\\"cat a\\\"'\"", "posix").kind,
      "ambiguous",
    );
  });

  it("treats named package scripts as opaque including redirects", () => {
    for (const input of [
      "npm test < secret.txt",
      "npm run unit < secret.txt",
      "pnpm test < secret.txt",
      "pnpm run unit < secret.txt",
      "yarn test < secret.txt",
      "yarn run unit < secret.txt",
      "bun test < secret.txt",
      "bun run unit < secret.txt",
    ]) {
      assert.equal(inspectSimpleCommand(input, "posix").kind, "notRecognized", input);
    }
  });

  it("preserves a parsed reader from a later segment", () => {
    const result = inspectCommandText("unknown first; cat src/main.ts", "posix");
    assert.equal(result.kind, "parsed");
    assert.deepEqual(result.commands.map(({ command }) => command), ["cat"]);
  });

  it("does not suppress an ambiguous segment when another segment parses", () => {
    const result = inspectCommandText("cat safe; cat $FILE", "posix");
    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.commands.map(({ command }) => command), ["cat"]);
    assert.deepEqual(targetPairs(result.commands[0]?.targets ?? []), [["path", "safe"]]);
  });

  it("splits newlines in every dialect", () => {
    const cases: Array<[CommandDialect, string, string[]]> = [
      ["posix", "cat a\nhead b", ["cat", "head"]],
      ["cmd", "type a\r\nmore b", ["type", "more"]],
      ["powershell", "gc a\ncat b", ["get-content", "get-content"]],
    ];
    for (const [dialect, input, commands] of cases) {
      assert.deepEqual(
        inspectCommandText(input, dialect).commands.map(({ command }) => command),
        commands,
      );
    }
  });

  it("enforces every scanner bound as ambiguous", () => {
    const cases = [
      `cat ${"a".repeat(40_000)}`,
      Array.from({ length: 65 }, () => "echo x").join(";"),
      `cat ${Array.from({ length: 256 }, (_, index) => `p${index}`).join(" ")}`,
      `cat ${"a".repeat(8_193)}`,
    ];
    for (const input of cases) {
      assert.equal(inspectCommandText(input, "posix").kind, "ambiguous", input.slice(0, 80));
    }
  });
});

describe("runtime repository-inspection wrapper regressions", () => {
  it("unwraps closed PowerShell and cmd switch prefixes", () => {
    const cases: Array<[readonly string[], CommandDialect, string]> = [
      [
        ["powershell", "-NoProfile", "-Command", "Get-Content -LiteralPath package.json"],
        "powershell",
        "get-content",
      ],
      [
        ["pwsh", "-NoProfile", "-Command", "Get-Content -LiteralPath package.json"],
        "powershell",
        "get-content",
      ],
      [
        ["cmd.exe", "/d", "/s", "/c", "type package.json"],
        "cmd",
        "type",
      ],
      [
        ["cmd.exe", "/d", "/s", "/c", '"type package.json"'],
        "cmd",
        "type",
      ],
    ];

    for (const [argv, dialect, command] of cases) {
      const result = inspectSimpleArgv(argv, dialect);
      assert.equal(result.kind, "parsed", argv.join(" "));
      assert.deepEqual(result.commands.map((item) => item.command), [command]);
    }
  });

  it("keeps unknown or misplaced wrapper switches ambiguous", () => {
    const cases: Array<[readonly string[], CommandDialect]> = [
      [["pwsh", "-Unknown", "-Command", "Get-Content package.json"], "powershell"],
      [["pwsh", "-Command", "-NoProfile", "Get-Content package.json"], "powershell"],
      [["cmd.exe", "/u", "/c", "type package.json"], "cmd"],
      [["cmd.exe", "/c", "/d", "type package.json"], "cmd"],
    ];

    for (const [argv, dialect] of cases) {
      assert.equal(inspectSimpleArgv(argv, dialect).kind, "ambiguous", argv.join(" "));
    }
  });

  it("uses existing GNU grammars for static cmd payloads", () => {
    const cases: Array<[string, string]> = [
      ["grep -n needle package.json", "grep"],
      ['sed -n "1p" package.json', "sed"],
      ['awk "{print $1}" package.json', "awk"],
    ];

    for (const [input, command] of cases) {
      const result = inspectSimpleCommand(input, "cmd");
      assert.equal(result.kind, "parsed", input);
      assert.deepEqual(result.commands.map((item) => item.command), [command]);
    }
  });
});
