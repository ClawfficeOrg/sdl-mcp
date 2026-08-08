/**
 * Escapes a single-line value for use in a Markdown table cell.
 */
export function escapeMarkdownTableCell(value: string): string {
  // Preserve literal backslashes before adding escapes for table delimiters.
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}
