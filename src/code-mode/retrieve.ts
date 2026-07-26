import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import {
  compactJsonSchema,
  zodSchemaToJsonSchema,
} from "../gateway/compact-schema.js";
import { dispatchAction, type ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";
import { RetrieveRequestSchema } from "./retrieve-schema.js";

export { RetrieveOpSchema, RetrieveRequestSchema } from "./retrieve-schema.js";

export const RETRIEVE_ACTION_BY_OP = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  sliceBuild: "slice.build",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  codeNeedWindow: "code.needWindow",
} as const;

const RETRIEVE_OUTPUT_KEYS = [
  "results",
  "card",
  "cards",
  "slice",
  "file",
  "approved",
  "etag",
  "kind",
] as const;

// Keep the top-level catalog compact; action schemas validate the nested payloads.
export const RetrieveOutputSchema = z
  .object({
    results: z.unknown().optional(),
    card: z.unknown().optional(),
    cards: z.unknown().optional(),
    slice: z.unknown().optional(),
    file: z.unknown().optional(),
    approved: z.unknown().optional(),
    etag: z.unknown().optional(),
    kind: z.unknown().optional(),
  })
  .passthrough()
  .refine((value) => RETRIEVE_OUTPUT_KEYS.some((key) => key in value), {
    message: "Unrecognized sdl.retrieve response shape",
  });

/** Publish each available retrieve operation's authoritative nested arguments. */
export function buildRetrieveWireSchema(
  actionMap: ActionMap,
): Record<string, unknown> {
  const envelope = zodSchemaToJsonSchema(RetrieveRequestSchema);
  const properties = envelope.properties as Record<
    string,
    Record<string, unknown>
  >;
  const variants = Object.entries(RETRIEVE_ACTION_BY_OP).flatMap(
    ([op, actionName]) => {
      const action = actionMap[actionName];
      if (!action) return [];

      const variant = zodSchemaToJsonSchema(action.schema);
      const variantProperties = {
        ...(variant.properties as Record<string, unknown>),
      };
      // The retrieve envelope supplies repoId once for every operation.
      delete variantProperties.repoId;
      const required = Array.isArray(variant.required)
        ? variant.required.filter((field) => field !== "repoId")
        : undefined;

      return [
        {
          ...variant,
          title: op,
          properties: variantProperties,
          ...(required ? { required } : {}),
        },
      ];
    },
  );

  return compactJsonSchema({
    ...envelope,
    properties: {
      ...properties,
      args: {
        ...properties.args,
        anyOf: variants,
      },
    },
  });
}

export async function handleRetrieve(
  rawArgs: unknown,
  actionMap: ActionMap,
  context?: ToolContext,
): Promise<unknown> {
  const request = RetrieveRequestSchema.parse(rawArgs);
  const actionName = RETRIEVE_ACTION_BY_OP[request.op];
  const action = actionMap[actionName];

  if (!action) {
    throw new ValidationError(
      `Retrieval action ${actionName} is not available in this server configuration.`,
    );
  }

  const actionArgs = {
    repoId: request.repoId,
    ...request.args,
  };
  try {
    return await dispatchAction(
      actionName,
      actionArgs,
      actionMap,
      { kind: "retrieve", responseMode: request.responseMode },
      context,
    );
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;

    const details = error.issues.map((issue) => ({
      path: ["args", ...issue.path].join("."),
      message: issue.message,
    }));
    const validationError = new ValidationError(
      `Invalid tool arguments:\n${details
        .map((detail) => `  - ${detail.path}: ${detail.message}`)
        .join("\n")}`,
    );
    Object.assign(validationError, { details });
    throw validationError;
  }
}
