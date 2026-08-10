import assert from "node:assert/strict";
import { it } from "node:test";

it("cold-imports the file gateway before the recovery catalog", async () => {
  const fileGateway = await import("../../dist/mcp/tools/file-gateway.js");

  assert.equal(typeof fileGateway.handleFileGateway, "function");
  assert.equal(typeof fileGateway.FileGatewayRequestSchema.parse, "function");
});
