# Windows CI Variance Repair

## Problem

CI run `30565302660` failed only on Windows. The nested PowerShell runtime test returned `timeout` after 30 seconds, although five focused local runs completed in 0.39–0.43 seconds. The background-integrity benchmark also recorded two isolated foreground samples above 1.4 seconds while its p50, ratio, concurrency, background verification, and timeout checks passed.

Seven recent Windows benchmark artifacts reported candidate foreground p95 values between 292 and 857 milliseconds. The current 1,000-millisecond ceiling is therefore useful but too narrow for rare Windows runner spikes.

## Design

Keep the default candidate foreground p95 ceiling at 1,000 milliseconds. When the benchmark artifact identifies `win32`, evaluate and record a 1,600-millisecond candidate p95 ceiling. All other thresholds remain unchanged.

Keep the production runtime default at 30 seconds. Configure only the nested PowerShell persistence integration test with a 60-second policy cap and request timeout so runner startup variance cannot obscure the output-persistence contract.

## Verification

Add a focused benchmark assertion that a Windows artifact records and applies the 1,600-millisecond ceiling while the default threshold remains 1,000 milliseconds. Run the benchmark unit test, the targeted runtime integration test, typecheck, and lint before pushing.

The replacement GitHub Actions run must execute both Windows jobs successfully. No retry loop, global threshold increase, or production runtime timeout change is in scope.
