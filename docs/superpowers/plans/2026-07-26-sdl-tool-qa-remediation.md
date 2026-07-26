# SDL Tool QA Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four verified SDL-MCP tool-quality regressions while preserving public schemas, deterministic serialization, existing generic context behavior, and exact symbol-resolution semantics.

**Architecture:** Make four surgical changes at their existing shared boundaries: the runtime environment scrubber, the `sdl.info` redaction projection, broad-context final evidence selection, and symbol-reference suggestion recovery. Reuse the current executor, evidence subject keys, exact-mention seeding, named-concept provenance, and structured NOT_FOUND response rather than adding new public options or retrieval paths.

**Tech Stack:** TypeScript ESM, Node.js 24 built-in test runner, SDL-MCP/LadybugDB, Zod schemas, Markdown documentation.

---

## Working Agreement

- Execute from `F:\Claude\projects\sdl-mcp\sdl-mcp\.worktrees\sdl-tool-qa-remediation`.
- Before Task 1 changes, record `git rev-parse HEAD` as `<implementation-base>` in the execution notes; Task 6 uses that exact SHA to inspect the committed implementation range.
- Follow @test-driven-development for every source change.
- Use @systematic-debugging if an expected failing test fails for a different reason.
- Use @verification-before-completion before claiming the remediation is complete.
- Keep `SDL_MCP_DISABLE_NATIVE_ADDON=1` for TypeScript-path verification unless a native-parity command explicitly requires the addon.
- Do not change public tool names, request/response schemas, tool order, log filename generation, broad retrieval sources, graph expansion, or `MIN_FUZZY_AUTO_RESOLVE_SCORE`.

## File Map

| File | Responsibility |
| --- | --- |
| `src/runtime/executor.ts` | Preserve the minimum Windows process environment needed for nested native command resolution. |
| `tests/unit/runtime-executor-env.test.ts` | Lock the scrubbed Windows environment contract. |
| `tests/integration/mcp-runtime-tool.test.ts` | Exercise the real PowerShell runtime handler through `cmd.exe`. |
| `src/mcp/tools/info.ts` | Project full diagnostic info into the path-redacted MCP response. |
| `tests/unit/info-redact-paths.test.ts` | Lock non-null and null logging-path redaction. |
| `tests/integration/mcp-output-schema-wire.test.ts` | Verify `sdl.info` success/error envelopes against the raw MCP output schema. |
| `tests/integration/determinism.fixtures.json` | Add `sdl.info({ redactPaths: true })` to fresh-process byte-stability coverage. |
| `src/agent/context-engine.ts` | Detect the one exact named concept and deterministically narrow only its broad final evidence. |
| `tests/unit/agent/context-engine.test.ts` | Cover the narrowing algorithm, trigger boundaries, ordering, and downstream reference integrity. |
| `tests/unit/agent/context-seeding-runtime.test.ts` | Prove direct exact-name tracking against real LadybugDB rows, including uniqueness, ambiguity, aliases, and fuzzy names. |
| `src/util/resolve-symbol-ref.ts` | Apply one suggestion threshold/cap and build text plus structured recovery from the same set. |
| `tests/unit/resolve-symbol-ref-fuzzy.test.ts` | Cover inclusive score boundaries, cap, and text/structured agreement. |
| `tests/integration/resolve-symbol-ref-recovery.test.ts` | Exercise both production NOT_FOUND paths plus close-typo and auto-resolution behavior against a real graph. |
| `CHANGELOG.md` | Record all four user-visible fixes under Unreleased. |
| `docs/mcp-tools-reference.md` | Document stable info redaction, exact-identifier broad narrowing, and bounded recovery candidates. |
| `docs/prompt-cache-hygiene.md` | Record the stable `"<redacted>"` logging-path contract and determinism fixture. |

## Chunk 1: Runtime and Info Determinism

### Task 1: Preserve Windows `PATHEXT`

**Files:**
- Modify: `src/runtime/executor.ts:64-110`
- Test: `tests/unit/runtime-executor-env.test.ts:1-45`
- Test: `tests/integration/mcp-runtime-tool.test.ts:1-773`

- [ ] **Step 1: Add the failing scrubbed-environment regression**

Add a Windows-only case to `tests/unit/runtime-executor-env.test.ts` that uses noncanonical casing. Node exposes `process.env` case-insensitively on Windows, which is the same lookup behavior the existing `process.env.PATH` access relies on:

```ts
it(
  "preserves PATHEXT case-insensitively for nested native commands on Windows",
  { skip: process.platform !== "win32" },
  () => {
    delete process.env.PATHEXT;
    process.env.PathExt = ".COM;.EXE;.BAT;.CMD";

    const env = buildScrubbedEnv([]);

    assert.strictEqual(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  },
);
```

Keep the existing `beforeEach`/`afterEach` environment restoration. Do not add `SystemRoot`, `ComSpec`, or a synthesized fallback value.

- [ ] **Step 2: Add the failing persisted-artifact PowerShell regression**

Add a Windows-only case near the existing shell/runtime execution cases in `tests/integration/mcp-runtime-tool.test.ts`. Persist the output and inspect it through the production query handler:

```ts
it(
  "persists nested native-command output from PowerShell",
  { skip: process.platform !== "win32" },
  async () => {
    const { handleRuntimeExecute } =
      await import("../../dist/mcp/tools/runtime.js");
    const { handleRuntimeQueryOutput } =
      await import("../../dist/mcp/tools/runtime-query.js");

    const run = await handleRuntimeExecute({
      repoId,
      runtime: "powershell",
      code: [
        "& cmd.exe /c echo SDL_NATIVE_OK",
        'Write-Output "EXIT:$LASTEXITCODE"',
      ].join("\n"),
      persistOutput: true,
      outputMode: "minimal",
    });

    assert.equal(run.status, "success");
    assert.ok(run.artifactHandle);

    const query = await handleRuntimeQueryOutput({
      repoId,
      artifactHandle: run.artifactHandle,
      queryTerms: ["SDL_NATIVE_OK", "EXIT:0"],
      contextLines: 0,
      maxExcerpts: 2,
      stream: "stdout",
    });

    assert.equal(query.matchStatus, "matched");
    assert.ok(query.excerpts);
    assert.deepEqual(
      query.excerpts.map(({ content }) => content.replace(/\r$/, "")),
      ["SDL_NATIVE_OK", "EXIT:0"],
    );
  },
);
```

- [ ] **Step 3: Run the focused tests and verify the Windows failure**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/runtime-executor-env.test.ts tests/integration/mcp-runtime-tool.test.ts
```

Expected on Windows: FAIL because `buildScrubbedEnv([]).PATHEXT` is undefined and the nested `cmd.exe` output/exit code is missing. Expected on non-Windows: the two new cases are skipped and the existing cases pass.

- [ ] **Step 4: Implement the one-variable environment fix**

In the existing `IS_WINDOWS` branch of `buildScrubbedEnv()`, copy the parent value only when present:

```ts
if (IS_WINDOWS) {
  const home = process.env.USERPROFILE;
  const temp = process.env.TEMP;
  const pathExt = process.env.PATHEXT;
  if (home) {
    env.USERPROFILE = home;
  }
  if (temp) {
    env.TEMP = temp;
  }
  if (pathExt) {
    env.PATHEXT = pathExt;
  }
}
```

Do not wrap PowerShell commands or broaden the scrubbed environment beyond this reproduced requirement.

- [ ] **Step 5: Rebuild and verify the runtime regressions pass**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/runtime-executor-env.test.ts tests/integration/mcp-runtime-tool.test.ts
```

Expected: PASS with zero failures; the native-command case is executed on Windows and skipped elsewhere.

- [ ] **Step 6: Commit the runtime fix**

```powershell
git add src/runtime/executor.ts tests/unit/runtime-executor-env.test.ts tests/integration/mcp-runtime-tool.test.ts
git commit -m "fix: preserve Windows native command resolution"
```

### Task 2: Make redacted `sdl.info` process-stable

**Files:**
- Modify: `src/mcp/tools/info.ts:25-41`
- Test: `tests/unit/info-redact-paths.test.ts:1-51`
- Modify: `tests/integration/determinism.fixtures.json:9-120`

- [ ] **Step 1: Expose the existing pure projection without changing behavior**

Change only the declaration in `src/mcp/tools/info.ts`:

```ts
export function redactInfoPaths(report: InfoReport): InfoReport {
```

Run the unchanged regression to prove this preparatory test seam is behavior-neutral:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/info-redact-paths.test.ts
```

Expected: PASS. Do not alter redaction behavior in this step.

- [ ] **Step 2: Write the failing non-null and null redaction regressions**

Import the projection:

```ts
import {
  handleInfo,
  redactInfoPaths,
} from "../../dist/mcp/tools/info.js";
```

Change the existing logging-path assertion to expect `"<redacted>"` when the collected path is non-null, then add synthetic reports so both branches are exercised regardless of ambient logger configuration:

```ts
it("uses a stable placeholder for a non-null log path", async () => {
  const full = await handleInfo();
  const withFileLogging = {
    ...full,
    logging: {
      ...full.logging,
      path: "C:\\logs\\sdl-mcp-2026-07-26-1234.log",
    },
  };

  assert.equal(redactInfoPaths(withFileLogging).logging.path, "<redacted>");
});

it("preserves null when file logging is disabled", async () => {
  const full = await handleInfo();
  const withoutFileLogging = {
    ...full,
    logging: { ...full.logging, path: null },
  };

  assert.equal(redactInfoPaths(withoutFileLogging).logging.path, null);
});
```

Keep the existing assertions that config, LadybugDB, and native-addon paths use basenames and that non-path fields are unchanged.

- [ ] **Step 3: Put `sdl.info` under the fresh-process determinism fixture**

Add this stable call to `toolCalls` in `tests/integration/determinism.fixtures.json`:

```json
{
  "tool": "sdl.info",
  "args": {
    "redactPaths": true
  }
}
```

Remove only the existing `sdl.info` entry from `uncoveredAllowlist`.

- [ ] **Step 4: Run the tests and verify the exact behavioral failure**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/info-redact-paths.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts
```

Expected: the unit test reaches its assertions and fails because the synthetic non-null log path is reduced to its basename instead of `"<redacted>"`; the determinism test reports a fresh-process mismatch in `sdl.info.logging.path`.

- [ ] **Step 5: Implement the stable redaction projection**

Leave object key order unchanged and special-case only the logging path:

```ts
export function redactInfoPaths(report: InfoReport): InfoReport {
  const redact = (p: string | null): string | null =>
    p === null ? null : basename(p);
  return {
    ...report,
    config: { ...report.config, path: basename(report.config.path) },
    logging: {
      ...report.logging,
      path: report.logging.path === null ? null : "<redacted>",
    },
    ladybug: {
      ...report.ladybug,
      activePath: redact(report.ladybug.activePath),
    },
    native: {
      ...report.native,
      sourcePath: redact(report.native.sourcePath),
    },
  };
}
```

Do not change `collectInfoReport()`, log naming, response fields, or the basename behavior of other paths.

- [ ] **Step 6: Rebuild and verify unit plus fresh-process contracts**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/info-redact-paths.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/determinism.test.ts
```

Expected: both commands PASS; the literal placeholder is used for non-null logging, null is preserved, and `sdl.info({ redactPaths: true })` is byte-stable across the fresh-process leg.

- [ ] **Step 7: Commit the info determinism fix**

```powershell
git add src/mcp/tools/info.ts tests/unit/info-redact-paths.test.ts tests/integration/determinism.fixtures.json
git commit -m "fix: stabilize redacted info logging paths"
```

## Chunk 2: Context Relevance and Symbol Recovery

### Task 3: Narrow broad evidence for one exact named concept

**Files:**
- Modify: `src/agent/context-engine.ts:160-197,460-467,579-986,1443-1497`
- Test: `tests/unit/agent/context-engine.test.ts:911-1040` (place beside the existing exact-code evidence tests)
- Test: `tests/unit/agent/context-seeding-runtime.test.ts:130-735`

- [ ] **Step 1: Add the failing production-shaped narrowing regression**

Add a broad-mode test with this evidence order:

```ts
const exactRef = "symbol:ExactTarget";
const evidence: Evidence[] = [
  {
    type: "searchResult",
    reference: "search:kept",
    summary: "Search result",
    timestamp: 1,
  },
  {
    type: "symbolCard",
    reference: "symbol:secondary-a",
    summary: "Secondary A card",
    timestamp: 2,
  },
  {
    type: "symbolCard",
    reference: exactRef,
    summary: "Exact target card",
    timestamp: 3,
  },
  {
    type: "skeleton",
    reference: "symbol:secondary-a",
    summary: "Secondary A skeleton",
    timestamp: 4,
  },
  {
    type: "hotPath",
    reference: "hotpath:secondary-a",
    summary: "Hot path (0 matches, adjacent context only)",
    timestamp: 4.5,
  },
  {
    type: "diagnostic",
    reference: "diagnostic:kept",
    summary: "Diagnostic result",
    timestamp: 5,
  },
  {
    type: "hotPath",
    reference: "hotpath:ExactTarget",
    summary: "Exact target hot path (1 matches)",
    timestamp: 6,
  },
  {
    type: "skeleton",
    reference: "symbol:secondary-b",
    summary: "Secondary B skeleton",
    timestamp: 7,
  },
  {
    type: "symbolCard",
    reference: "symbol:card-only",
    summary: "Unrelated card-only evidence",
    timestamp: 8,
  },
  {
    type: "hotPath",
    reference: "hotpath:secondary-c",
    summary: "Secondary C hot path (1 matches)",
    timestamp: 9,
  },
  {
    type: "symbolCard",
    reference: "symbol:secondary-b",
    summary: "Secondary B card",
    timestamp: 10,
  },
  {
    type: "hotPath",
    reference: "hotpath:secondary-d",
    summary: "Hot path (0 matches, adjacent context only)",
    timestamp: 11,
  },
];
```

Use the existing `Planner`/`Executor` mocks. Make exact seeding return `exactRef`, populate the new direct-exact tracking set, and return named-concept provenance from `seedContext`:

```ts
mock.method(
  ContextEngine.prototype as Record<string, unknown>,
  "seedExactMentionedSymbols",
  async (
    _task: AgentTask,
    mentioned: string[],
    directExactRefs?: Set<string>,
  ) => {
    assert.deepEqual(mentioned, ["ExactTarget"]);
    directExactRefs?.add(exactRef);
    return [exactRef];
  },
);
mock.method(
  ContextEngine.prototype as Record<string, unknown>,
  "seedContext",
  async (): Promise<ContextSeedResult> => ({
    candidates: [
      {
        contextRef: exactRef,
        source: "lexical",
        score: 1,
        sourceRank: 0,
        expansionReason: "namedConcept",
      },
    ],
    sources: { semantic: 0, lexical: 1, feedback: 0 },
  }),
);
```

Build with:

```ts
const result = await new ContextEngine().buildContext(
  createTask({
    taskType: "explain",
    taskText: "Explain ExactTarget",
    options: {
      contextMode: "broad",
      semantic: false,
      inferredFocusPaths: ["src/inferred-hint.ts"],
    },
  }),
);
```

The positive case deliberately includes `inferredFocusPaths` to prove inferred hints do not disable narrowing.

Assert the stable partition and absence of dangling model-facing references:

```ts
assert.deepEqual(
  result.finalEvidence.map(({ reference }) => reference),
  [
    "symbol:ExactTarget",
    "hotpath:ExactTarget",
    "symbol:secondary-a",
    "symbol:secondary-a",
    "hotpath:secondary-a",
    "symbol:secondary-b",
    "symbol:secondary-b",
    "search:kept",
    "diagnostic:kept",
  ],
);
const serialized = JSON.stringify(result);
assert.doesNotMatch(serialized, /card-only|secondary-c|secondary-d/);
```

The duplicate subject references above are intentional: card and rich evidence for one subject share a subject key but remain distinct evidence items in original relative order.

- [ ] **Step 2: Add trigger-boundary regressions**

Using the same small `Planner`/`Executor` fixture, add table-driven companion cases and assert the original evidence array is unchanged for each:

```ts
const unchangedCases = [
  {
    name: "generic text",
    task: createTask({
      taskText: "Explain the runtime architecture",
      options: { contextMode: "broad", semantic: false },
    }),
    directExactRefs: [exactRef],
    namedConcept: true,
  },
  {
    name: "multiple high-signal identifiers",
    task: createTask({
      taskText: "Compare ExactTarget and OtherTarget",
      options: { contextMode: "broad", semantic: false },
    }),
    directExactRefs: [exactRef],
    namedConcept: true,
  },
  {
    name: "explicit focus",
    task: createTask({
      taskText: "Explain ExactTarget",
      options: {
        contextMode: "broad",
        semantic: false,
        focusSymbols: ["ExactTarget"],
      },
    }),
    directExactRefs: [exactRef],
    namedConcept: true,
  },
  {
    name: "explicit focus path",
    task: createTask({
      taskText: "Explain ExactTarget",
      options: {
        contextMode: "broad",
        semantic: false,
        focusPaths: ["src/target.ts"],
      },
    }),
    directExactRefs: [exactRef],
    namedConcept: true,
  },
  {
    name: "precise mode",
    task: createTask({
      taskText: "Explain ExactTarget",
      options: { contextMode: "precise", semantic: false },
    }),
    directExactRefs: [exactRef],
    namedConcept: true,
  },
  {
    name: "fuzzy or ambiguous resolution only",
    task: createTask({
      taskText: "Explain ExactTarget",
      options: { contextMode: "broad", semantic: false },
    }),
    directExactRefs: [],
    namedConcept: true,
  },
  {
    name: "missing named-concept provenance",
    task: createTask({
      taskText: "Explain ExactTarget",
      options: { contextMode: "broad", semantic: false },
    }),
    directExactRefs: [exactRef],
    namedConcept: false,
  },
];
```

For each row, have `seedContext` emit `expansionReason: "namedConcept"` only when `namedConcept` is true, populate only the listed `directExactRefs`, execute the engine, and assert `result.finalEvidence` retains the original reference order. Add one final case where all other trigger conditions pass but the exact subject has only a card and no non-zero rich evidence; it must also remain unchanged.

- [ ] **Step 3: Add real LadybugDB uniqueness and alias-boundary regressions**

In `tests/unit/agent/context-seeding-runtime.test.ts`, reuse the existing `file-quasar`, connection, and `queries.upsertSymbol()` setup. Add these five exact-name fixture rows with the same remaining `SymbolRow` fields as the surrounding Quasar rows:

```ts
const exactSeedRows = [
  ["exact-unique", "UniqueExactTarget"],
  ["exact-duplicate-a", "DuplicateExactTarget"],
  ["exact-duplicate-b", "DuplicateExactTarget"],
  ["exact-alias", "handleAliasTarget"],
  ["exact-fuzzy-neighbor", "FuzzyExactTarget"],
] as const;
for (const [symbolId, name] of exactSeedRows) {
  await queries.upsertSymbol(conn, {
    symbolId,
    repoId: REPO_ID,
    fileId: "file-quasar",
    kind: "function",
    name,
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 2,
    rangeEndCol: 1,
    astFingerprint: `fp-${symbolId}`,
    signatureJson: JSON.stringify({ text: `function ${name}(): void` }),
    summary: `${name} fixture`,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}
```

Add a typed private-method harness in the test only:

```ts
type ExactSeedHarness = {
  seedExactMentionedSymbols(
    task: AgentTask,
    mentioned?: string[],
    directExactRefs?: Set<string>,
  ): Promise<string[]>;
};
const seedExact = (
  engine: InstanceType<typeof ContextEngineClass>,
  task: AgentTask,
  mentioned: string[],
  directExactRefs: Set<string>,
) =>
  (engine as unknown as ExactSeedHarness).seedExactMentionedSymbols(
    task,
    mentioned,
    directExactRefs,
  );
```

Then exercise production queries rather than mocking the set:

```ts
it("tracks only one unique direct exact-name resolution", async () => {
  const engine = new ContextEngineClass();

  const unique = new Set<string>();
  const uniqueRefs = await seedExact(
    engine,
    { ...task(false), taskText: "Explain UniqueExactTarget" },
    ["UniqueExactTarget"],
    unique,
  );
  assert.deepEqual([...unique], ["symbol:exact-unique"]);
  assert.ok(uniqueRefs.includes("symbol:exact-unique"));

  const duplicate = new Set<string>();
  await seedExact(
    engine,
    { ...task(false), taskText: "Explain DuplicateExactTarget" },
    ["DuplicateExactTarget"],
    duplicate,
  );
  assert.deepEqual([...duplicate], []);

  const alias = new Set<string>();
  const aliasRefs = await seedExact(
    engine,
    { ...task(false), taskText: "Implement AliasTarget" },
    ["AliasTarget"],
    alias,
  );
  assert.deepEqual([...alias], []);
  assert.ok(aliasRefs.includes("symbol:exact-alias"));

  const fuzzy = new Set<string>();
  await seedExact(
    engine,
    { ...task(false), taskText: "Explain FuzzyExactTargot" },
    ["FuzzyExactTargot"],
    fuzzy,
  );
  assert.deepEqual([...fuzzy], []);
});
```

This proves uniqueness through the real exact query capped at two rows. Alias-derived and close fuzzy inputs leave the direct-exact set empty without changing their existing seed behavior.

- [ ] **Step 4: Run the focused tests and verify the intended red state**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/agent/context-engine.test.ts tests/unit/agent/context-seeding-runtime.test.ts
```

Expected: FAIL because the exact broad response still retains `card-only`, `secondary-c`, and `secondary-d`, exact evidence is not stably partitioned first, and `seedExactMentionedSymbols` has neither the new optional arguments nor the real-query uniqueness tracking. Existing generic/focused tests should remain green.

- [ ] **Step 5: Reuse the existing task-text identifier extraction**

Move the current code-quoted plus high-signal extraction from `seedExactMentionedSymbols()` into one top-level helper and call it from the seed method:

```ts
function extractExactMentionedIdentifiers(taskText: string): string[] {
  const codeQuoted =
    taskText
      .match(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)
      ?.map((match) => match.slice(1, -1)) ?? [];
  const extracted = extractIdentifiersFromText(taskText, taskText).filter(
    (identifier) =>
      isLikelyExactSymbolMention(identifier) && taskText.includes(identifier),
  );
  return [...new Set([...codeQuoted, ...extracted])];
}
```

Do not add another parser or broaden what counts as high signal.

- [ ] **Step 6: Track exactly one unambiguous direct-name resolution without changing the seed return type**

Extend the private method with optional internal inputs so its nine existing array-returning mocks remain valid:

```ts
private async seedExactMentionedSymbols(
  task: AgentTask,
  mentioned = extractExactMentionedIdentifiers(task.taskText),
  directExactRefs?: Set<string>,
): Promise<string[]> {
```

Remove the duplicated local extraction. When there is exactly one task-text identifier and the loop reaches that original name (not an implementation alias), reuse `findRetrievalSeedSymbolsByName(..., "exact")`. Its exact Cypher predicate returns at most two rows, so one row proves uniqueness and two rows prove ambiguity without an exhaustive fuzzy scan. Inferred paths must not disable the trigger; caller-provided focus is handled separately by `hasExplicitScope`:

```ts
if (
  directExactRefs &&
  mentioned.length === 1 &&
  name === mentioned[0]
) {
  const exactRows = await ladybugDb.findRetrievalSeedSymbolsByName(
    conn,
    task.repoId,
    name,
    "exact",
  );
  if (exactRows.length === 1) {
    directExactRefs.add(`symbol:${exactRows[0].symbolId}`);
  }
}
row ??= await ladybugDb.findSymbolByExactName(conn, task.repoId, name);
```

Multiple exact-name rows, zero direct rows, implementation aliases, and fuzzy candidates leave `directExactRefs` empty. Existing exact seeding still proceeds through `findSymbolByExactName()` so behavior outside the new narrow trigger is unchanged.

- [ ] **Step 7: Add the deterministic evidence narrowing helper**

Place this beside `pruneTrailingCardNoise()` and reuse `evidenceSubjectKey()` plus `isZeroMatchHotPathEvidence()`:

```ts
function narrowSingleExactIdentifierEvidence(
  evidence: Evidence[],
  exactReference: string,
): Evidence[] {
  const exactSubject = evidenceSubjectKey(exactReference);
  if (!exactSubject) return evidence;

  const isSymbolEvidence = (item: Evidence): boolean =>
    item.type === "symbolCard" ||
    item.type === "skeleton" ||
    item.type === "hotPath";
  const isRichEvidence = (item: Evidence): boolean =>
    (item.type === "skeleton" || item.type === "hotPath") &&
    !isZeroMatchHotPathEvidence(item);

  if (
    !evidence.some(
      (item) =>
        isRichEvidence(item) &&
        evidenceSubjectKey(item.reference) === exactSubject,
    )
  ) {
    return evidence;
  }

  const secondarySubjects = new Set<string>();
  for (const item of evidence) {
    if (!isRichEvidence(item)) continue;
    const subject = evidenceSubjectKey(item.reference);
    if (!subject || subject === exactSubject || secondarySubjects.has(subject)) {
      continue;
    }
    if (secondarySubjects.size === 2) break;
    secondarySubjects.add(subject);
  }

  const exact: Evidence[] = [];
  const secondary: Evidence[] = [];
  const other: Evidence[] = [];
  for (const item of evidence) {
    if (!isSymbolEvidence(item)) {
      other.push(item);
      continue;
    }
    const subject = evidenceSubjectKey(item.reference);
    if (subject === exactSubject) exact.push(item);
    else if (subject && secondarySubjects.has(subject)) secondary.push(item);
  }
  return [...exact, ...secondary, ...other];
}
```

This intentionally drops symbol evidence with an unknown/unselected subject while retaining every non-symbol evidence kind.

- [ ] **Step 8: Apply the helper only at the approved broad trigger**

Before exact seeding, compute the extracted identifiers and create a direct-ref set. Pass both into `seedExactMentionedSymbols()`:

```ts
const exactMentionedIdentifiers = extractExactMentionedIdentifiers(
  task.taskText,
);
const directExactMentionRefs = new Set<string>();
```

After execution and before `optimizeEvidenceForResponse()`, require all trigger conditions:

```ts
const exactReference =
  !isPrecise &&
  !hasExplicitScope &&
  exactMentionedIdentifiers.length === 1 &&
  directExactMentionRefs.size === 1
    ? [...directExactMentionRefs][0]
    : undefined;
const hasNamedConceptProvenance =
  exactReference !== undefined &&
  seedCandidates.some(
    (candidate) =>
      candidate.contextRef === exactReference &&
      candidate.expansionReason === "namedConcept",
  );
const responseEvidence =
  exactReference && hasNamedConceptProvenance
    ? narrowSingleExactIdentifierEvidence(evidence, exactReference)
    : evidence;
const optimizedEvidence = optimizeEvidenceForResponse(
  responseEvidence,
  finalEvidenceOptimization,
  task.budget?.maxTokens,
);
```

Because `projectActionsToEvidence()` already runs after optimization, filtered evidence cannot remain referenced by projected actions, summary, or answer. Passing the narrowed array before `finalizeContextResult()` also makes the explicit exact identifier supersede inferred protected refs only inside this trigger.

- [ ] **Step 9: Rebuild and verify all context regressions**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/agent/context-engine.test.ts tests/unit/agent/context-seeding-runtime.test.ts
```

Expected: PASS. The exact case keeps the target, first two rich secondary subjects, and non-symbol evidence in deterministic partitions; every exclusion case retains its prior evidence order.

- [ ] **Step 10: Commit the context relevance fix**

```powershell
git add src/agent/context-engine.ts tests/unit/agent/context-engine.test.ts tests/unit/agent/context-seeding-runtime.test.ts
git commit -m "fix: narrow exact-identifier broad context evidence"
```

### Task 4: Bound missing-symbol suggestions

**Files:**
- Modify: `src/util/resolve-symbol-ref.ts:55-209`
- Test: `tests/unit/resolve-symbol-ref-fuzzy.test.ts:1-88`
- Create: `tests/integration/resolve-symbol-ref-recovery.test.ts`

- [ ] **Step 1: Write the failing inclusive-threshold and cap regressions**

Import the new shared recovery helper from `../../dist/util/resolve-symbol-ref.js`. Add a small candidate factory and two tests:

```ts
const candidate = (name: string, score: number) => ({
  symbolId: `id-${name}`,
  name,
  file: `src/${name}.ts`,
  kind: "function",
  exported: true,
  score,
});

it("uses an inclusive 0.35 suggestion threshold", () => {
  const recovery = buildSymbolRefSuggestionRecovery([
    candidate("Below", 0.34),
    candidate("At", 0.35),
    candidate("Above", 0.36),
  ]);

  assert.deepStrictEqual(
    recovery.candidates.map(({ name, score }) => ({ name, score })),
    [
      { name: "Above", score: 0.36 },
      { name: "At", score: 0.35 },
    ],
  );
  assert.strictEqual(
    recovery.hint,
    ' Did you mean: "Above" (src/Above.ts), "At" (src/At.ts)?',
  );
});

it("returns no more than three suggestions in text and structured data", () => {
  const recovery = buildSymbolRefSuggestionRecovery([
    candidate("First", 0.9),
    candidate("Second", 0.8),
    candidate("Third", 0.7),
    candidate("Fourth", 0.6),
  ]);

  assert.deepStrictEqual(
    recovery.candidates.map(({ name }) => name),
    ["First", "Second", "Third"],
  );
  assert.match(recovery.hint, /First.*Second.*Third/);
  assert.doesNotMatch(recovery.hint, /Fourth/);
});
```

- [ ] **Step 2: Add branch-driving and real-graph resolver regressions**

In `tests/unit/resolve-symbol-ref-fuzzy.test.ts`, add a query-aware fake connection that drives only the initial-search-empty branch. Reuse the repository's existing `FakeQueryResult` shape (`getAll()` plus `close()`); no production test seam is needed:

```ts
class FakeQueryResult {
  private readonly rows: Record<string, unknown>[];
  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }
  async getAll(): Promise<Record<string, unknown>[]> {
    return this.rows;
  }
  close(): void {}
}

function createFallbackOnlyConnection(): {
  conn: import("kuzu").Connection;
  observedQueries: string[];
} {
  const observedQueries: string[] = [];
  const names = [
    "A1BMissingOne",
    "A1BMissingTwo",
    "A1BMissingThree",
    "A1BMissingFour",
    "A1BMissingFive",
  ];
  const symbolRows = names.map((name, index) => ({
    symbolId: `symbol-fallback-${index}`,
    name,
    fileId: "file-fallback",
    file: "src/fallback.ts",
    kind: "function",
    exported: true,
  }));
  const fileRows = [{
    fileId: "file-fallback",
    repoId: "resolver-fake",
    relPath: "src/fallback.ts",
    contentHash: "hash",
    language: "typescript",
    byteSize: 1,
    lastIndexedAt: null,
    directory: "src",
  }];

  const conn = {
    async prepare(statement: string) {
      return {
        statement,
        isSuccess: () => true,
        getErrorMessage: () => "",
      };
    },
    async execute(
      _prepared: { statement: string },
      params: Record<string, unknown> = {},
    ) {
      if (Array.isArray(params.fileIds)) {
        return new FakeQueryResult(fileRows);
      }
      const query = String(params.query ?? "");
      observedQueries.push(query);
      const isFallbackQuery =
        observedQueries.length > 4 &&
        ["a", "1", "b"].includes(query.toLowerCase());
      return new FakeQueryResult(isFallbackQuery ? symbolRows : []);
    },
  } as unknown as import("kuzu").Connection;
  return { conn, observedQueries };
}
```

The first four DB queries are the initial search and return empty. The fallback's `a1b` subword is split again into `a`, `1`, and `b`, which the later phase maps to five strong rows; its remaining `missing` query stays empty. Assert the exact sequence as well as the new cap, threshold, and message contract:

```ts
it("routes initial-search-empty recovery through the shared policy", async () => {
  const harness = createFallbackOnlyConnection();
  const result = await resolveSymbolRef(harness.conn, "resolver-fake", {
    name: "A1BMissing",
  });

  assert.deepEqual(harness.observedQueries, [
    "A",
    "1",
    "B",
    "Missing",
    "a",
    "1",
    "b",
    "missing",
  ]);
  assert.equal(result.status, "not_found");
  if (result.status !== "not_found") return;

  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every(({ score }) => score >= 0.35));
  const expectedHint = ` Did you mean: ${result.candidates
    .map(({ name, file }) => `"${name}" (${file})`)
    .join(", ")}?`;
  assert.ok(result.message.endsWith(expectedHint));
});
```

Create `tests/integration/resolve-symbol-ref-recovery.test.ts` using the temp LadybugDB lifecycle from `tests/unit/agent/context-seeding-runtime.test.ts`: save/restore `SDL_CONFIG` and `SDL_GRAPH_DB_PATH`, initialize a process-unique DB, upsert one repo, one file at `src/handler.ts`, and one exported TypeScript function named `handleRequest` (`symbol-handle-request`), then close and delete temp files in `after()`.

Import `resolveSymbolRef` and `searchSymbolsWithOverlay`. Keep text verification tied exactly to structured candidates:

```ts
function suggestionNames(
  result: Extract<Awaited<ReturnType<typeof resolveSymbolRef>>, {
    status: "not_found";
  }>,
): string[] {
  return result.candidates.map(({ name }) => name);
}

function assertHintMatchesCandidates(
  result: Extract<Awaited<ReturnType<typeof resolveSymbolRef>>, {
    status: "not_found";
  }>,
): void {
  const expectedHint =
    result.candidates.length === 0
      ? ""
      : ` Did you mean: ${result.candidates
          .map(({ name, file }) => `"${name}" (${file})`)
          .join(", ")}?`;
  assert.equal(result.message.includes("Did you mean:"), expectedHint.length > 0);
  if (expectedHint) assert.ok(result.message.endsWith(expectedHint));
}
```

Prove the close typo enters the second `ranked.length === 0` branch by first showing that the initial search returned rows:

```ts
it("keeps a strong close-typo candidate after ranking removes every row", async () => {
  const name = "handleReqeust";
  const initialRows = await searchSymbolsWithOverlay(conn, REPO_ID, name, 50);
  assert.ok(initialRows.length > 0);

  const result = await resolveSymbolRef(conn, REPO_ID, { name });
  assert.equal(result.status, "not_found");
  if (result.status !== "not_found") return;

  assert.ok(result.candidates.length <= 3);
  assert.ok(result.candidates.every(({ score }) => score >= 0.35));
  assert.ok(suggestionNames(result).includes("handleRequest"));
  assertHintMatchesCandidates(result);
});

it("omits irrelevant recovery candidates and hint text", async () => {
  const result = await resolveSymbolRef(conn, REPO_ID, {
    name: "zzzzNoMatchxxxx",
  });
  assert.equal(result.status, "not_found");
  if (result.status !== "not_found") return;
  assert.deepEqual(result.candidates, []);
  assertHintMatchesCandidates(result);
});
```

Finally lock existing auto-resolution. A prefix name is non-strict, while exact file, kind, and exported qualifiers make its existing score `40 + 75 + 10 + 5 = 130`, above the unchanged threshold of 120:

```ts
it("preserves high-confidence fuzzy auto-resolution", async () => {
  const result = await resolveSymbolRef(conn, REPO_ID, {
    name: "handleReq",
    file: "src/handler.ts",
    kind: "function",
    exportedOnly: true,
  });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.symbolId, "symbol-handle-request");
  }
});
```

- [ ] **Step 3: Run the focused tests and verify the red state**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/resolve-symbol-ref-fuzzy.test.ts tests/integration/resolve-symbol-ref-recovery.test.ts
```

Expected: FAIL because `buildSymbolRefSuggestionRecovery` does not exist, both NOT_FOUND branches still expose candidates below `0.35` or beyond the shared cap, and the irrelevant query can still produce recovery noise. The high-confidence auto-resolution case remains green.

- [ ] **Step 4: Implement one shared recovery policy**

Add only these fixed internal policy constants and helper:

```ts
const MIN_SYMBOL_REF_SUGGESTION_SCORE = 0.35;
const MAX_SYMBOL_REF_SUGGESTIONS = 3;

export function buildSymbolRefSuggestionRecovery(
  candidates: SymbolRefCandidate[],
): { candidates: SymbolRefCandidate[]; hint: string } {
  const suggestions = candidates
    .filter((candidate) => candidate.score >= MIN_SYMBOL_REF_SUGGESTION_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SYMBOL_REF_SUGGESTIONS);
  return {
    candidates: suggestions,
    hint:
      suggestions.length === 0
        ? ""
        : ` Did you mean: ${suggestions
            .map(({ name, file }) => `"${name}" (${file})`)
            .join(", ")}?`,
  };
}
```

Keep the constants private; export only the pure helper used by focused tests.

- [ ] **Step 5: Route both NOT_FOUND branches through the same set**

Let `fuzzySearchCandidates()` return its scored, sorted rows without the old `>= 0.15` filter or `.slice(0, 5)`. In the `rows.length === 0` branch:

```ts
const recovery = buildSymbolRefSuggestionRecovery(
  await fuzzySearchCandidates(conn, repoId, symbolRef.name, SEARCH_LIMIT),
);
return {
  status: "not_found",
  message: `No symbol matching "${symbolRef.name}" was found in repo "${repoId}".${recovery.hint}`,
  candidates: recovery.candidates,
};
```

In the `ranked.length === 0` branch, pass the mapped relevance candidates to the same helper and return `recovery.hint` plus `recovery.candidates`. Remove the old `>= 0.1`, both `.slice(0, 5)` calls, and both duplicated `fuzzyCandidates.slice(0, 3)` message formatters.

Do not change `strictMatches`, `MIN_FUZZY_AUTO_RESOLVE_SCORE`, `MIN_FUZZY_SCORE_GAP`, ambiguity results, or `resolved()`.

- [ ] **Step 6: Rebuild and verify suggestion recovery**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/resolve-symbol-ref-fuzzy.test.ts tests/integration/resolve-symbol-ref-recovery.test.ts
```

Expected: PASS. Scores below `0.35` are absent, exactly `0.35` is retained, no more than three entries are returned, both NOT_FOUND branches use the same candidates in text and structured data, irrelevant queries stay empty, close typos keep a strong candidate, and high-confidence fuzzy auto-resolution is unchanged.

- [ ] **Step 7: Commit the suggestion fix**

```powershell
git add src/util/resolve-symbol-ref.ts tests/unit/resolve-symbol-ref-fuzzy.test.ts tests/integration/resolve-symbol-ref-recovery.test.ts
git commit -m "fix: bound missing-symbol suggestions"
```


## Chunk 3: Documentation and Final Verification

### Task 5: Document the repaired contracts

**Files:**
- Modify: `CHANGELOG.md:8-63`
- Modify: `docs/mcp-tools-reference.md:37-51,446-467,947-1005`
- Modify: `docs/prompt-cache-hygiene.md:19-25,47-55`

- [ ] **Step 1: Update the Unreleased changelog**

Under the first `## [Unreleased]` → `### Fixed`, add one scoped bullet rather than four repetitive entries:

```md
- **SDL tool QA reliability**: Windows PowerShell runtimes preserve the parent `PATHEXT` needed by nested native commands; path-redacted `sdl.info` responses use a process-stable logging placeholder; broad context for one uniquely resolved named concept prioritizes its rich evidence plus up to two secondary subjects; and missing natural-symbol references return at most three suggestions scoring at least `0.35`.
```

- [ ] **Step 2: Update the public MCP tool reference**

Replace `sdl.info`'s stale “Parameters: none” line with:

```md
**Parameters:**

| Parameter     | Type      | Required | Description |
| ------------- | --------- | -------- | ----------- |
| `redactPaths` | `boolean` | No       | Redact machine-specific paths from the response. |

With `redactPaths: true`, config, LadybugDB, and native-addon paths are reduced to basenames; a non-null `logging.path` becomes the literal `"<redacted>"`, while disabled file logging remains `null`.
```

After the existing natural-reference recovery paragraph under `sdl.symbol.getCard`, add:

```md
For missing natural references, recovery candidates use an inclusive minimum score of `0.35` and are capped at three. The human-readable “Did you mean” text and structured `candidates` are generated from the same ordered set. These recovery bounds apply anywhere the shared natural-symbol resolver is used; exact and high-confidence auto-resolution thresholds are unchanged.
```

After the broad/precise response paragraphs under `sdl.context`, add:

```md
In broad mode, a task that names exactly one high-signal identifier can use a narrower deterministic evidence projection when that name resolves uniquely by exact symbol name, carries named-concept retrieval provenance, and the caller supplied no explicit `focusSymbols` or `focusPaths`. The projection places all `symbolCard`, `skeleton`, and `hotPath` evidence for the exact subject first, then the same symbol-shaped evidence for up to two secondary subjects selected by a skeleton or non-zero-match hot path, then every non-symbol evidence item; relative order within each partition is preserved. A zero-match hot path cannot select a subject but remains when another rich item selected that subject. Generic text, multiple identifiers, explicit caller focus, ambiguous/fuzzy-only matches, and exact subjects without rich evidence keep the existing broad response.
```

Do not add a public `PATHEXT` option, schema field, migration note, or configuration section.

- [ ] **Step 3: Update prompt-cache hygiene documentation**

Extend “No volatile content in deterministic projections” with this concrete stable-redaction rule:

```md
For `sdl.info({ redactPaths: true })`, a configured log-file path is projected as the literal `"<redacted>"` and disabled file logging remains `null`; no per-process log filename survives. The call is covered by the fresh-process determinism fixture.
```

- [ ] **Step 4: Run documentation checks**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run docs:tools:check
```

Expected: PASS. The manually maintained tool reference remains consistent with generated tool/workflow inventories.

- [ ] **Step 5: Commit the documentation**

```powershell
git add CHANGELOG.md docs/mcp-tools-reference.md docs/prompt-cache-hygiene.md
git commit -m "docs: record SDL tool QA contracts"
```

### Task 6: Verify the complete remediation

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Build and run the focused regression set**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run build:all
node --experimental-strip-types --test --test-concurrency=1 tests/unit/runtime-executor-env.test.ts tests/integration/mcp-runtime-tool.test.ts tests/unit/info-redact-paths.test.ts tests/integration/mcp-output-schema-wire.test.ts tests/integration/determinism.test.ts tests/unit/agent/context-engine.test.ts tests/unit/agent/context-seeding-runtime.test.ts tests/unit/resolve-symbol-ref-fuzzy.test.ts tests/integration/resolve-symbol-ref-recovery.test.ts
```

Expected: PASS with zero failures. On Windows the PATHEXT/native-command cases execute; on other platforms those two cases skip without hiding failures in the remaining set.

- [ ] **Step 2: Run static and documentation gates**

Run each command separately so a failure is attributable:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run typecheck
npm run lint
npm run docs:tools:check
```

Expected: all three PASS with exit code 0.

- [ ] **Step 3: Run golden and full-suite gates**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
npm run test:golden
npm test
```

Expected: both PASS. Do not update goldens unless a reviewed expected-output mismatch proves that an intentional contract change is missing from the checked-in snapshot; no public schema or tool-order change is expected.

- [ ] **Step 4: Create a self-contained worktree-server live probe**

Do not use the already-connected SDL tools. Use `apply_patch` to create the untracked temporary file `scripts/.tmp-sdl-qa-live-probe.mjs` with this complete script:

```js
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WORKTREE_ROOT = realpathSync(process.cwd());
const SERVER_ENTRY = join(WORKTREE_ROOT, "dist", "main.js");
const LIVE_REPO_ID = "sdl-mcp-live";
const TARGET_NAME = "SDL_MCP_SERVER_INSTRUCTIONS";
const LIVE_BASE = mkdtempSync(join(tmpdir(), "sdl-qa-live-"));
const LIVE_CONFIG_PATH = join(LIVE_BASE, "sdl.config.json");
const LIVE_DB_PATH = join(LIVE_BASE, "graph.lbug");
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 300_000;

assert.ok(existsSync(SERVER_ENTRY), `missing worktree build: ${SERVER_ENTRY}`);
writeFileSync(
  LIVE_CONFIG_PATH,
  JSON.stringify(
    {
      repos: [
        {
          repoId: LIVE_REPO_ID,
          rootPath: WORKTREE_ROOT,
          ignore: [
            "**/.git/**",
            "**/.worktrees/**",
            "**/dist/**",
            "**/node_modules/**",
            "**/.tmp/**",
          ],
          languages: ["ts"],
          maxFileBytes: 2_000_000,
        },
      ],
      codeMode: { enabled: true, exclusive: false },
      graphDatabase: { path: LIVE_DB_PATH },
      indexing: { pipeline: "legacy", engine: "typescript" },
      policy: {
        maxWindowLines: 180,
        maxWindowTokens: 1_400,
        requireIdentifiers: true,
        allowBreakGlass: false,
        defaultDenyRaw: true,
      },
    },
    null,
    2,
  ),
  "utf8",
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_ENTRY],
  env: {
    ...process.env,
    SDL_CONFIG: LIVE_CONFIG_PATH,
    SDL_GRAPH_DB_PATH: LIVE_DB_PATH,
    SDL_DB_PATH: LIVE_DB_PATH,
    SDL_MCP_DISABLE_NATIVE_ADDON: "1",
  },
});
const client = new Client(
  { name: "sdl-qa-live-probe", version: "1.0.0" },
  { capabilities: {} },
);

function payload(response) {
  if (response.structuredContent !== undefined) {
    return response.structuredContent;
  }
  const text = (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  return text ? JSON.parse(text) : {};
}

async function callTool(name, args, { allowError = false } = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError && !allowError) {
    throw new Error(`${name} failed: ${JSON.stringify(payload(response))}`);
  }
  return { response, data: payload(response) };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const subjectKey = (reference) =>
  reference.replace(/^(?:symbol|hotpath):/, "");
const isSymbolEvidence = (item) =>
  item.type === "symbolCard" ||
  item.type === "skeleton" ||
  item.type === "hotPath";
const isRichEvidence = (item) =>
  item.type === "skeleton" ||
  (item.type === "hotPath" &&
    !/(?:^| \| )Hot path \(0 matches\b/u.test(item.summary));

async function closeServer() {
  const child = transport._process;
  if (!child) {
    await client.close();
    return;
  }
  const closed = once(child, "close", {
    signal: AbortSignal.timeout(65_000),
  });
  child.stdin?.end();
  try {
    await closed;
  } finally {
    await client.close();
  }
}

let connected = false;
try {
  await client.connect(transport);
  connected = true;

  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map(({ name }) => name));
  for (const required of [
    "sdl.info",
    "sdl.repo.status",
    "sdl.index.refresh",
    "sdl.symbol.search",
    "sdl.symbol.getCard",
    "sdl.context",
    "sdl.workflow",
  ]) {
    assert.ok(toolNames.has(required), `worktree server omitted ${required}`);
  }

  const refresh = await callTool("sdl.index.refresh", {
    repoId: LIVE_REPO_ID,
    mode: "full",
    async: true,
    reason: "isolated SDL tool QA live probe",
  });
  assert.equal(refresh.data.ok, true);
  assert.equal(refresh.data.async, true);
  assert.equal(typeof refresh.data.operationId, "string");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    status = (
      await callTool("sdl.repo.status", {
        repoId: LIVE_REPO_ID,
        detail: "full",
        includeTelemetry: true,
      })
    ).data;
    const integrity = status.derivedState;
    const versionPublished =
      typeof status.latestVersionId === "string" && status.filesIndexed > 0;
    const latestRevisionVerified =
      integrity?.graphIntegrityState === "verified" &&
      integrity.graphIntegrityVersionId === status.latestVersionId &&
      integrity.graphIntegrityRevision ===
        integrity.graphIntegrityVerifiedRevision;
    if (versionPublished && latestRevisionVerified) break;
    if (integrity?.graphIntegrityState === "failed") {
      throw new Error(`graph integrity failed: ${JSON.stringify(integrity)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  assert.ok(status, "repo.status never returned");
  assert.equal(realpathSync(status.rootPath), WORKTREE_ROOT);
  assert.ok(status.filesIndexed > 0);
  assert.equal(status.derivedState?.graphIntegrityState, "verified");
  assert.equal(
    status.derivedState?.graphIntegrityVersionId,
    status.latestVersionId,
  );
  assert.equal(
    status.derivedState?.graphIntegrityRevision,
    status.derivedState?.graphIntegrityVerifiedRevision,
  );

  const search = (
    await callTool("sdl.symbol.search", {
      repoId: LIVE_REPO_ID,
      query: TARGET_NAME,
      limit: 10,
      semantic: false,
    })
  ).data;
  const exactRows = search.results.filter(({ name }) => name === TARGET_NAME);
  assert.equal(exactRows.length, 1, JSON.stringify(search.results));
  const exactId = exactRows[0].symbolId;
  const card = (
    await callTool("sdl.symbol.getCard", {
      repoId: LIVE_REPO_ID,
      symbolId: exactId,
    })
  ).data.card;
  assert.equal(card.symbolId, exactId);
  assert.equal(card.name, TARGET_NAME);

  const runtime = (
    await callTool("sdl.workflow", {
      repoId: LIVE_REPO_ID,
      steps: [
        {
          fn: "runtimeExecute",
          args: {
            runtime: "powershell",
            code: [
              "& cmd.exe /c echo SDL_NATIVE_OK",
              'Write-Output "EXIT:$LASTEXITCODE"',
            ].join("\n"),
            persistOutput: true,
            outputMode: "minimal",
            timeoutMs: 30_000,
          },
        },
        {
          fn: "runtimeQueryOutput",
          args: {
            artifactHandle: "$0.artifactHandle",
            queryTerms: ["SDL_NATIVE_OK", "EXIT:0"],
            contextLines: 0,
            maxExcerpts: 2,
            stream: "stdout",
          },
        },
      ],
    })
  ).data;
  assert.equal(runtime.results[0].result.status, "success");
  assert.equal(runtime.results[1].result.matchStatus, "matched");
  assert.deepEqual(
    runtime.results[1].result.excerpts.map(({ content }) =>
      content.replace(/\r$/, ""),
    ),
    ["SDL_NATIVE_OK", "EXIT:0"],
  );

  const infoArgs = { redactPaths: true };
  const infoA = (await callTool("sdl.info", infoArgs)).data;
  const infoB = (await callTool("sdl.info", infoArgs)).data;
  assert.deepEqual(infoB, infoA);
  assert.ok(
    infoA.logging.path === null || infoA.logging.path === "<redacted>",
  );

  const contextArgs = {
    repoId: LIVE_REPO_ID,
    taskType: "explain",
    taskText: `Explain ${TARGET_NAME}`,
    options: { contextMode: "broad", semantic: false },
    responseMode: "inline",
    refsMode: "off",
  };
  const contextA = (await callTool("sdl.context", contextArgs)).data;
  const contextB = (await callTool("sdl.context", contextArgs)).data;
  assert.deepEqual(contextB, contextA);
  assert.ok(contextA.finalEvidence.length > 0);
  assert.ok(isSymbolEvidence(contextA.finalEvidence[0]));
  assert.equal(subjectKey(contextA.finalEvidence[0].reference), exactId);
  const symbolEvidence = contextA.finalEvidence.filter(isSymbolEvidence);
  assert.ok(
    symbolEvidence.some(
      (item) => subjectKey(item.reference) === exactId && isRichEvidence(item),
    ),
  );
  const secondarySubjects = new Set(
    symbolEvidence
      .map(({ reference }) => subjectKey(reference))
      .filter((subject) => subject !== exactId),
  );
  assert.ok(secondarySubjects.size <= 2);
  for (const subject of secondarySubjects) {
    assert.ok(
      symbolEvidence.some(
        (item) => subjectKey(item.reference) === subject && isRichEvidence(item),
      ),
      `card-only secondary survived: ${subject}`,
    );
  }

  async function notFound(name) {
    const result = await callTool(
      "sdl.symbol.getCard",
      { repoId: LIVE_REPO_ID, symbolRef: { name } },
      { allowError: true },
    );
    assert.equal(result.response.isError, true);
    return result.data.error ?? result.data;
  }

  const typo = await notFound("buildScrubedEnv");
  assert.ok(typo.candidates.length <= 3);
  assert.ok(typo.candidates.every(({ score }) => score >= 0.35));
  assert.ok(typo.candidates.some(({ name }) => name === "buildScrubbedEnv"));
  const expectedHint = ` Did you mean: ${typo.candidates
    .map(({ name, file }) => `"${name}" (${file})`)
    .join(", ")}?`;
  assert.ok(typo.message.endsWith(expectedHint));

  const impossible = await notFound("zzzzNoMatchxxxx");
  assert.deepEqual(impossible.candidates, []);
  assert.doesNotMatch(impossible.message, /Did you mean:/);

  console.log(
    JSON.stringify({
      ok: true,
      serverEntry: SERVER_ENTRY,
      repoRoot: status.rootPath,
      latestVersionId: status.latestVersionId,
      graphIntegrityState: status.derivedState.graphIntegrityState,
      polls,
      exactTarget: { name: TARGET_NAME, symbolId: exactId },
      runtime: "SDL_NATIVE_OK / EXIT:0",
      infoLoggingPath: infoA.logging.path,
      secondarySubjects: secondarySubjects.size,
      typoCandidates: typo.candidates.map(({ name, score }) => ({ name, score })),
    }),
  );
} finally {
  if (connected) await closeServer();
  const safeTemp =
    resolve(LIVE_BASE).startsWith(resolve(tmpdir())) &&
    basename(LIVE_BASE).startsWith("sdl-qa-live-");
  assert.ok(safeTemp, `refusing unsafe cleanup: ${LIVE_BASE}`);
  rmSync(LIVE_BASE, { recursive: true, force: true });
}
```

The polling contract is concrete: every 500 ms for at most five minutes, wait for a published non-empty Version and matching `graphIntegrityVersionId`, `graphIntegrityRevision`, and `graphIntegrityVerifiedRevision` in `verified` state. `failed` aborts immediately. Because the new Version is published only when the refresh finishes, those conditions prove the async refresh is no longer active before retrieval is judged.

- [ ] **Step 5: Run the disposable probe from the worktree**

Run:

```powershell
$env:SDL_MCP_DISABLE_NATIVE_ADDON='1'
node scripts/.tmp-sdl-qa-live-probe.mjs
```

Expected: exit code 0 and one JSON line with `ok: true`, the absolute worktree `serverEntry` and `repoRoot`, `graphIntegrityState: "verified"`, one exact target identity, `SDL_NATIVE_OK / EXIT:0`, stable redacted/null info logging, at most two rich secondary context subjects, and bounded typo candidates including `buildScrubbedEnv`. The script itself starts and closes the worktree server and removes only its process-unique external temp directory.

- [ ] **Step 6: Remove the untracked probe script**

Use `apply_patch` to delete only `scripts/.tmp-sdl-qa-live-probe.mjs`, then run:

```powershell
git status --short
```

Expected: the temporary script and all live-probe artifacts are absent; only intentional implementation state remains.

- [ ] **Step 7: Inspect the final diff and repository state**

Run:

```powershell
git diff --check <implementation-base>...HEAD
git diff --check
git status --short --branch
git log --oneline --decorate -6
```

Expected: both the committed-range and working-tree `git diff --check` commands exit 0; the branch is `codex/sdl-tool-qa-remediation`; only intentional commits are present; no generated artifacts, temp databases, persisted runtime outputs, or backups are tracked or left untracked.

- [ ] **Step 8: Record verification evidence in the completion report**

Report the exact command outcomes, test counts, live-probe results, and commit hashes. Distinguish skipped platform-specific tests from executed passes. Do not claim completion from the focused set alone; the full suite, golden check, documentation check, and live probes are required acceptance evidence.
