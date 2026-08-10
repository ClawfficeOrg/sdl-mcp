import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ValidationError,
  errorToMcpResponse,
} from "../../dist/mcp/errors.js";

describe("MCP error recovery cold imports", () => {
  it("validates response.get recovery without action-catalog import side effects", () => {
    const error = Object.assign(new ValidationError("Safe validation failure."), {
      nextCalls: [
        {
          action: "sdl.response.get",
          args: {
            repoId: "repo",
            handle: "response-artifact",
            raw: true,
            maxBytes: 4096,
          },
        },
      ],
    });

    const detail = errorToMcpResponse(error).error as Record<string, unknown>;

    assert.deepEqual(detail.nextCalls, [
      {
        action: "sdl.response.get",
        args: {
          full: false,
          handle: "response-artifact",
          maxBytes: 4096,
          offsetBytes: 0,
          raw: true,
          repoId: "repo",
        },
      },
    ]);
  });
});
