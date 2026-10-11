import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
export const createDefinition = declaredTool(manifest, "filesystem_create");
export const editDefinition = declaredTool(manifest, "filesystem_replace_edit");
export const copyDefinition = declaredTool(manifest, "filesystem_copy");
