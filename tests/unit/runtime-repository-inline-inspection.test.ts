import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  inspectInlineJavaScript,
  inspectInlinePython,
  type InlineInspectionCandidate,
} from "../../dist/runtime/repository-inline-inspection.js";

function candidate(
  path: string,
  ruleId: InlineInspectionCandidate["ruleId"],
): InlineInspectionCandidate {
  return { path, ruleId };
}

describe("inspectInlineJavaScript", () => {
  const primitiveCases: Array<{
    name: string;
    source: string;
    expected: InlineInspectionCandidate;
  }> = [
    {
      name: "default fs import with readFileSync",
      source: `import fs from "node:fs"; fs.readFileSync("src/main.ts");`,
      expected: candidate(
        "src/main.ts",
        "inline.javascript.fs-read-file-sync",
      ),
    },
    {
      name: "namespace fs import from the legacy specifier",
      source: `import * as fs from "fs"; fs.readFile("README.md", callback);`,
      expected: candidate("README.md", "inline.javascript.fs-read-file"),
    },
    {
      name: "fs promises readFile",
      source: `import * as fs from "node:fs"; await fs.promises.readFile("package.json");`,
      expected: candidate(
        "package.json",
        "inline.javascript.fs-promises-read-file",
      ),
    },
    {
      name: "direct readFileSync import",
      source: `import { readFileSync } from "fs"; readFileSync("tsconfig.json");`,
      expected: candidate(
        "tsconfig.json",
        "inline.javascript.imported-read-file-sync",
      ),
    },
    {
      name: "direct readFile import",
      source: `import { readFile } from "node:fs"; readFile("LICENSE", callback);`,
      expected: candidate(
        "LICENSE",
        "inline.javascript.imported-read-file",
      ),
    },
  ];

  for (const testCase of primitiveCases) {
    it(`recognizes ${testCase.name}`, () => {
      assert.deepEqual(inspectInlineJavaScript(testCase.source), [
        testCase.expected,
      ]);
    });
  }

  it("recognizes unshadowed CommonJS fs bindings only when enabled", () => {
    const source = `
      require("node:fs").readFileSync("direct.txt");
      const fs = require("fs");
      fs.readFile("namespace.txt", callback);
      const { readFileSync } = require("node:fs");
      readFileSync("destructured.txt");
    `;

    assert.deepEqual(
      inspectInlineJavaScript(source, { commonJsRequire: true }),
      [
        candidate("direct.txt", "inline.javascript.fs-read-file-sync"),
        candidate("namespace.txt", "inline.javascript.fs-read-file"),
        candidate(
          "destructured.txt",
          "inline.javascript.imported-read-file-sync",
        ),
      ],
    );
    assert.deepEqual(inspectInlineJavaScript(source), []);
  });

  it("does not trust shadowed or dynamic CommonJS require bindings", () => {
    const cases = [
      `function inspect(require) { require("node:fs").readFileSync("secret.txt"); }`,
      `const require = loader; require("node:fs").readFileSync("secret.txt");`,
      `require = loader; require("node:fs").readFileSync("secret.txt");`,
      `require++; require("node:fs").readFileSync("secret.txt");`,
      `require(moduleName).readFileSync("secret.txt");`,
      `loader.require("node:fs").readFileSync("secret.txt");`,
      `import "other"; require("node:fs").readFileSync("secret.txt");`,
    ];

    for (const source of cases) {
      assert.deepEqual(
        inspectInlineJavaScript(source, { commonJsRequire: true }),
        [],
      );
    }
  });

  it("applies CommonJS require mutations in source order", () => {
    assert.deepEqual(
      inspectInlineJavaScript(
        `
          require("node:fs").readFileSync("before.txt");
          require = loader;
          require("node:fs").readFileSync("after.txt");
        `,
        { commonJsRequire: true },
      ),
      [candidate("before.txt", "inline.javascript.fs-read-file-sync")],
    );
    const destructuringMutations = [
      `({ require } = bindings);`,
      `({ source: require } = bindings);`,
      `({ nested: { require } } = bindings);`,
      `({ ...require } = bindings);`,
      `([...require] = bindings);`,
    ];
    for (const mutation of destructuringMutations) {
      assert.deepEqual(
        inspectInlineJavaScript(
          `${mutation} require("node:fs").readFileSync("after.txt");`,
          { commonJsRequire: true },
        ),
        [],
      );
    }
    assert.deepEqual(
      inspectInlineJavaScript(
        `[require] = bindings
         require("node:fs").readFileSync("after.txt");`,
        { commonJsRequire: true },
      ),
      [],
    );
  });

  it("does not treat destructuring expressions as require bindings", () => {
    const cases = [
      `let value; ({ value = require } = {}); require("node:fs").readFileSync("after.txt");`,
      `let value; ({ [require]: value } = {}); require("node:fs").readFileSync("after.txt");`,
    ];

    for (const source of cases) {
      assert.deepEqual(
        inspectInlineJavaScript(source, { commonJsRequire: true }),
        [candidate("after.txt", "inline.javascript.fs-read-file-sync")],
      );
    }
  });

  it("activates destructured require bindings after initializer evaluation", () => {
    assert.deepEqual(
      inspectInlineJavaScript(
        `
          ({ require = require("node:fs").readFileSync("initializer.txt") } = {});
          require("node:fs").readFileSync("after.txt");
        `,
        { commonJsRequire: true },
      ),
      [candidate("initializer.txt", "inline.javascript.fs-read-file-sync")],
    );
    assert.deepEqual(
      inspectInlineJavaScript(
        `
          ({ require } = (require("node:fs").readFileSync("rhs.txt"), bindings));
          require("node:fs").readFileSync("after.txt");
        `,
        { commonJsRequire: true },
      ),
      [candidate("rhs.txt", "inline.javascript.fs-read-file-sync")],
    );
  });

  it("keeps paired-operator continuations inside a destructuring RHS", () => {
    const continuations = [
      `true\n&& require("node:fs").readFileSync("rhs.txt")`,
      `false\n|| require("node:fs").readFileSync("rhs.txt")`,
      `null\n?? require("node:fs").readFileSync("rhs.txt")`,
      `loader\n?.factory(require("node:fs").readFileSync("rhs.txt"))`,
    ];

    for (const rhs of continuations) {
      assert.deepEqual(
        inspectInlineJavaScript(`[require] = ${rhs}`, { commonJsRequire: true }),
        [candidate("rhs.txt", "inline.javascript.fs-read-file-sync")],
      );
    }
  });

  it("supports combined imports, comments between tokens, and source order", () => {
    const source = `
      import fs, {
        readFileSync,
        /* import gap */ readFile,
      } from /* module gap */ "node:fs";
      fs /* a */ . /* b */ readFileSync /* c */ ( "one.txt" );
      readFile /* d */ ( "two.txt", callback );
      fs . promises . readFile ( "three.txt" );
    `;

    assert.deepEqual(inspectInlineJavaScript(source), [
      candidate("one.txt", "inline.javascript.fs-read-file-sync"),
      candidate("two.txt", "inline.javascript.imported-read-file"),
      candidate("three.txt", "inline.javascript.fs-promises-read-file"),
    ]);
  });

  it("decodes supported quoted and static-template escapes", () => {
    const source = [
      `import * as fs from "node:fs";`,
      String.raw`fs.readFileSync('dir\\file\x2ets');`,
      String.raw`fs.readFile("line\nfeed.txt");`,
      "fs.promises.readFile(`unicode-\\u0061-\\u{62}.txt`);",
      "fs.readFileSync(`escaped-\\${literal}.txt`);",
    ].join("\n");

    assert.deepEqual(inspectInlineJavaScript(source), [
      candidate("dir\\file.ts", "inline.javascript.fs-read-file-sync"),
      candidate("line\nfeed.txt", "inline.javascript.fs-read-file"),
      candidate("unicode-a-b.txt", "inline.javascript.fs-promises-read-file"),
      candidate("escaped-${literal}.txt", "inline.javascript.fs-read-file-sync"),
    ]);
  });

  it("ignores reader-shaped text inside regular-expression literals", () => {
    const source = [
      `import fs from "node:fs";`,
      `const first = /fs.readFileSync("secret.txt")/giu;`,
      "const second = /fs.promises.readFile(`also-secret.txt`)/;",
    ].join("\n");
    assert.deepEqual(inspectInlineJavaScript(source), []);
  });

  it("conservatively rejects division mixed with a repository read", () => {
    const source = `
      import fs from "node:fs";
      const ratio = total / count;
      fs.readFileSync("real.txt");
    `;
    assert.deepEqual(inspectInlineJavaScript(source), []);
  });

  it("rejects slash syntax after closing parentheses or keyword-like properties", () => {
    const cases = [
      `import fs from "node:fs"; if (enabled) /fs.readFileSync("secret")/.test(input);`,
      `import fs from "node:fs"; obj.return / count; fs.readFileSync("real");`,
    ];
    for (const source of cases) {
      assert.deepEqual(inspectInlineJavaScript(source), []);
    }
  });

  const negativeCases: Array<[string, string]> = [
    [
      "calls in comments",
      `import fs from "node:fs"; // fs.readFileSync("secret.txt")\n/* fs.readFile("also-secret.txt") */`,
    ],
    [
      "calls embedded in unrelated strings",
      `import fs from "node:fs"; const example = 'fs.readFileSync("secret.txt")';`,
    ],
    [
      "unbound fs identifiers",
      `fs.readFileSync("secret.txt");`,
    ],
    [
      "namespace import aliases",
      `import * as filesystem from "node:fs"; filesystem.readFileSync("secret.txt");`,
    ],
    [
      "default import aliases",
      `import filesystem from "node:fs"; filesystem.readFile("secret.txt");`,
    ],
    [
      "aliased direct imports",
      `import { readFileSync as read } from "node:fs"; read("secret.txt");`,
    ],
    [
      "type-only imports",
      `import type { readFileSync } from "node:fs"; readFileSync("secret.txt");`,
    ],
    [
      "similarly named imports from unrelated modules",
      `import { readFileSync } from "other"; readFileSync("secret.txt");`,
    ],
    [
      "shadowed fs bindings",
      `import fs from "node:fs"; function inspect(fs) { fs.readFileSync("secret.txt"); }`,
    ],
    [
      "shadowed direct bindings",
      `import { readFileSync } from "node:fs"; function inspect(readFileSync) { readFileSync("secret.txt"); }`,
    ],
    [
      "fs bindings in later declarators",
      `import fs from "node:fs"; const initialized = other, fs = fake; fs.readFileSync("secret.txt");`,
    ],
    [
      "readFile bindings in later declarators",
      `import { readFile } from "node:fs"; const initialized = other, readFile = fake; readFile("secret.txt");`,
    ],
    [
      "readFileSync bindings after initialized declarators",
      `import { readFileSync } from "node:fs"; let first = one, second = two, readFileSync = fake; readFileSync("secret.txt");`,
    ],
    [
      "arrow-parameter shadows",
      `import { readFile } from "node:fs"; const inspect = (readFile) => readFile("secret.txt");`,
    ],
    [
      "method-parameter shadows",
      `import fs from "node:fs"; class C { method(fs) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "async method-parameter shadows",
      `import fs from "node:fs"; class C { async method(fs) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "generator method-parameter shadows",
      `import fs from "node:fs"; class C { * method(fs) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "async generator method-parameter shadows",
      `import fs from "node:fs"; class C { async * method(fs) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "getter-local bindings",
      `import fs from "node:fs"; class C { get value() { const fs = other; return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "setter parameter shadows",
      `import fs from "node:fs"; class C { set value(fs) { fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "comma-separated object method shadows",
      `import fs from "node:fs"; const readers = { first() {}, second(fs) { return fs.readFileSync("secret.txt"); } };`,
    ],
    [
      "public TypeScript method-parameter shadows",
      `import fs from "node:fs"; class C { public method(fs: unknown) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "private TypeScript method-parameter shadows",
      `import fs from "node:fs"; class C { private method(fs: unknown) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "computed method-parameter shadows",
      `import fs from "node:fs"; class C { [methodName](fs) { return fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "string-named method-parameter shadows",
      `import fs from "node:fs"; const readers = { "read"(fs) { return fs.readFileSync("secret.txt"); } };`,
    ],
    [
      "numeric method-parameter shadows",
      `import fs from "node:fs"; const readers = { 1(fs) { return fs.readFileSync("secret.txt"); } };`,
    ],
    [
      "TypeScript method return annotations",
      `import fs from "node:fs"; class C { method(fs): void { fs.readFileSync("secret.txt"); } }`,
    ],
    [
      "TypeScript arrow return annotations",
      `import fs from "node:fs"; const inspect = (fs): void => { fs.readFileSync("secret.txt"); };`,
    ],
    [
      "concatenated paths",
      `import fs from "node:fs"; fs.readFileSync("src/" + name);`,
    ],
    [
      "dynamic path expressions",
      `import fs from "node:fs"; fs.readFile(path);`,
    ],
    [
      "interpolated template paths",
      "import fs from 'node:fs'; fs.readFileSync(`src/${name}.ts`);",
    ],
    [
      "member calls with the same terminal name",
      `import { readFileSync } from "node:fs"; wrapper.readFileSync("secret.txt");`,
    ],
    [
      "malformed source",
      `import fs from "node:fs"; fs.readFileSync("secret.txt";`,
    ],
    [
      "unterminated comments",
      `import fs from "node:fs"; /* fs.readFileSync("secret.txt");`,
    ],
  ];

  for (const [name, source] of negativeCases) {
    it(`does not recognize ${name}`, () => {
      assert.deepEqual(inspectInlineJavaScript(source), []);
    });
  }

  it("returns no candidates when scanner bounds are exceeded", () => {
    const cases = [
      `import fs from "node:fs"; fs.readFileSync("${"a".repeat(40_000)}");`,
      `import fs from "node:fs"; ${Array.from({ length: 4_100 }, () => "x").join(";")}; fs.readFileSync("late.txt");`,
      `import fs from "node:fs"; fs.readFileSync("${"a".repeat(8_193)}");`,
    ];
    for (const source of cases) {
      assert.deepEqual(inspectInlineJavaScript(source), []);
    }
  });

  it("allows exactly 64 candidates and rejects a sixty-fifth", () => {
    const calls = (count: number): string => [
      `import fs from "node:fs";`,
      ...Array.from(
        { length: count },
        (_, index) => `fs.readFileSync("file-${index}.txt");`,
      ),
    ].join("\n");

    assert.equal(inspectInlineJavaScript(calls(64)).length, 64);
    assert.deepEqual(inspectInlineJavaScript(calls(65)), []);
  });
});

describe("inspectInlinePython", () => {
  const primitiveCases: Array<{
    name: string;
    source: string;
    expected: InlineInspectionCandidate;
  }> = [
    {
      name: "open with the default mode",
      source: `open("README.md")`,
      expected: candidate("README.md", "inline.python.open"),
    },
    {
      name: "open with a positional read mode",
      source: `open('payload.bin', 'rb')`,
      expected: candidate("payload.bin", "inline.python.open"),
    },
    {
      name: "open with a keyword read/write mode",
      source: `open("notes.txt", mode="w+", encoding="utf-8")`,
      expected: candidate("notes.txt", "inline.python.open"),
    },
    {
      name: "Path read_text",
      source: `from pathlib import Path\nPath("pyproject.toml").read_text()`,
      expected: candidate("pyproject.toml", "inline.python.path-read-text"),
    },
    {
      name: "Path read_bytes",
      source: `from pathlib import Path\nPath('fixture.bin').read_bytes()`,
      expected: candidate("fixture.bin", "inline.python.path-read-bytes"),
    },
  ];

  for (const testCase of primitiveCases) {
    it(`recognizes ${testCase.name}`, () => {
      assert.deepEqual(inspectInlinePython(testCase.source), [
        testCase.expected,
      ]);
    });
  }

  it("recognizes a single literal file keyword in any keyword order", () => {
    assert.deepEqual(inspectInlinePython(`open(file="first.txt")`), [
      candidate("first.txt", "inline.python.open"),
    ]);
    assert.deepEqual(
      inspectInlinePython(`open(mode="r", file="second.txt")`),
      [candidate("second.txt", "inline.python.open")],
    );
  });

  it("rejects duplicate, dynamic, and unpacked file keyword arguments", () => {
    const cases = [
      `open("first.txt", file="second.txt")`,
      `open(file=path)`,
      `open(file="secret.txt", **kwargs)`,
    ];

    for (const source of cases) {
      assert.deepEqual(inspectInlinePython(source), []);
    }
  });

  it("supports comments and whitespace between Python tokens", () => {
    const source = `
      from pathlib import Path
      first = open /* invalid in Python but scanner must not invent syntax */
    `;
    assert.deepEqual(inspectInlinePython(source), []);

    const validSource = `
      from pathlib import Path
      open (
        "one.txt", # mode omitted
        encoding = "utf-8",
      )
      Path (
        "two.txt"
      ) . read_text (
      )
    `;
    assert.deepEqual(inspectInlinePython(validSource), [
      candidate("one.txt", "inline.python.open"),
      candidate("two.txt", "inline.python.path-read-text"),
    ]);
  });

  it("recognizes Path in multi-name and parenthesized pathlib imports", () => {
    const cases = [
      `from pathlib import PurePath, Path\nPath("one.txt").read_text()`,
      `from pathlib import (\n    PurePath,\n    Path,\n)\nPath("two.bin").read_bytes()`,
    ];
    assert.deepEqual(inspectInlinePython(cases[0] ?? ""), [
      candidate("one.txt", "inline.python.path-read-text"),
    ]);
    assert.deepEqual(inspectInlinePython(cases[1] ?? ""), [
      candidate("two.bin", "inline.python.path-read-bytes"),
    ]);
  });

  it("uses exact, source-ordered Python import bindings", () => {
    assert.deepEqual(
      inspectInlinePython(
        `from pathlib.extra import Path\nPath("secret.txt").read_text()`,
      ),
      [],
    );
    assert.deepEqual(
      inspectInlinePython(
        `from other import Path\nfrom pathlib import Path\nPath("real.txt").read_text()`,
      ),
      [candidate("real.txt", "inline.python.path-read-text")],
    );
    assert.deepEqual(inspectInlinePython(`import open\nopen("secret.txt")`), []);
  });

  it("evaluates Python Path and open bindings at each call position", () => {
    const source = `
      open("builtin-before.txt")
      from pathlib import Path
      Path("path-before.txt").read_text()
      from other import Path
      Path("path-shadowed.txt").read_text()
      import open
      open("open-shadowed.txt")
      from pathlib import Path
      Path("path-restored.txt").read_bytes()
    `;
    assert.deepEqual(inspectInlinePython(source), [
      candidate("builtin-before.txt", "inline.python.open"),
      candidate("path-before.txt", "inline.python.path-read-text"),
      candidate("path-restored.txt", "inline.python.path-read-bytes"),
    ]);
  });

  it("rejects Python structural syntax the flat binding model cannot scope", () => {
    const cases = [
      `def inspect():\n    from pathlib import Path\n    return Path("secret.txt").read_text()`,
      `from pathlib import Path\ndel Path\nPath("secret.txt").read_text()`,
      `from pathlib import Path\nfor (Path, other) in values:\n    Path("secret.txt").read_text()`,
      `while enabled:\n    open("secret.txt")`,
      `with resource:\n    open("secret.txt")`,
      `try:\n    open("secret.txt")\nexcept Exception:\n    pass`,
      `class Reader:\n    value = open("secret.txt")`,
      `reader = lambda: open("secret.txt")`,
    ];
    for (const source of cases) {
      assert.deepEqual(inspectInlinePython(source), []);
    }
  });

  it("decodes supported Python escapes deterministically", () => {
    const source = String.raw`
      open('dir\\file\x2epy')
      open("unicode-\u0061-\U00000062.txt")
      open('line\nfeed.txt')
    `;
    assert.deepEqual(inspectInlinePython(source), [
      candidate("dir\\file.py", "inline.python.open"),
      candidate("unicode-a-b.txt", "inline.python.open"),
      candidate("line\nfeed.txt", "inline.python.open"),
    ]);
  });

  it("decodes Python octal, named Unicode, bell, and standard escapes", () => {
    const source = [
      String.raw`open("octal-\141.txt")`,
      String.raw`open("named-\N{LATIN SMALL LETTER A}.txt")`,
      String.raw`open("bell-\a-tab-\t-newline-\n.txt")`,
    ].join("\n");
    assert.deepEqual(inspectInlinePython(source), [
      candidate("octal-a.txt", "inline.python.open"),
      candidate("named-a.txt", "inline.python.open"),
      candidate("bell-\u0007-tab-\t-newline-\n.txt", "inline.python.open"),
    ]);
  });

  it("allows multiplication inside an unrelated open keyword value", () => {
    assert.deepEqual(
      inspectInlinePython(`open("real.txt", buffering=2 * 1024)`),
      [candidate("real.txt", "inline.python.open")],
    );
  });

  it("recognizes default openers and rejects custom positional openers", () => {
    assert.deepEqual(
      inspectInlinePython(`open(file="keyword.txt", opener=None)`),
      [candidate("keyword.txt", "inline.python.open")],
    );
    assert.deepEqual(
      inspectInlinePython(
        `open("positional.txt", "r", -1, None, None, None, True, None)`,
      ),
      [candidate("positional.txt", "inline.python.open")],
    );
    assert.deepEqual(
      inspectInlinePython(
        `open("secret.txt", "r", -1, None, None, None, True, myopener)`,
      ),
      [],
    );
  });

  const writeOnlyModes = ["w", "wb", "a", "at", "x", "xb"];
  for (const mode of writeOnlyModes) {
    it(`rejects write-only open mode ${mode}`, () => {
      assert.deepEqual(inspectInlinePython(`open("secret.txt", "${mode}")`), []);
    });
  }

  const negativeCases: Array<[string, string]> = [
    ["calls in comments", `# open("secret.txt")\n# Path("secret.txt").read_text()`],
    ["calls in strings", `'open("secret.txt")'`],
    ["Path without its import", `Path("secret.txt").read_text()`],
    [
      "Path from an unrelated module",
      `from other import Path\nPath("secret.txt").read_text()`,
    ],
    [
      "later unaliased Path imports from another module",
      `from pathlib import Path\nfrom other import Path\nPath("secret.txt").read_text()`,
    ],
    [
      "unaliased open imports from another module",
      `from io import open\nopen("secret.txt")`,
    ],
    [
      "semicolon-separated import shadows",
      `from io import open; open("secret.txt")`,
    ],
    [
      "shadowed Path bindings",
      `from pathlib import Path\ndef inspect(Path):\n    return Path("secret.txt").read_text()`,
    ],
    [
      "shadowed open bindings",
      `def inspect(open):\n    return open("secret.txt")`,
    ],
    [
      "annotated open assignments",
      `open: object = reader\nopen("secret.txt")`,
    ],
    [
      "augmented open assignments",
      `open += wrapper\nopen("secret.txt")`,
    ],
    [
      "destructured Path assignments",
      `from pathlib import Path\n(Path, other) = values\nPath("secret.txt").read_text()`,
    ],
    [
      "long destructured Path assignments",
      `from pathlib import Path\n(Path, ${Array.from({ length: 72 }, (_, index) => `sibling_${index}`).join(", ")}) = values\nPath("secret.txt").read_text()`,
    ],
    ["lambda-parameter shadows", `inspect = lambda open: open("secret.txt")`],
    ["concatenated paths", `open("src/" + name)`],
    ["dynamic paths", `open(path)`],
    ["custom openers", `open(file="secret.txt", opener=myopener)`],
    ["nonliteral modes", `open("secret.txt", mode)`],
    ["nonliteral keyword modes", `open("secret.txt", mode=MODE)`],
    ["unpacked keyword arguments", `open("secret.txt", **kwargs)`],
    ["unpacked positional arguments", `open(*paths)`],
    ["later unpacked positional arguments", `open("secret.txt", *options)`],
    ["formatted strings", `open(f"src/{name}.py")`],
    ["unsupported Python escapes", String.raw`open("secret-\q.txt")`],
    ["malformed Python hex escapes", String.raw`open("secret-\xZZ.txt")`],
    [
      "unknown Python Unicode names",
      String.raw`open("secret-\N{NOT A UNICODE NAME}.txt")`,
    ],
    [
      "ambiguous star imports anywhere in the source",
      `open("before.txt")\nfrom other import *\nopen("after.txt")`,
    ],
    ["unsupported triple-quoted input", `"""docstring"""\nopen("secret.txt")`],
    ["unrelated member calls", `reader.open("secret.txt")`],
    ["malformed calls", `open("secret.txt"`],
    ["unterminated strings", `open("secret.txt)`],
  ];

  for (const [name, source] of negativeCases) {
    it(`does not recognize ${name}`, () => {
      assert.deepEqual(inspectInlinePython(source), []);
    });
  }

  it("returns no Python candidates when scanner bounds are exceeded", () => {
    const cases = [
      `open("${"a".repeat(40_000)}")`,
      `${Array.from({ length: 4_100 }, () => "x").join(";")}\nopen("late.txt")`,
      `open("${"a".repeat(8_193)}")`,
    ];
    for (const source of cases) {
      assert.deepEqual(inspectInlinePython(source), []);
    }
  });

  it("allows exactly 64 Python candidates and rejects a sixty-fifth", () => {
    const calls = (count: number): string => Array.from(
      { length: count },
      (_, index) => `open("file-${index}.txt")`,
    ).join("\n");

    assert.equal(inspectInlinePython(calls(64)).length, 64);
    assert.deepEqual(inspectInlinePython(calls(65)), []);
  });
});

describe("runtime repository-inspection alias regressions", () => {
  it("recognizes static node:fs promise imports and aliases", () => {
    const cases: Array<[string, InlineInspectionCandidate]> = [
      [
        `import { promises as fs } from "node:fs"; await fs.readFile("package.json");`,
        candidate("package.json", "inline.javascript.fs-promises-read-file"),
      ],
      [
        `import { readFile } from "node:fs/promises"; await readFile("package.json");`,
        candidate("package.json", "inline.javascript.imported-read-file"),
      ],
      [
        `import { readFile as read } from "node:fs/promises"; await read("package.json");`,
        candidate("package.json", "inline.javascript.imported-read-file"),
      ],
      [
        `import * as fsp from "node:fs/promises"; await fsp.readFile("package.json");`,
        candidate("package.json", "inline.javascript.fs-promises-read-file"),
      ],
    ];

    for (const [source, expected] of cases) {
      assert.deepEqual(inspectInlineJavaScript(source), [expected], source);
    }
  });

  it("applies promise-import rebinding and shadowing in source order", () => {
    const cases = [
      `import { promises as files } from "node:fs"; files = fake; await files.readFile("package.json");`,
      `import { readFile as read } from "node:fs/promises"; read = fake; await read("package.json");`,
      `import * as fsp from "node:fs/promises"; function run(fsp) { return fsp.readFile("package.json"); }`,
      `const fsp = fake; await fsp.readFile("package.json");`,
    ];

    for (const source of cases) {
      assert.deepEqual(inspectInlineJavaScript(source), [], source);
    }
  });

  it("recognizes statically proven ESM createRequire bindings", () => {
    const source = [
      `import { createRequire as makeRequire } from "node:module";`,
      `const req = makeRequire(import.meta.url);`,
      `const files = req("node:fs");`,
      `files.readFileSync("package.json", "utf8");`,
    ].join("\n");

    assert.deepEqual(inspectInlineJavaScript(source), [
      candidate("package.json", "inline.javascript.fs-read-file-sync"),
    ]);
  });

  it("does not trust rebound or locally faked createRequire chains", () => {
    const cases = [
      [
        `import { createRequire } from "node:module";`,
        `createRequire = fake;`,
        `const req = createRequire(import.meta.url);`,
        `req("node:fs").readFileSync("package.json");`,
      ].join("\n"),
      [
        `import { createRequire } from "node:module";`,
        `const req = createRequire(import.meta.url);`,
        `req = fake;`,
        `req("node:fs").readFileSync("package.json");`,
      ].join("\n"),
      [
        `const createRequire = fake;`,
        `const req = createRequire(import.meta.url);`,
        `req("node:fs").readFileSync("package.json");`,
      ].join("\n"),
    ];

    for (const source of cases) {
      assert.deepEqual(inspectInlineJavaScript(source), [], source);
    }
  });

  it("recognizes pathlib namespaces and constructor aliases", () => {
    const cases: Array<[string, InlineInspectionCandidate]> = [
      [
        `import pathlib\npathlib.Path("package.json").read_text()`,
        candidate("package.json", "inline.python.path-read-text"),
      ],
      [
        `import pathlib as pl\npl.Path("package.json").read_bytes()`,
        candidate("package.json", "inline.python.path-read-bytes"),
      ],
      [
        `from pathlib import Path as P\nP("package.json").read_text()`,
        candidate("package.json", "inline.python.path-read-text"),
      ],
    ];

    for (const [source, expected] of cases) {
      assert.deepEqual(inspectInlinePython(source), [expected], source);
    }
  });

  it("does not trust rebound pathlib aliases or dynamic paths", () => {
    const cases = [
      `import pathlib as pl\npl = fake\npl.Path("package.json").read_text()`,
      `from pathlib import Path as P\nP = fake\nP("package.json").read_text()`,
      `import pathlib as pl\npl.Path(target).read_text()`,
      `pl = fake\npl.Path("package.json").read_text()`,
      `open(file="package.json", opener=custom)`,
    ];

    for (const source of cases) {
      assert.deepEqual(inspectInlinePython(source), [], source);
    }
  });
});
