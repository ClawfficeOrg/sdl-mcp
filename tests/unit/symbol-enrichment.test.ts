import assert from "node:assert";
import { describe, it } from "node:test";

import {
  extractRoleTags,
  resolveSymbolEnrichment,
} from "../../dist/indexer/symbol-enrichment.js";

describe("symbol enrichment", () => {
  it("derives role tags from symbol name and path", () => {
    const tags = extractRoleTags(
      "function",
      "handleLogin",
      "src/api/auth-handler.ts",
    );

    assert.deepStrictEqual(tags, ["handler", "entrypoint"]);
  });

  it("builds search text from summary, role tags, path, and signature terms", () => {
    const enrichment = resolveSymbolEnrichment({
      kind: "function",
      name: "handleLoginRequest",
      relPath: "src/api/auth-handler.ts",
      summary: "Handle login requests",
      signature: {
        params: [{ name: "authRequest" }],
      },
    });

    assert.strictEqual(
      enrichment.roleTagsJson,
      JSON.stringify(["handler", "entrypoint"]),
    );
    assert.match(enrichment.searchText, /\bhandleloginrequest\b/);
    assert.match(enrichment.searchText, /\bhandle\b/);
    assert.match(enrichment.searchText, /\blogin\b/);
    assert.match(enrichment.searchText, /\brequests\b/);
    assert.match(enrichment.searchText, /\bhandler\b/);
    assert.match(enrichment.searchText, /\bentrypoint\b/);
    assert.match(enrichment.searchText, /\bauthrequest\b/);
    assert.match(enrichment.searchText, /\bauth\b/);
    assert.match(enrichment.searchText, /\brequest\b/);
  });

  it("prefers native enrichment when provided", () => {
    const enrichment = resolveSymbolEnrichment({
      kind: "function",
      name: "handleLoginRequest",
      relPath: "src/api/auth-handler.ts",
      summary: "Handle login requests",
      nativeRoleTagsJson: JSON.stringify(["handler", "custom"]),
      nativeSearchText: "native only",
    });

    assert.strictEqual(
      enrichment.roleTagsJson,
      JSON.stringify(["handler", "custom"]),
    );
    assert.strictEqual(enrichment.searchText, "native only");
  });

  it("does not tag report helpers as repositories", () => {
    const tags = extractRoleTags(
      "function",
      "reportMetrics",
      "src/utils/report.ts",
    );

    assert.deepStrictEqual(tags, []);
  });

  it("recognizes JS and TSX entry/config files", () => {
    const entrypoint = resolveSymbolEnrichment({
      kind: "function",
      name: "renderApp",
      relPath: "src/main.tsx",
      summary: null,
    });
    const config = resolveSymbolEnrichment({
      kind: "function",
      name: "loadSettings",
      relPath: "src/config.js",
      summary: null,
    });

    assert.strictEqual(entrypoint.roleTagsJson, JSON.stringify(["entrypoint"]));
    assert.strictEqual(config.roleTagsJson, JSON.stringify(["config"]));
  });
});

it("appends semantic test-case terms after role tags without changing legacy text", async () => {
  const { buildSearchText } = await import(
    "../../dist/indexer/symbol-enrichment.js"
  );
  const params = {
    kind: "function",
    name: "handleLoginRequest",
    relPath: "src/api/auth-handler.ts",
    summary: "Handle login requests",
    signature: { params: [{ name: "authRequest" }] },
    roleTags: ["handler", "entrypoint"],
  };

  assert.strictEqual(
    buildSearchText(params),
    "handleloginrequest handle login request handle login requests requests function handler entrypoint src api auth ts authrequest",
  );
  assert.strictEqual(
    buildSearchText({
      ...params,
      testCase: {
        framework: "node:test",
        title: "keeps sdl.info callable",
        suitePath: ["Code Mode"],
        modifiers: ["only"],
      },
    }),
    "handleloginrequest handle login request handle login requests requests function handler entrypoint keeps sdl.info callable keeps sdl info callable code mode code mode node:test only src api auth ts authrequest",
  );
});
