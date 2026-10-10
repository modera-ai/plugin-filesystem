import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
import type { ToolDefinition } from "@modera/plugin-sdk";
import { encodingSchema } from "./codec";
const common = {
  path: { type: "string", minLength: 1, maxLength: 2000 },
  encoding: encodingSchema,
};
export const createDefinition = declaredTool(manifest, "filesystem_create");
export const editDefinition = declaredTool(manifest, "filesystem_replace_edit");
