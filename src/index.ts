import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
import type { PluginModule } from "@modera/plugin-sdk";
import { readWorkspace } from "./read";
import { WorkspaceWriter } from "./write";
import { createDefinition, editDefinition } from "./write-definitions";
import { writeUi } from "./ui";
import { WriteQueue } from "./write-queue";
import { workspaceMentions } from "./composer";

const readDefinition = declaredTool(manifest, "filesystem_read");
export const activate: PluginModule["activate"] = async (host) => {
  const queue = new WriteQueue();
  const writer = new WorkspaceWriter(queue, async (context) => {
    const values = (await host.config?.read(context.projectId))?.values;
    return {
      autoFormat: values?.autoFormat === true,
      fuzzyMatching: values?.fuzzyMatching === true,
    };
  });
  host.signal.addEventListener(
    "abort",
    () => {
      writer.clear();
    },
    { once: true },
  );
  return {
    composer: [workspaceMentions],
    ui: writeUi(),
    tools: [
      {
        definition: readDefinition,
        isAvailable: () => true,
        execute: (input, context) =>
          readWorkspace(input, context, host.resourcePath),
      },
      ...(
        [
          [createDefinition, "create"],
          [editDefinition, "edit"],
        ] as const
      ).map(([definition, kind]) => ({
        definition,
        prepare: (
          input: unknown,
          context: import("@modera/plugin-sdk").ToolContext,
        ) => writer.prepare(kind, input, context),
        isAvailable: () => true,
        execute: (
          input: unknown,
          context: import("@modera/plugin-sdk").ToolContext,
        ) => writer.execute(kind, input, context),
      })),
    ],
  };
};
