# Exported Declaration Range Normalization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep provider-first and saved-file reconciliation ranges identical for supported exported TypeScript declarations.

**Architecture:** Normalize ranges once in the shared tree-sitter symbol extractor. Declaration processors select the nearest bounded `export_statement` wrapper, while methods, members, locals, and non-exported declarations keep their existing node ranges. Reconciliation and LadybugDB remain unchanged.

**Tech Stack:** TypeScript, tree-sitter, Node.js `node:test`, LadybugDB integration tests.

---

## Chunk 1: Test-first implementation and verification

### Task 1: Add regressions and verify RED

**Files:**
- Modify: `tests/unit/typescript-extract-symbols.test.ts`
- Modify: `tests/integration/saved-file-graph-patch.test.ts`
- Reference: `docs/superpowers/specs/2026-08-03-exported-declaration-range-normalization-design.md`

- [ ] **Step 1: Add the focused extractor regression**

Add this test inside the existing `TypeScript Symbol Extraction (IE-K.1)` suite:

```typescript
  it("uses export wrapper ranges for supported declarations", () => {
    const TypeScript = require("tree-sitter-typescript");
    const Parser = require("tree-sitter");
    const {
      extractSymbols,
    } = require("../../dist/indexer/treesitter/extractSymbols.js");

    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);

    const code = [
      "export function direct() {}",
      "export default function defaulted() {}",
      "export const exportedValue = 1;",
      "function local() {}",
      "export namespace Container {",
      "  const nested = 1;",
      "}",
    ].join("\n");

    const symbols = extractSymbols(parser.parse(code));
    const byName = new Map(symbols.map((symbol: any) => [symbol.name, symbol]));

    assert.deepStrictEqual(byName.get("direct")?.range, {
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 27,
    });
    assert.deepStrictEqual(byName.get("defaulted")?.range, {
      startLine: 2,
      startCol: 0,
      endLine: 2,
      endCol: 38,
    });
    assert.deepStrictEqual(byName.get("exportedValue")?.range, {
      startLine: 3,
      startCol: 0,
      endLine: 3,
      endCol: 31,
    });
    assert.deepStrictEqual(byName.get("local")?.range, {
      startLine: 4,
      startCol: 0,
      endLine: 4,
      endCol: 19,
    });
    assert.deepStrictEqual(byName.get("nested")?.range, {
      startLine: 6,
      startCol: 8,
      endLine: 6,
      endCol: 18,
    });
  });
```

- [ ] **Step 2: Add the provider-backed reconciliation regression**

Insert this test before the existing concurrent-patch test so it starts from the provider-first fixture created by `before()`:

```typescript
  it("keeps a provider-backed declaration range stable across edit and restore", async () => {
    const readAlpha = async () => {
      const conn = await getLadybugConn();
      const symbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
      const alpha = symbols.find((symbol) => symbol.name === "alpha");
      assert.ok(alpha, "alpha should remain persisted");
      return alpha;
    };
    const rangeOf = (symbol: Awaited<ReturnType<typeof readAlpha>>) => ({
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    });
    const patchAndVerify = async (content: string, version: number) => {
      let committedRevision = 0;
      await patchSavedFile(
        {
          repoId,
          filePath: "src/example.ts",
          content,
          language: "typescript",
          version,
        },
        {
          onCommitted(revision: number) {
            committedRevision = revision;
          },
        },
      );
      assert.ok(committedRevision > 0, "patch should publish a revision");
      await waitForVerifiedRevision(repoId, committedRevision);
    };

    const baselineContent = [
      "export function alpha() {",
      "  return beta();",
      "}",
      "",
      "export function beta() {",
      "  return 1;",
      "}",
    ].join("\n");
    const editedContent = baselineContent.replace(
      "return beta();",
      "return beta() + 1;",
    );
    assert.notEqual(editedContent, baselineContent);

    const baselineAlpha = await readAlpha();
    const baselineRange = rangeOf(baselineAlpha);
    assert.equal(baselineAlpha.symbolId, "scip-alpha");

    await patchAndVerify(editedContent, 1);
    const editedAlpha = await readAlpha();
    assert.equal(editedAlpha.symbolId, baselineAlpha.symbolId);
    assert.deepStrictEqual(rangeOf(editedAlpha), baselineRange);

    await patchAndVerify(baselineContent, 2);
    const restoredAlpha = await readAlpha();
    assert.equal(restoredAlpha.symbolId, baselineAlpha.symbolId);
    assert.deepStrictEqual(rangeOf(restoredAlpha), baselineRange);
  });
```

- [ ] **Step 3: Run the focused tests against the old implementation**

Run:

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/unit/typescript-extract-symbols.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/saved-file-graph-patch.test.ts
```

Expected: both new regressions fail because exported declarations start after `export`; existing tests remain green.

### Task 2: Implement the shared range normalization and verify GREEN

**Files:**
- Modify: `src/indexer/treesitter/extractSymbols.ts:160-378`
- Test: `tests/unit/typescript-extract-symbols.test.ts`
- Test: `tests/integration/saved-file-graph-patch.test.ts`

- [ ] **Step 1: Add the bounded wrapper selector**

Add this immediately after the existing `extractRange` function:

```typescript
const VARIABLE_EXPORT_RANGE_PARENT_TYPES = new Set([
  "object_pattern",
  "array_pattern",
  "pair",
  "variable_declarator",
  "lexical_declaration",
  "variable_declaration",
]);

/**
 * Align exported declaration spans with SCIP enclosing ranges without
 * crossing into an owning function, class, or module declaration.
 */
function extractDeclarationRange(node: Parser.SyntaxNode) {
  let declarationNode = node;
  while (
    declarationNode.parent &&
    VARIABLE_EXPORT_RANGE_PARENT_TYPES.has(declarationNode.parent.type)
  ) {
    declarationNode = declarationNode.parent;
  }

  const exportNode =
    declarationNode.parent?.type === "export_statement"
      ? declarationNode.parent
      : node;
  return extractRange(exportNode);
}
```

- [ ] **Step 2: Route declaration symbols through the selector**

Replace `extractRange(...)` with `extractDeclarationRange(...)` only in:

- `processFunctionDeclaration`
- `processClassDeclaration`
- `processInterfaceDeclaration`
- `processTypeAliasDeclaration`
- every result produced by `processVariableDeclaration`
- `processModule`

Keep `processMethodDefinition`, class/member property extraction, and all other local/member ranges on `extractRange`.

- [ ] **Step 3: Build the current source**

Run:

```powershell
npm run build:all
```

Expected: exit code 0 and updated `dist/indexer/treesitter/extractSymbols.js`.

- [ ] **Step 4: Re-run the focused regressions**

Run:

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/unit/typescript-extract-symbols.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/saved-file-graph-patch.test.ts
```

Expected: both files pass, including complete-range equality after edit and restoration.

### Task 3: Run affected suites and finish

**Files:**
- Verify: `src/indexer/treesitter/extractSymbols.ts`
- Verify: `tests/unit/typescript-extract-symbols.test.ts`
- Verify: `tests/integration/saved-file-graph-patch.test.ts`

- [ ] **Step 1: Run the mapped affected suites**

Run:

```powershell
npm run test:harness
npm run typecheck
npx eslint src/indexer/treesitter/extractSymbols.ts tests/unit/typescript-extract-symbols.test.ts tests/integration/saved-file-graph-patch.test.ts
git diff --check
```

Expected: all commands exit 0. Existing repository lint warnings may remain, but the touched files introduce no new errors.

- [ ] **Step 2: Reproduce the reported symbol directly**

Run:

```powershell
node --input-type=module -e "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; import { TypeScriptAdapter } from './dist/indexer/adapter/typescript.js'; const content = await readFile('src/util/paths.ts', 'utf8'); const adapter = new TypeScriptAdapter(); const tree = adapter.parse(content, 'src/util/paths.ts'); const symbol = tree && adapter.extractSymbols(tree, content, 'src/util/paths.ts').find((entry) => entry.name === 'caseFoldedPathKey'); assert.deepStrictEqual(symbol?.range, { startLine: 34, startCol: 0, endLine: 36, endCol: 1 }); console.log(JSON.stringify(symbol.range));"
```

Expected: exit code 0 and `{"startLine":34,"startCol":0,"endLine":36,"endCol":1}`.

- [ ] **Step 3: Review the final diff and commit**

Run:

```powershell
git status --short
git diff --stat
git diff --check
git add src/indexer/treesitter/extractSymbols.ts tests/unit/typescript-extract-symbols.test.ts tests/integration/saved-file-graph-patch.test.ts docs/superpowers/plans/2026-08-03-exported-declaration-range-normalization.md
git commit -m "fix(indexer): normalize exported declaration ranges"
```

Expected: one focused implementation commit on top of the approved design commit, with no unrelated files.
