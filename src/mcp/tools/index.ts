import type { z } from "zod";

import type { MCPServer } from "../../server.js";
import { createMemoryHintHook } from "../hooks/memory-hint.js";
import { registerGatewayTools } from "../../gateway/index.js";
import { InfoRequestSchema, handleInfo } from "./info.js";
import type { ToolServices } from "../../gateway/index.js";
import { createActionMap } from "../../gateway/router.js";
import {
  assertCodeModeProjectionProfiles,
  registerActionSearchTool,
  registerCodeModeTools,
} from "../../code-mode/index.js";
import type { CodeModeConfig, GatewayConfig } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../../config/memory-config.js";
import {
  InfoResponseSchema,
  withProjectionOutputSchema,
  withProjectionSuccessOutputSchema,
} from "../tools.js";
import {
  assertProjectionProfilesForActions,
  canonicalActionName,
} from "../response-projection/registry.js";
import {
  buildFlatToolDescriptors,
  registerFlatTools,
} from "./tool-descriptors.js";

export function getPublicFlatToolNames(
  services: ToolServices = {},
): readonly string[] {
  return [
    "sdl.action.search",
    "sdl.info",
    ...buildFlatToolDescriptors(services).map((descriptor) => descriptor.name),
  ];
}

export function registerTools(
  server: MCPServer,
  services: ToolServices = {},
  gatewayConfig?: GatewayConfig,
  codeModeConfig?: CodeModeConfig,
): void {
  // Registration captures the public projection/error union, not only the
  // canonical handler shape, for every direct, gateway, and code-mode tool.
  server = new Proxy(server, {
    get(target, property, receiver): unknown {
      if (property === "registerTool") {
        const registerTool: MCPServer["registerTool"] = (
          name,
          description,
          inputSchema,
          handler,
          wireSchema,
          presentation,
          outputSchema,
          validationOutputSchema,
        ) => {
          const action = canonicalActionName(name);
          const exhaustiveSchema = validationOutputSchema ?? outputSchema;
          const projectedValidationSchema =
            exhaustiveSchema === undefined
              ? undefined
              : withProjectionOutputSchema(action, exhaustiveSchema);
          return target.registerTool(
            name,
            description,
            inputSchema,
            handler,
            wireSchema,
            presentation,
            validationOutputSchema === undefined
              ? projectedValidationSchema
              : outputSchema,
            validationOutputSchema === undefined
              ? undefined
              : projectedValidationSchema,
          );
        };
        return registerTool;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  // Tool visibility is fixed once at server registration so every projection
  // sees the same static action set for the lifetime of this process.
  const stableServices: ToolServices = {
    ...services,
    actionAvailability: {
      memoryTools:
        services.actionAvailability?.memoryTools
        ?? anyRepoHasMemoryTools(loadConfig()),
      infoTool: true,
    },
  };
  const descriptors = buildFlatToolDescriptors(stableServices);
  const publicSuccessOutputSchemaByAction = new Map<string, z.ZodType>();
  for (const descriptor of descriptors) {
    if (descriptor.outputSchema) {
      const action = canonicalActionName(descriptor.name);
      publicSuccessOutputSchemaByAction.set(
        action,
        withProjectionSuccessOutputSchema(action, descriptor.outputSchema),
      );
    }
  }

  assertProjectionProfilesForActions(
    getPublicFlatToolNames(stableServices),
    "flat MCP",
  );
  assertCodeModeProjectionProfiles();

  // Register memory hint hook for all modes
  server.registerPostDispatchHook(createMemoryHintHook());

  // Universal discovery surface
  registerActionSearchTool(server, stableServices);

  server.registerTool(
    "sdl.info",
    "Get unified SDL-MCP runtime, config, logging, Ladybug, and native-addon status.",
    InfoRequestSchema,
    handleInfo,
    undefined,
    { title: "SDL Info" },
    InfoResponseSchema,
  );

  // Code Mode exclusive: register universal tools plus code-mode tools only
  if (codeModeConfig?.enabled && codeModeConfig?.exclusive) {
    registerCodeModeTools(
      server,
      stableServices,
      codeModeConfig,
      undefined,
      publicSuccessOutputSchemaByAction,
    );
    return;
  }

  if (gatewayConfig?.enabled) {
    server.gatewayMode = true;

    // When both gateway and code-mode are active, share one actionMap
    const sharedActionMap = codeModeConfig?.enabled
      ? createActionMap(
          stableServices.liveIndex,
          stableServices.actionAvailability,
        )
      : undefined;

    registerGatewayTools(
      server,
      stableServices,
      {
        enabled: true,
        emitLegacyTools: gatewayConfig.emitLegacyTools ?? true,
        toolNameFormat: gatewayConfig.toolNameFormat,
      },
      sharedActionMap,
    );

    // Code Mode alongside gateway — reuse shared action map
    if (codeModeConfig?.enabled && sharedActionMap) {
      registerCodeModeTools(
        server,
        stableServices,
        codeModeConfig,
        sharedActionMap,
        publicSuccessOutputSchemaByAction,
      );
    }
    return;
  }

  // Flat tool registration: declarative descriptors registered in a loop
  registerFlatTools(server, descriptors);

  // Code Mode alongside flat tools
  if (codeModeConfig?.enabled) {
    registerCodeModeTools(
      server,
      stableServices,
      codeModeConfig,
      undefined,
      publicSuccessOutputSchemaByAction,
    );
  }
}
