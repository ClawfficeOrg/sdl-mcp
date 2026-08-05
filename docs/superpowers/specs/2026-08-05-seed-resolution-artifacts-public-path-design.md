# Seed Resolution V2 Artifact Relocation

## Goal

Move the active seed-resolution v2 corpus and generated evaluation report from `devdocs/benchmarks/` to `docs/benchmarks/`. The public documentation tree becomes the single tracked location for these benchmark artifacts, while the legacy v1 files remain unchanged under `devdocs/benchmarks/`.

## File Contract

The change moves these tracked files without compatibility copies:

- `devdocs/benchmarks/seed-resolution-corpus-v2.json` to `docs/benchmarks/seed-resolution-corpus-v2.json`
- `devdocs/benchmarks/seed-resolution-evaluation-v2.json` to `docs/benchmarks/seed-resolution-evaluation-v2.json`

The generator reads the corpus and writes the evaluation report at the new paths. The seed-resolution unit test and the benchmark report reference use the same canonical paths. No runtime configuration or fallback path is added.

## CI Repair

The current evaluation report contains the old fingerprint for `src/context/engine.ts`. Regenerating the report after the move records the current fingerprint while preserving the recall hard floor and deterministic stable projection.

## Test Strategy

1. Update the path expectations first and run the focused seed-resolution test. It must fail because the new files do not yet exist.
2. Move both v2 artifacts, update the generator and benchmark reference, and regenerate the evaluation report.
3. Run the generator's `--check` mode and the focused seed-resolution tests.
4. Verify build, typecheck, the full test suite, and a clean diff. Confirm the old v2 paths are absent and the v1 files remain unchanged.

## Scope Boundaries

- Do not move or edit the v1 artifacts.
- Do not add compatibility copies, redirects, configuration, or new dependencies.
- Do not modify unrelated deletions or other work already present on the main worktree.
