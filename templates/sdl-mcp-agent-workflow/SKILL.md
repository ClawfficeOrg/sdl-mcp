---
name: sdl-mcp-agent-workflow
description: Use when working in an SDL-MCP-enabled repository, including repository exploration, task context, code inspection, runtime execution, edits, or SDL-MCP tool calls.
---

# SDL-MCP Agent Workflow

Use SDL-MCP as the repository boundary.

1. Start with `repo.status`.
2. Use `sdl.context` for task-shaped explain, debug, review, and implement work.
   Its request is flat and requires `budget.maxTokens`; never send `options`,
   `contextMode`, or `answerFirst`.
3. Use `sdl.retrieve` for one card, slice, skeleton, hot path, or justified code
   window. Never use `file.read` for indexed source.
4. Use `sdl.workflow` for runtime execution, transforms, dependent calls, and
   batch mutations. Persist command output and query only needed failure lines.
5. Read and write non-indexed files through `sdl.file`. Edit indexed source
   through symbol or search-edit preview/apply operations.
6. Keep `responseMode: "auto"` for potentially large results. A returned handle
   is a generic response artifact; retrieve its canonical `evidence` or another
   needed field with `response.get`.
7. Reuse refs and ETags. Set `refsMode: "off"` only for complete or byte-stable
   output.
8. Refresh the index only when status proves it is needed. Call usage statistics
   only when the user asks for token savings or telemetry.

Use [tool recipes](./references/tool-recipes.md) for exact v2 request shapes.
