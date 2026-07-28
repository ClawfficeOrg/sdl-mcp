# SDL-MCP Tool Recipes

## Focused Debug

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "Debug the handleAgentContext handler",
  "budget": { "maxTokens": 4000 },
  "focusSymbols": ["handleAgentContext"],
  "chatMentions": ["handleAgentContext"],
  "includeTests": true,
  "responseMode": "auto"
}
```

## Subsystem Explanation

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Explain request dispatch from entrypoint to tool handlers",
  "budget": { "maxTokens": 7000 },
  "includeTests": false,
  "responseMode": "auto"
}
```

## Large-Response Recovery

When `sdl.context` returns a response artifact handle, retrieve only the needed
canonical field:

```json
{
  "repoId": "my-repo",
  "handle": "response-my-repo-...",
  "jsonPath": "evidence",
  "offset": 0,
  "limit": 10
}
```

Use `full: true` only when the complete canonical payload is required.
