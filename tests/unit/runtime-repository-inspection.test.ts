import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  classifyRuntimeRepositoryInspection,
  type RuntimeRepositoryInspectionRequest,
} from "../../dist/runtime/repository-inspection.js";

const ALLOW = { decision: "allow" } as const;

type RuntimeRepositoryInspectionTestOverrides =
  Partial<RuntimeRepositoryInspectionRequest> & { relativeCwd?: string };

function request(
  overrides: RuntimeRepositoryInspectionTestOverrides = {},
): RuntimeRepositoryInspectionRequest {
  const repoRoot = overrides.repoRoot ?? "/repo";
  const pathApi =
    overrides.platform === "win32" || /^[A-Za-z]:[\\/]/u.test(repoRoot)
      ? path.win32
      : path.posix;
  const cwd =
    overrides.cwd ??
    pathApi.resolve(repoRoot, overrides.relativeCwd ?? "packages/app");
  const { relativeCwd: _relativeCwd, ...requestOverrides } = overrides;
  return {
    repoRoot,
    cwd,
    runtime: "shell",
    executable: "cat",
    args: ["src/index.ts"],
    platform: "linux",
    ...requestOverrides,
  };
}

function deny(
  category:
    | "directReader"
    | "repositorySearch"
    | "inlineStaticRead"
    | "inputRedirection",
  ruleId: string,
) {
  return { decision: "deny", category, ruleId } as const;
}

describe("classifyRuntimeRepositoryInspection path containment", () => {
  it("resolves relative targets from the canonical execution cwd", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          repoRoot: "/repo",
          relativeCwd: "alias",
          cwd: "/repo/packages/app",
          args: ["../../README.md"],
        }),
      ),
      deny("directReader", "command.direct-reader.cat"),
    );
  });

  const deniedCases: Array<{
    name: string;
    input: Partial<RuntimeRepositoryInspectionRequest>;
    expected: ReturnType<typeof deny>;
  }> = [
    {
      name: "repository-relative reader target",
      input: {},
      expected: deny("directReader", "command.direct-reader.cat"),
    },
    {
      name: "normalized dot segments that remain inside",
      input: {
        relativeCwd: "packages/app/src",
        args: ["../../shared/../app/file.ts"],
      },
      expected: deny("directReader", "command.direct-reader.cat"),
    },
    {
      name: "nonexistent repository-relative path",
      input: { args: ["not-created/yet.ts"] },
      expected: deny("directReader", "command.direct-reader.cat"),
    },
    {
      name: "relative repository glob",
      input: { executable: "rg", args: ["needle", "../../src/**/*.ts"] },
      expected: deny("repositorySearch", "command.repository-search.rg"),
    },
    {
      name: "absolute repository glob",
      input: { executable: "rg", args: ["needle", "/repo/src/*.ts"] },
      expected: deny("repositorySearch", "command.repository-search.rg"),
    },
    {
      name: "rg implicit cwd target",
      input: { executable: "rg", args: ["needle"] },
      expected: deny("repositorySearch", "command.repository-search.rg"),
    },
    {
      name: "Windows case-insensitive repository path",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: "src",
        platform: "win32",
        executable: "type",
        args: ["c:\\work\\REPO\\README.md"],
      },
      expected: deny("directReader", "command.direct-reader.type"),
    },
    {
      name: "Windows device path alias into the repository",
      input: {
        repoRoot: "F:\\Claude\\projects\\sdl-mcp\\sdl-mcp",
        cwd: "F:\\Claude\\projects\\sdl-mcp\\sdl-mcp",
        platform: "win32",
        executable: "type",
        args: ["\\\\?\\F:\\Claude\\projects\\sdl-mcp\\sdl-mcp\\package.json"],
      },
      expected: deny("directReader", "command.direct-reader.type"),
    },
    {
      name: "absolute target beneath the registered lexical root alias",
      input: {
        repoRoot: "C:\\Real\\Repo",
        registeredRepoRoot: "C:\\Registered\\Repo",
        cwd: "C:\\Real\\Repo",
        platform: "win32",
        executable: "type",
        args: ["C:\\Registered\\Repo\\README.md"],
      },
      expected: deny("directReader", "command.direct-reader.type"),
    },
    {
      name: "POSIX filesystem root repository",
      input: { repoRoot: "/", relativeCwd: "work", args: ["file.ts"] },
      expected: deny("directReader", "command.direct-reader.cat"),
    },
    {
      name: "Windows drive root repository",
      input: {
        repoRoot: "C:\\",
        relativeCwd: "work",
        platform: "win32",
        executable: "type",
        args: ["file.txt"],
      },
      expected: deny("directReader", "command.direct-reader.type"),
    },
  ];

  for (const testCase of deniedCases) {
    it(`denies ${testCase.name}`, () => {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(testCase.input)),
        testCase.expected,
      );
    });
  }

  const allowedCases: Array<{
    name: string;
    input: Partial<RuntimeRepositoryInspectionRequest>;
  }> = [
    {
      name: "static absolute path outside the repository",
      input: { args: ["/other/file.ts"] },
    },
    {
      name: "relative path resolving outside the repository",
      input: { args: ["../../../other/file.ts"] },
    },
    {
      name: "absolute glob outside the repository",
      input: { executable: "rg", args: ["needle", "/other/**/*.ts"] },
    },
    {
      name: "Windows path on another drive",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: ".",
        platform: "win32",
        executable: "type",
        args: ["D:\\other\\file.txt"],
      },
    },
    {
      name: "Windows drive-relative target",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: ".",
        platform: "win32",
        executable: "type",
        args: ["C:README.md"],
      },
    },
    {
      name: "bare Windows drive-relative target",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: ".",
        platform: "win32",
        executable: "type",
        args: ["C:"],
      },
    },
    {
      name: "uncertain Windows UNC target",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: ".",
        platform: "win32",
        executable: "type",
        args: ["\\\\server\\share\\file.txt"],
      },
    },
  ];

  for (const testCase of allowedCases) {
    it(`allows ${testCase.name}`, () => {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(testCase.input)),
        ALLOW,
      );
    });
  }
});

describe("classifyRuntimeRepositoryInspection commands and wrappers", () => {
  const cases: Array<{
    name: string;
    input: Partial<RuntimeRepositoryInspectionRequest>;
    expected: ReturnType<typeof deny>;
  }> = [
    {
      name: "direct repository search",
      input: { executable: "grep", args: ["needle", "../../src"] },
      expected: deny("repositorySearch", "command.repository-search.grep"),
    },
    {
      name: "POSIX wrapper",
      input: { executable: "sh", args: ["-c", "echo ok; cat ../../README.md"] },
      expected: deny("directReader", "command.direct-reader.cat"),
    },
    {
      name: "cmd wrapper",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: "src",
        platform: "win32",
        executable: "cmd.exe",
        args: ["/c", "echo ok & findstr needle ..\\README.md"],
      },
      expected: deny("repositorySearch", "command.repository-search.findstr"),
    },
    {
      name: "mixed clear wrapper segments",
      input: {
        executable: "bash",
        args: ["-c", "cat /other/file; rg needle ../../src"],
      },
      expected: deny("repositorySearch", "command.repository-search.rg"),
    },
    {
      name: "PowerShell wrapper",
      input: {
        runtime: "powershell",
        executable: "pwsh",
        args: ["-Command", "Get-Content '../../file with spaces.txt'"],
      },
      expected: deny("directReader", "command.direct-reader.get-content"),
    },
  ];

  for (const testCase of cases) {
    it(`denies ${testCase.name}`, () => {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(testCase.input)),
        testCase.expected,
      );
    });
  }

  it("treats Windows direct-spawn argv metacharacters as literal", () => {
    for (const literalArg of ["%FILE%", "!FILE!", "a&b", "|", "<", ">"]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            repoRoot: "C:\\Work\\Repo",
            relativeCwd: "src",
            platform: "win32",
            executable: "rg.exe",
            args: ["needle", "..\\README.md", literalArg],
          }),
        ),
        deny("repositorySearch", "command.repository-search.rg"),
        literalArg,
      );
    }
  });

  it("does not reinterpret a literal direct-spawn redirect argument", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          repoRoot: "C:\\Work\\Repo",
          relativeCwd: "src",
          platform: "win32",
          executable: "type",
          args: ["..\\README.md", "<", "outside.txt"],
        }),
      ),
      deny("directReader", "command.direct-reader.type"),
    );
  });

  it("preserves cmd text expansion semantics inside a wrapper payload", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          repoRoot: "C:\\Work\\Repo",
          relativeCwd: "src",
          platform: "win32",
          executable: "cmd.exe",
          args: ["/c", "rg needle ..\\README.md & type %FILE%"],
        }),
      ),
      ALLOW,
    );
  });

  it("preserves embedded quotes in a direct cmd wrapper payload", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          repoRoot: "C:\\Work\\Repo",
          relativeCwd: ".",
          platform: "win32",
          runtime: "shell",
          executable: "cmd.exe",
          args: ["/c", `type "C:\\Outside Dir\\file.txt"`],
        }),
      ),
      ALLOW,
    );
  });

  it("denies a repository read in an outer-quoted cmd command string", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          repoRoot: "C:\\Work\\Repo",
          relativeCwd: ".",
          platform: "win32",
          runtime: "shell",
          executable: "cmd.exe",
          args: ["/c", '"type README.md"'],
        }),
      ),
      deny("directReader", "command.direct-reader.type"),
    );
  });

  it("denies closed wrapper options and GNU readers inside cmd", () => {
    const cases: Array<{
      input: Partial<RuntimeRepositoryInspectionRequest>;
      expected: ReturnType<typeof deny>;
    }> = [
      {
        input: {
          repoRoot: "C:\\Work\\Repo",
          cwd: "C:\\Work\\Repo",
          platform: "win32",
          runtime: "powershell",
          executable: "powershell",
          args: ["-NoProfile", "-Command", "Get-Content -LiteralPath package.json"],
        },
        expected: deny("directReader", "command.direct-reader.get-content"),
      },
      {
        input: {
          repoRoot: "C:\\Work\\Repo",
          cwd: "C:\\Work\\Repo",
          platform: "win32",
          executable: "cmd.exe",
          args: ["/d", "/s", "/c", '"type package.json"'],
        },
        expected: deny("directReader", "command.direct-reader.type"),
      },
      ...["grep", "sed", "awk"].map((command) => ({
        input: {
          repoRoot: "C:\\Work\\Repo",
          cwd: "C:\\Work\\Repo",
          platform: "win32" as const,
          executable: "cmd.exe",
          args: ["/d", "/s", "/c", `${command} needle package.json`],
        },
        expected: deny("repositorySearch", `command.repository-search.${command}`),
      })),
    ];

    for (const testCase of cases) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(testCase.input)),
        testCase.expected,
      );
    }
  });
});

describe("classifyRuntimeRepositoryInspection inline invocation modes", () => {
  it("denies CommonJS require reads from Node eval source", () => {
    const source = `require("node:fs").readFileSync("../../README.md")`;

    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "node",
          executable: "node",
          args: ["-e", source],
        }),
      ),
      deny("inlineStaticRead", "inline.javascript.fs-read-file-sync"),
    );
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "node",
          executable: "node",
          args: ["--input-type=commonjs", "--eval", source],
        }),
      ),
      deny("inlineStaticRead", "inline.javascript.fs-read-file-sync"),
    );
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "node",
          executable: "node",
          args: ["--input-type=module", "--eval", source],
        }),
      ),
      ALLOW,
    );
  });

  it("denies Python open reads that use the file keyword", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "python",
          executable: "python",
          args: ["-c", `open(mode="r", file="../../README.md")`],
        }),
      ),
      deny("inlineStaticRead", "inline.python.open"),
    );
  });
});

describe("classifyRuntimeRepositoryInspection inline source modes", () => {
  const cases: Array<{
    name: string;
    input: Partial<RuntimeRepositoryInspectionRequest>;
    ruleId: string;
  }> = [
    {
      name: "Node code",
      input: {
        runtime: "node",
        executable: "node",
        args: [],
        code: `import fs from "node:fs"; fs.readFileSync("../../README.md");`,
      },
      ruleId: "inline.javascript.fs-read-file-sync",
    },
    {
      name: "TypeScript code through the JavaScript recognizer",
      input: {
        runtime: "typescript",
        executable: "tsx",
        args: [],
        code: `import { readFileSync } from "fs"; readFileSync("../../tsconfig.json");`,
      },
      ruleId: "inline.javascript.imported-read-file-sync",
    },
    {
      name: "Python code",
      input: {
        runtime: "python",
        executable: "python3",
        args: [],
        code: `open("../../README.md").read()`,
      },
      ruleId: "inline.python.open",
    },
    {
      name: "POSIX shell code on Unix",
      input: {
        runtime: "shell",
        executable: "bash",
        args: [],
        code: "head ../../README.md",
      },
      ruleId: "command.direct-reader.head",
    },
    {
      name: "cmd code on Windows",
      input: {
        repoRoot: "C:\\Work\\Repo",
        relativeCwd: "src",
        platform: "win32",
        runtime: "shell",
        executable: "cmd.exe",
        args: [],
        code: "type ..\\README.md",
      },
      ruleId: "command.direct-reader.type",
    },
    {
      name: "PowerShell code",
      input: {
        runtime: "powershell",
        executable: "pwsh",
        args: [],
        code: "Get-Content ../../README.md",
      },
      ruleId: "command.direct-reader.get-content",
    },
    {
      name: "Node -e source",
      input: {
        runtime: "node",
        executable: "node",
        args: [
          "-e",
          `import fs from "node:fs"; fs.readFileSync("../../README.md")`,
        ],
      },
      ruleId: "inline.javascript.fs-read-file-sync",
    },
    {
      name: "Node --print source",
      input: {
        runtime: "node",
        executable: "node",
        args: [
          "--print",
          `import fs from "node:fs"; fs.readFileSync("../../README.md")`,
        ],
      },
      ruleId: "inline.javascript.fs-read-file-sync",
    },
    {
      name: "Node -p source",
      input: {
        runtime: "node",
        executable: "node",
        args: [
          "-p",
          `import fs from "node:fs"; fs.readFileSync("../../README.md")`,
        ],
      },
      ruleId: "inline.javascript.fs-read-file-sync",
    },
    {
      name: "Node --eval source",
      input: {
        runtime: "node",
        executable: "node",
        args: [
          "--eval",
          `import fs from "node:fs"; fs.readFileSync("../../README.md")`,
        ],
      },
      ruleId: "inline.javascript.fs-read-file-sync",
    },
    {
      name: "Python -c source",
      input: {
        runtime: "python",
        executable: "python3",
        args: ["-c", `open("../../README.md").read()`],
      },
      ruleId: "inline.python.open",
    },
  ];

  for (const testCase of cases) {
    it(`denies ${testCase.name}`, () => {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(testCase.input)),
        deny(
          testCase.ruleId.startsWith("inline.")
            ? "inlineStaticRead"
            : "directReader",
          testCase.ruleId,
        ),
      );
    });
  }

  it("treats Node stdin as source with an explicit dash or no script", () => {
    const stdin = `import fs from "node:fs"; fs.readFileSync("../../README.md")`;
    for (const args of [["-"], [], ["--input-type", "module"]]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "node",
            executable: "node",
            args,
            stdin,
          }),
        ),
        deny("inlineStaticRead", "inline.javascript.fs-read-file-sync"),
      );
    }
  });

  it("treats Python stdin as source with an explicit dash or no script", () => {
    for (const args of [["-"], []]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "python",
            executable: "python3",
            args,
            stdin: `open("../../README.md").read()`,
          }),
        ),
        deny("inlineStaticRead", "inline.python.open"),
      );
    }
  });

  it("treats stdin as data when Node -e or Python -c supplies the source", () => {
    const cases: Array<Partial<RuntimeRepositoryInspectionRequest>> = [
      {
        runtime: "node",
        executable: "node",
        args: ["-e", "console.log('ok')"],
        stdin: `import fs from "node:fs"; fs.readFileSync("../../README.md")`,
      },
      {
        runtime: "python",
        executable: "python3",
        args: ["-c", "print('ok')"],
        stdin: `open("../../README.md").read()`,
      },
    ];
    for (const input of cases) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(input)),
        ALLOW,
      );
    }
  });

  it("recognizes attached Node source forms", () => {
    const source = `import fs from "node:fs"; fs.readFileSync("../../README.md")`;
    for (const argument of [
      `--eval=${source}`,
      `--print=${source}`,
      `-e${source}`,
      `-p${source}`,
    ]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "node",
            executable: "node",
            args: [argument],
          }),
        ),
        deny("inlineStaticRead", "inline.javascript.fs-read-file-sync"),
        argument.slice(0, 12),
      );
    }
  });

  it("recognizes attached Python command source", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "python",
          executable: "python3",
          args: [`-copen("../../README.md").read()`],
        }),
      ),
      deny("inlineStaticRead", "inline.python.open"),
    );
  });

  it("treats stdin as data for attached source forms including empty source", () => {
    const dangerousJavaScript = `import fs from "node:fs"; fs.readFileSync("../../README.md")`;
    const dangerousPython = `open("../../README.md").read()`;
    const cases: Array<Partial<RuntimeRepositoryInspectionRequest>> = [
      {
        runtime: "node",
        executable: "node",
        args: ["--eval="],
        stdin: dangerousJavaScript,
      },
      {
        runtime: "node",
        executable: "node",
        args: ["--print="],
        stdin: dangerousJavaScript,
      },
      {
        runtime: "node",
        executable: "node",
        args: ["-e", ""],
        stdin: dangerousJavaScript,
      },
      {
        runtime: "python",
        executable: "python3",
        args: ["-c", ""],
        stdin: dangerousPython,
      },
    ];
    for (const input of cases) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(input)),
        ALLOW,
      );
    }
  });
});

describe("classifyRuntimeRepositoryInspection conservative allows", () => {
  const cases: Array<{
    name: string;
    input: Partial<RuntimeRepositoryInspectionRequest>;
  }> = [
    {
      name: "unknown runtime",
      input: {
        runtime: "ruby",
        executable: "ruby",
        args: ["-e", "File.read('README.md')"],
      },
    },
    {
      name: "unknown direct tool",
      input: { executable: "git", args: ["status"] },
    },
    {
      name: "Node script file",
      input: { runtime: "node", executable: "node", args: ["script.mjs"] },
    },
    {
      name: "Node script arguments that resemble eval",
      input: {
        runtime: "node",
        executable: "node",
        args: [
          "script.mjs",
          "-e",
          `import fs from "node:fs"; fs.readFileSync("../../README.md")`,
        ],
      },
    },
    {
      name: "Node script arguments that resemble attached eval",
      input: {
        runtime: "node",
        executable: "node",
        args: [
          "script.mjs",
          `--eval=import fs from "node:fs"; fs.readFileSync("../../README.md")`,
        ],
      },
    },
    {
      name: "Python script file",
      input: { runtime: "python", executable: "python3", args: ["script.py"] },
    },
    {
      name: "Python script arguments that resemble command source",
      input: {
        runtime: "python",
        executable: "python3",
        args: ["script.py", "-c", `open("../../README.md").read()`],
      },
    },
    {
      name: "Python script arguments that resemble attached command source",
      input: {
        runtime: "python",
        executable: "python3",
        args: ["script.py", `-copen("../../README.md").read()`],
      },
    },
    {
      name: "PowerShell script file",
      input: {
        runtime: "powershell",
        executable: "pwsh",
        args: ["-File", "script.ps1"],
      },
    },
    {
      name: "named npm script with redirect",
      input: {
        code: "npm test < ../../README.md",
        executable: "bash",
        args: [],
      },
    },
    {
      name: "named pnpm run script with pass-through",
      input: {
        code: "pnpm run unit -- --grep src",
        executable: "bash",
        args: [],
      },
    },
    {
      name: "named yarn script",
      input: { code: "yarn test", executable: "bash", args: [] },
    },
    {
      name: "named bun run script",
      input: { code: "bun run unit", executable: "bash", args: [] },
    },
    {
      name: "package exec form",
      input: {
        code: "npm exec -- rg needle ../../src",
        executable: "bash",
        args: [],
      },
    },
    {
      name: "toolchain command",
      input: {
        code: "git grep needle ../../src",
        executable: "bash",
        args: [],
      },
    },
    {
      name: "dynamic POSIX target",
      input: { code: "cat $FILE", executable: "bash", args: [] },
    },
    {
      name: "ambiguous segment after a stable match",
      input: {
        code: "cat ../../README.md; cat $FILE",
        executable: "bash",
        args: [],
      },
    },
    {
      name: "unknown Node flag form",
      input: {
        runtime: "node",
        executable: "node",
        args: ["--eval=unknown()"],
      },
    },
    {
      name: "invalid Node long source lookalike",
      input: {
        runtime: "node",
        executable: "node",
        args: ["--evaluation=unknown()"],
      },
    },
  ];

  for (const testCase of cases) {
    it(`allows ${testCase.name}`, () => {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(testCase.input)),
        ALLOW,
      );
    });
  }

  it("allows incomplete compound shell text as ambiguous", () => {
    for (const code of [
      "cat ../../README.md &&",
      "cat ../../README.md ||",
      "cat ../../README.md |",
      "&& cat ../../README.md",
    ]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({ runtime: "shell", executable: "bash", args: [], code }),
        ),
        ALLOW,
      );
    }
  });
});

describe("classifyRuntimeRepositoryInspection input redirection and stability", () => {
  it("denies attached repository input redirection to a closed reader", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          executable: "bash",
          args: [],
          code: "cat < ../../README.md",
        }),
      ),
      deny("inputRedirection", "command.input-redirection.cat"),
    );
  });

  it("does not classify stdin markers as paths", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({ executable: "cat", args: ["-"] }),
      ),
      ALLOW,
    );
  });

  it("returns byte-stable data with no volatile or source fields", () => {
    const input = request({ executable: "rg", args: ["secret", "../../src"] });
    const first = classifyRuntimeRepositoryInspection(input);
    const second = classifyRuntimeRepositoryInspection(input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(Object.keys(first), ["decision", "category", "ruleId"]);
  });
});

describe("classifyRuntimeRepositoryInspection defensive branches", () => {
  const javascriptRead = `import fs from "node:fs"; fs.readFileSync("../../README.md")`;
  const pythonRead = `open("../../README.md").read()`;

  it("allows an unsupported runtime even when code is present", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "ruby",
          executable: "ruby",
          args: [],
          code: `File.read("../../README.md")`,
        }),
      ),
      ALLOW,
    );
  });

  it("allows a directly invoked wrapper when its command text is ambiguous", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          executable: "sh",
          args: ["-c", "cat $FILE"],
        }),
      ),
      ALLOW,
    );
  });

  it("allows invalid lexical roots and uncertain Windows working directories", () => {
    const cases: RuntimeRepositoryInspectionTestOverrides[] = [
      { repoRoot: "relative/repo", relativeCwd: ".", args: ["file.ts"] },
      {
        repoRoot: "C:\\Work\\Repo",
        cwd: "C:src",
        platform: "win32",
        executable: "type",
        args: ["file.txt"],
      },
      {
        repoRoot: "C:\\Work\\Repo",
        cwd: "\\\\server\\share",
        platform: "win32",
        executable: "type",
        args: ["file.txt"],
      },
    ];
    for (const input of cases) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(input)),
        ALLOW,
      );
    }
  });

  it("allows unsafe glob suffix traversal but denies a bare cwd glob", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          executable: "rg",
          args: ["needle", "../../src/*/../../../outside"],
        }),
      ),
      ALLOW,
    );
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          executable: "rg",
          args: ["needle", "*.ts"],
        }),
      ),
      deny("repositorySearch", "command.repository-search.rg"),
    );
  });

  it("covers Windows glob prefix and suffix handling", () => {
    const base = {
      repoRoot: "C:\\Work\\Repo",
      relativeCwd: "src",
      platform: "win32" as const,
      executable: "rg",
    };
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          ...base,
          args: ["needle", "*.ts"],
        }),
      ),
      deny("repositorySearch", "command.repository-search.rg"),
    );
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          ...base,
          args: ["needle", "*\\..\\..\\outside"],
        }),
      ),
      ALLOW,
    );
  });

  it("covers empty, NUL, and exact repository-root targets", () => {
    for (const target of ["", "\0"]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request({ args: [target] })),
        ALLOW,
      );
    }
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(request({ args: ["../.."] })),
      deny("directReader", "command.direct-reader.cat"),
    );
  });

  it("quotes a direct PowerShell path containing spaces", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "powershell",
          executable: "Get-Content",
          args: ["../../file with spaces.txt"],
        }),
      ),
      deny("directReader", "command.direct-reader.get-content"),
    );
  });

  it("allows stable inline candidates and input redirects outside the repository", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "node",
          executable: "node",
          args: [],
          code: `import fs from "node:fs"; fs.readFileSync("/outside/file.ts")`,
        }),
      ),
      ALLOW,
    );
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          executable: "bash",
          args: [],
          code: "cat < /outside/file.ts",
        }),
      ),
      ALLOW,
    );
  });

  it("uses the host platform when the optional platform is omitted", () => {
    const windows = process.platform === "win32";
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          repoRoot: windows ? "C:\\Work\\Repo" : "/repo",
          relativeCwd: windows ? "src" : "packages/app",
          platform: undefined,
          executable: windows ? "C:\\tools\\rg.exe" : "/usr/bin/rg",
          args: ["needle", windows ? "..\\README.md" : "../../README.md"],
        }),
      ),
      deny("repositorySearch", "command.repository-search.rg"),
    );
  });

  it("allows missing or ambiguous Node eval source", () => {
    for (const args of [
      ["-e"],
      ["-e", javascriptRead, "-p", javascriptRead],
      [`--eval=${javascriptRead}`, `-p${javascriptRead}`],
      [`-e${javascriptRead}`, "--print", javascriptRead],
    ]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "node",
            executable: "node",
            args,
          }),
        ),
        ALLOW,
      );
    }
  });

  it("keeps Node arguments after the end-of-options marker out of source selection", () => {
    assert.deepEqual(
      classifyRuntimeRepositoryInspection(
        request({
          runtime: "node",
          executable: "node",
          args: ["-e", javascriptRead, "--", "--eval=console.log('argument')"],
        }),
      ),
      deny("inlineStaticRead", "inline.javascript.fs-read-file-sync"),
    );
  });

  it("covers Node stdin markers and option forms", () => {
    const deniedArgs = [["--"], ["--input-type=module"], ["--no-warnings"]];
    for (const args of deniedArgs) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "node",
            executable: "node",
            args,
            stdin: javascriptRead,
          }),
        ),
        deny("inlineStaticRead", "inline.javascript.fs-read-file-sync"),
      );
    }

    const allowedArgs = [
      ["--"],
      ["--", "script.mjs"],
      ["--input-type"],
      ["-"],
      [],
    ];
    for (const args of allowedArgs) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "node",
            executable: "node",
            args,
          }),
        ),
        ALLOW,
      );
    }
  });

  it("covers Python stdin switches and option values", () => {
    for (const args of [["-B"], ["-W", "ignore"], ["-X", "utf8"]]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "python",
            executable: "python3",
            args,
            stdin: pythonRead,
          }),
        ),
        deny("inlineStaticRead", "inline.python.open"),
      );
    }
  });

  it("allows missing Python option values and absent stdin", () => {
    for (const args of [["-c"], ["-W"], ["-X"], ["-"], []]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "python",
            executable: "python3",
            args,
          }),
        ),
        ALLOW,
      );
    }
  });

  it("treats tokens after Python command source as program arguments", () => {
    for (const args of [
      ["-c", pythonRead, "-cbenign"],
      [`-c${pythonRead}`, "-cbenign"],
    ]) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime: "python",
            executable: "python3",
            args,
          }),
        ),
        deny("inlineStaticRead", "inline.python.open"),
      );
    }
  });

  it("allows dynamic attached source candidates", () => {
    const cases: Array<Partial<RuntimeRepositoryInspectionRequest>> = [
      {
        runtime: "node",
        executable: "node",
        args: ["--eval=const path = process.argv[1]; console.log(path)"],
      },
      {
        runtime: "python",
        executable: "python3",
        args: ["-cpath = input()\nopen(path).read()"],
      },
    ];
    for (const input of cases) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(request(input)),
        ALLOW,
      );
    }
  });

  it("allows sparse runtime argument arrays defensively", () => {
    const sparseArgs = Array<string>(1);
    for (const runtime of ["node", "python"] as const) {
      assert.deepEqual(
        classifyRuntimeRepositoryInspection(
          request({
            runtime,
            executable: runtime === "node" ? "node" : "python3",
            args: sparseArgs,
          }),
        ),
        ALLOW,
      );
    }
  });
});
