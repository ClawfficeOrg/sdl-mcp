import assert from "node:assert";
import { describe, it } from "node:test";

import {
  extractIdentifiersFromText,
  extractQualifiedTermsFromContext,
} from "../../../dist/retrieval/identifier-extraction.js";

describe("extractIdentifiersFromText", () => {
  it("retains natural-language domain terms alongside identifier variants", () => {
    const identifiers = extractIdentifiersFromText(
      "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.",
    );

    for (const term of [
      "contracts",
      "contract",
      "output",
      "deterministic",
      "responses",
      "response",
      "safe",
      "errors",
      "error",
    ]) {
      assert.ok(
        identifiers.some((identifier) => identifier.toLowerCase() === term),
        `Expected ${term} in ${JSON.stringify(identifiers)}`,
      );
    }
  });

  it("keeps exact code identifiers authoritative", () => {
    const identifiers = extractIdentifiersFromText(
      "Review buildToolResponseEnvelope determinism",
    );

    assert.equal(identifiers[0], "buildToolResponseEnvelope");
  });
});

describe("extractQualifiedTermsFromContext", () => {
  it("preserves task and caller-qualified terms in source order", () => {
    assert.deepEqual(
      extractQualifiedTermsFromContext(
        "Find sdl.info, then sdl.workflow and sdl.info again",
        ["sdl.context before Sdl.Info", "sdl.workflow"],
      ),
      ["sdl.info", "sdl.workflow", "sdl.context", "Sdl.Info"],
    );
  });

  it("accepts only complete qualified ASCII identifiers with case-sensitive dedupe", () => {
    assert.deepEqual(
      extractQualifiedTermsFromContext(
        "Keep $root._child9 and Alpha.beta2; reject plain, sdl., and ordinary.valid.",
        ["A.B then a.b then A.B"],
      ),
      ["$root._child9", "Alpha.beta2", "A.B", "a.b"],
    );
  });

  it("keeps an exact source prefix when the code-point cutoff creates a terminal dot", () => {
    const retainedPrefix = `a.${"b".repeat(125)}`;
    const qualifiedTerm = `${retainedPrefix}.tail`;
    const invalidAfterCleanup = `${"a".repeat(127)}.tail`;
    const source = `${qualifiedTerm} ${invalidAfterCleanup} ordinary.valid.`;
    const terms = extractQualifiedTermsFromContext(source, []);

    assert.deepEqual(terms, [retainedPrefix]);
    assert.equal(Array.from(retainedPrefix).length, 127);
    assert.equal(Array.from(qualifiedTerm).slice(0, 128).at(-1), ".");
    assert.equal(retainedPrefix, qualifiedTerm.slice(0, retainedPrefix.length));
    assert.ok(source.includes(terms[0]));
  });

  it("caps qualified terms at sixteen", () => {
    const terms = Array.from({ length: 20 }, (_, index) => `api.term${index}`);

    assert.deepEqual(
      extractQualifiedTermsFromContext(terms.join(" "), []),
      terms.slice(0, 16),
    );
  });
});
