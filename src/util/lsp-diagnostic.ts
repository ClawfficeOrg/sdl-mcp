/** Normalize LSP 3.17 string and 3.18 MarkupContent diagnostic messages. */
export function lspDiagnosticMessageText(
  message: string | { readonly value: string },
): string {
  return typeof message === "string" ? message : message.value;
}
