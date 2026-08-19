# Enforcing SDL-MCP Tool Use with Claude Code and Claude

This guide describes the current SDL-first enforcement path for Claude clients.

For the cross-client overview covering Claude, Codex, Gemini, and OpenCode, see [tool-enforcement.md](./tool-enforcement.md).

The recommended setup is no longer a manual collection of ad hoc files. Use the generated enforcement profile:

```bash
sdl-mcp init --client claude-code --enforce-agent-tools
```

That setup enables SDL runtime and code mode in config, writes repo-local instruction files, and generates Claude-specific hook assets.

---

## What Gets Generated

When you run the enforced init flow for Claude, SDL-MCP creates:

- `AGENTS.md`
- `CLAUDE.md`
- `.claude/settings.json`
- `.claude/hooks/force-sdl-mcp.sh`
- `.claude/hooks/force-sdl-runtime.sh`
- `.claude/agents/explore-sdl.md`
- `.claude/sdl-prompt.md`

The generated files steer Claude toward:

1. `sdl.repo.status`
2. `sdl.action.search`
3. focused `sdl.manual`
4. `sdl.context` for task-shaped context, `symbolSearch`/`symbolGetCard` for exact symbols, or `slice.build` for graph/file frontiers
5. `sdl.workflow` for batched escalation, runtime execution, data transforms, and batch operations
6. `runtimeExecute` inside `sdl.workflow` for repo-local commands

`runtimeExecute` executes repository tooling: build, test, lint, compiler,
named scripts, and targeted edit scripts. Do not use it to inspect, search, or
print repository files. Use `sdl.context` or `sdl.retrieve` for indexed source
and `sdl.file` with `op="read"` for other files. Its cooperative,
high-confidence, precision-first guard has no per-call bypass, but it is not a
security boundary. Disable runtime execution when one is required.

When Code Mode is unavailable, read non-indexed files with `sdl.file.read`.
For indexed source, use the flat ladder: `sdl.repo.overview`,
`sdl.symbol.search` / `sdl.symbol.getCard`, `sdl.slice.build`, then
`sdl.code.getSkeleton`, `sdl.code.getHotPath`, or a justified
`sdl.code.needWindow` as appropriate.

They also teach Claude to use `symbolRef` / `symbolRefs` when it knows a symbol name but not the canonical ID, and to follow SDL fallback guidance instead of retrying blocked native tools. Enforcement is conditional on the SDL-MCP server being active.

---

## Enforcement Layers

### Source-code read enforcement

`.claude/hooks/force-sdl-mcp.sh` denies repo-local native `Read`, `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` while the SDL-MCP PID file is present. Indexed reads are redirected to the Iris retrieval ladder, one-symbol indexed writes to `symbol.edit` / symbol edit apply, AST-aware batches to `searchEditPreview` with `targeting:"identifier"` or `targeting:"structural"`, heterogeneous batches to `operations[]`, and non-indexed reads/writes to `file.read` / `file.write`. Repo `.codex/**` and `.claude/**` maintenance remains allowed.

### Runtime enforcement

`.claude/hooks/force-sdl-runtime.sh` denies repo-local native Bash commands while the SDL-MCP PID file is present so the model uses SDL runtime instead. Narrow internal maintenance commands for `.codex/**`, `.claude/**`, and non-repo skill/memory paths remain allowed.

### Permissions

`.claude/settings.json` allows native tools as fallbacks and relies on the PID-gated hooks to deny repo-local bypasses while SDL-MCP is active. It also disables the built-in `Explore` agent in favor of the generated `explore-sdl` subagent.

### Instruction layer

`CLAUDE.md`, `AGENTS.md`, and `.claude/sdl-prompt.md` reinforce the same SDL-first behavior in plain language.

That instruction layer now includes natural-identifier lookup and guidance fields such as `fallbackTools` and `fallbackRationale`.

The generated `explore-sdl` agent mirrors the SDL-MCP Agent Workflow skill: it chooses the cheapest SDL discovery surface (`sdl.context`, `symbolSearch`/`symbolGetCard`, or `slice.build`), escalates through batched SDL workflow steps only when needed, uses SDL runtime with minimal persisted output for repo-local commands, avoids habitual index refreshes, and calls `usageStats` only for requested savings reports, telemetry debugging, or persisted usage snapshots.

SDL-MCP places the required workflow in the first advertised tool description. The fuller `sdl-mcp-agent-workflow` skill is optional and installed repo-locally only with `sdl-mcp init --skill`. Codex enforcement's `.codex/hooks/load-sdl-skill.mjs` hook loads that skill when available and otherwise injects its bundled fallback summary.

---

## Indexed Source Extensions

| Language              | Extensions                                  |
| --------------------- | ------------------------------------------- |
| TypeScript/JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs`     |
| Python                | `.py` `.pyw` `.pyi`                         |
| Go                    | `.go`                                       |
| Java                  | `.java`                                     |
| C#                    | `.cs`                                       |
| C/C++                 | `.c` `.h` `.cpp` `.hpp` `.cc` `.cxx` `.hxx` `.def` `.inc` |
| PHP                   | `.php` `.phtml`                             |
| Rust                  | `.rs`                                       |
| Kotlin                | `.kt` `.kts`                                |
| Shell                 | `.sh` `.bash` `.zsh`                        |

Non-indexed files such as Markdown, JSON, YAML, TOML, and similar config or documentation files should use `file.read` / `file.write` while SDL-MCP is active. Native reads and writes are fallback-only when the PID file is absent, except for repo `.codex/**`, repo `.claude/**`, and non-repo agent internals.

---

## Recommended Claude Workflow

For code understanding:

1. `sdl.repo.status`
2. `sdl.action.search` (when the correct SDL action is unclear)
3. `sdl.manual(query|actions|format)` for focused reference
4. `sdl.context` with flat focus fields and a required token budget for task-shaped retrieval
5. `symbolSearch`/`symbolGetCard` for exact symbols, or `slice.build` when Claude needs a graph/file frontier before editing
6. Provide `focusSymbols` and/or `focusPaths` to scope retrieval; always set a budget

For symbol lookup:

- use `symbolRef` or `symbolRefs` when the symbol name is known but the exact `symbolId` is not
- if SDL returns ranked candidates or fallback guidance, refine the SDL request instead of retrying native `Read`

For multi-step operations:

- use `sdl.workflow` for batched retrieval follow-ups after the first SDL discovery surface, runtime execution, data transforms, and batch mutations
- use `runtimeExecute` inside `sdl.workflow` with `outputMode: "minimal"` for repo-local commands, and use `stdin` for multiline input
- use `searchEditPreview` `targeting:"identifier"` for exact AST identifier changes in supported structural languages and `targeting:"structural"` for tree-sitter capture edits before falling back to runtime scripts
- supported runtimes: `node`, `typescript`, `python`, `shell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp`

Do not retry denied native file or Bash calls. Switch to SDL-MCP immediately and follow the SDL response guidance fields when present.

---

## Notes

- The generated enforcement assets are conservative. They are created automatically for new setups and do not blindly merge into existing user-managed files.
- Claude remains the strongest current hook path because it also disables the built-in `Explore` agent. Codex and OpenCode now get generated hook/plugin enforcement assets plus repo-local instruction files; Gemini remains instruction-driven.
