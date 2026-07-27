import { basename } from "path";
import { z } from "zod";
import { collectInfoReport, type InfoReport } from "../../info/report.js";

export const InfoRequestSchema = z
  .object({
    // When true, config/LadybugDB/native paths use basenames and logging
    // paths use a stable marker. Set this in multi-tenant or HTTP-transport
    // deployments so callers cannot learn the server's home directory,
    // install location, or database layout from an info call.
    redactPaths: z.boolean().optional(),
  })
  .passthrough();

type InfoRequest = z.infer<typeof InfoRequestSchema>;

/** Collects and returns the server info/diagnostics report. */
export async function handleInfo(args?: unknown): Promise<InfoReport> {
  const request: InfoRequest =
    args === undefined ? {} : InfoRequestSchema.parse(args);
  const report = await collectInfoReport();
  return request.redactPaths ? redactInfoPaths(report) : report;
}

export function redactInfoPaths(report: InfoReport): InfoReport {
  const redact = (p: string | null): string | null =>
    p === null ? null : basename(p);
  const pathReplacements: Array<[string | null, string]> = [
    [report.config.path, basename(report.config.path)],
    [report.logging.path, "<redacted>"],
    [report.ladybug.activePath, basename(report.ladybug.activePath ?? "")],
    [report.native.sourcePath, basename(report.native.sourcePath ?? "")],
  ];
  // Free-form diagnostics can echo structured paths, so scrub the same known
  // values before returning a response intended for multi-tenant callers.
  const redactDiagnostic = (message: string): string =>
    pathReplacements.reduce(
      (redacted, [path, replacement]) =>
        path ? redacted.replaceAll(path, replacement) : redacted,
      message,
    );
  return {
    ...report,
    config: { ...report.config, path: basename(report.config.path) },
    logging: { ...report.logging, path: report.logging.path === null ? null : "<redacted>" },
    warnings: report.warnings.map(redactDiagnostic),
    misconfigurations: report.misconfigurations.map(redactDiagnostic),
    ladybug: {
      ...report.ladybug,
      activePath: redact(report.ladybug.activePath),
    },
    native: {
      ...report.native,
      sourcePath: redact(report.native.sourcePath),
      reason: redactDiagnostic(report.native.reason),
    },
  };
}
