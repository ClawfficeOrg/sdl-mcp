import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import {
  findRetrievalSeedSymbolsByIdPrefix,
  findRetrievalSeedSymbolsByName,
} from "../../dist/db/ladybug-retrieval.js";

function recordingConnection(): {
  conn: Connection;
  statements: string[];
} {
  const statements: string[] = [];
  const conn = {
    prepare: async (statement: string) => ({ statement }),
    execute: async (prepared: unknown) => {
      statements.push((prepared as { statement: string }).statement);
      return {
        getAll: async () => [],
        close: () => {},
      };
    },
  } as unknown as Connection;
  return { conn, statements };
}

function assertSymbolIdOrderBeforeLimit(statement: string): void {
  const orderIndex = statement.indexOf("ORDER BY s.symbolId");
  const limitIndex = statement.indexOf("LIMIT 2");
  assert.ok(orderIndex >= 0, "seed query must order by symbolId");
  assert.ok(limitIndex >= 0, "seed query must remain bounded");
  assert.ok(orderIndex < limitIndex, "seed query must order before LIMIT");
}

describe("Ladybug retrieval seed ordering", () => {
  it("orders exact and prefix name matches before bounded selection", async () => {
    const { conn, statements } = recordingConnection();

    await findRetrievalSeedSymbolsByName(conn, "repo", "Target", "exact");
    await findRetrievalSeedSymbolsByName(conn, "repo", "Target", "prefix");

    assert.equal(statements.length, 2);
    for (const statement of statements) {
      assertSymbolIdOrderBeforeLimit(statement);
    }
  });

  it("orders short-ID matches before bounded selection", async () => {
    const { conn, statements } = recordingConnection();

    await findRetrievalSeedSymbolsByIdPrefix(conn, "repo", "0123456789abcdef");

    assert.equal(statements.length, 1);
    assertSymbolIdOrderBeforeLimit(statements[0] ?? "");
  });
});
