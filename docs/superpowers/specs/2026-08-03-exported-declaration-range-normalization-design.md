# Exported Declaration Range Normalization Design

## Problem

Provider-first TypeScript indexing stores the SCIP definition occurrence's enclosing range. For an exported declaration, that range includes the `export` wrapper and starts at column 0. Saved-file reconciliation reparses the file with tree-sitter and stores the child declaration node's range, which starts after `export`. Consequently, an unchanged exported symbol can move from column 0 to column 7 after reconciliation and remain there after the source is restored.

This is a parser range-convention mismatch. It is not a symbol-card cache problem or a LadybugDB projection problem.

## Chosen approach

Normalize tree-sitter declaration ranges at the shared extraction boundary. The currently extracted function and generator declarations, classes, interfaces, type aliases, modules, and variable symbols will use their immediately containing `export_statement` range. This includes `export default` and decorated exported declarations because tree-sitter places the decorator and declaration inside that export wrapper.

For function, generator, class, interface, type-alias, and module nodes, only a direct `export_statement` parent is transparent. For variable symbols, range selection may traverse only pattern nodes, the owning `variable_declarator`, and its `lexical_declaration` or `variable_declaration` to reach the immediately containing `export_statement`. It must not cross a function, class, module body, or another declaration. If that bounded wrapper is absent, use the original symbol node's range unchanged.

Methods, constructors, properties, parameters, local identifiers, ambient declarations, and enums are outside this change. Ambient declarations and enums are not currently emitted by this shared extractor. No non-TypeScript adapter range changes.

This is preferred over two alternatives:

- Preserving the provider range during reconciliation would leave the range stale when an edit genuinely moves or resizes the declaration.
- Adjusting `startCol` during database writes would hide parser provenance, duplicate syntax knowledge in persistence code, and leave end positions or other declaration forms inconsistent.

Signature and visibility differences between provider-first and tree-sitter data are outside this change. They require a separate canonical payload-ownership decision.

## Components and data flow

`src/indexer/treesitter/extractSymbols.ts` will contain the normalization at the existing range-extraction boundary. Declaration processors continue returning ordinary `ExtractedSymbol` values; callers, reconciliation, and LadybugDB persistence remain unchanged.

The resulting flow is:

1. Tree-sitter identifies a declaration node.
2. Range extraction selects its bounded `export_statement` wrapper when present.
3. Saved-file reconciliation persists the normalized range under the stable symbol ID.
4. Symbol-card reads expose the same declaration range convention as the provider-first baseline.

## Error handling

No new failure mode or recovery path is needed. If the bounded export wrapper is absent, extraction keeps the existing symbol-node range. Malformed syntax continues through the current tree-sitter parse-error handling.

## Verification

- Add focused extractor regressions for a direct exported function, an `export default` declaration, an exported variable, and an unexported declaration. Assert complete range objects so wrapper start and end positions are both covered.
- Add a saved-file reconciliation regression with one provider-first baseline symbol: record its stable symbol ID and complete range, edit and reconcile the file, restore and reconcile it again, then require the same symbol ID and complete baseline range after both reconciliations.
- Run the adapter harness and TypeScript typecheck. Run the focused saved-file graph patch integration test because it covers the provider-identity reconciliation boundary.

## Acceptance criteria

- `export function caseFoldedPathKey` extracts with `startCol: 0` and unchanged line/end coordinates.
- Supported exported declaration forms use the bounded `export_statement` range.
- Non-exported declarations and out-of-scope member/local symbols retain their existing ranges.
- The same provider-backed symbol ID has a complete range equal to the full-index baseline after an edit/reconciliation and after exact source restoration/reconciliation.
- Existing graph-integrity and reconciliation behavior remains verified.
- No database, cache, schema, signature, or visibility code changes are introduced.
