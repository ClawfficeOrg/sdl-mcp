# Windows FTS Initial-Open Runtime Design

## Problem

On Windows x64, LadybugDB 0.18.1 can load the FTS extension while
`Database.init()` replays a dirty WAL. SDL currently preloads the packaged
OpenSSL DLLs only around its later explicit `LOAD EXTENSION fts`, so an
ordinary npm installation can fail before that guard runs.

## Design

Reuse `withWindowsFtsRuntime()` around only the `Database.init()` boundary.
Keep the existing explicit-load guard unchanged. If the optional runtime is
unavailable, still attempt initialization so databases without FTS remain
usable and preserve the existing initialization error reporting.

Add a focused source-contract regression for the initial-open guard. Retain the
existing Windows-only clean-`PATH` child-process reopen regression; a synthetic
abrupt close did not recreate the production WAL state that triggered the
reported failure.

## Non-goals

- Do not mutate global `PATH`.
- Do not copy DLLs beside LadybugDB extensions.
- Do not require the optional FTS runtime merely to import LadybugDB.
