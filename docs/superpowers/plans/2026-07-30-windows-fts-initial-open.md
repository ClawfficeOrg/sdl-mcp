# Windows FTS Initial-Open Implementation Plan

1. Add a source-contract regression for the initial-open guard and verify it
   fails before the product change. Keep the existing clean-`PATH` production
   reopen regression unchanged.
2. Wrap `Database.init()` with the existing verified Windows FTS runtime helper.
   If provisioning is unavailable, run `Database.init()` normally.
3. Run the focused runtime tests, typecheck, lint, build, package contract, and
   a clean-`PATH` packed-install/open check.
