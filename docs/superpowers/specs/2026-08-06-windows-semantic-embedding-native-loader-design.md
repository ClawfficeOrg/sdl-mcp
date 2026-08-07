# Windows semantic embedding native-loader design

Date: 2026-08-06
Status: Approved

## Problem

The test runner forces `SDL_MCP_DISABLE_NATIVE_ADDON=1` for every test file. On Windows, the semantic embedding integration test needs SDL's verified native OpenSSL loader so LadybugDB can load the VECTOR extension. With the addon disabled, `LOAD vector` fails on pooled connections and the HNSW probe later reports that `QUERY_VECTOR_INDEX` is undefined.

## Design

In `scripts/run-tests.mjs`, preserve `SDL_MCP_DISABLE_NATIVE_ADDON=1` for every test except `tests/integration/semantic-embedding.test.ts` on Windows. That one file inherits normal native-addon availability so the verified OpenSSL loader can resolve LadybugDB's DLL dependencies.

Do not change the HNSW assertion, extension loader, production database behavior, or native-disabled coverage for other tests.

## Verification

Add one source-contract test that fails under the current unconditional environment assignment. It must assert both the default `SDL_MCP_DISABLE_NATIVE_ADDON: "1"` assignment and a Windows-only comparison against the normalized exact path `tests/integration/semantic-embedding.test.ts`; a broad suffix match is not sufficient. Then run the semantic-embedding integration test with the runner-equivalent environment, the runner contract tests, and the complete `npm run prepare-release` gate before publication.
