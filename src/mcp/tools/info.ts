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
  return {
    ...report,
    config: { ...report.config, path: basename(report.config.path) },
    logging: { ...report.logging, path: report.logging.path === null ? null : "<redacted>" },
    warnings: report.logging.path === null
      ? report.warnings
      : report.warnings.map((warning) =>
          warning === `Log path fallback in use: ${report.logging.path}`
            ? "Log path fallback in use: <redacted>"
            : warning,
        ),
    ladybug: {
      ...report.ladybug,
      activePath: redact(report.ladybug.activePath),
    },
    native: {
      ...report.native,
      sourcePath: redact(report.native.sourcePath),
    },
  };
}
