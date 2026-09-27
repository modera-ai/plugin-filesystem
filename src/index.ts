import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
import type {
  PluginModule,
  ToolDefinition,
} from "@modera/plugin-sdk";
import { readWorkspace } from "./read";
import { WorkspaceWriter } from "./write";
import { createDefinition, editDefinition } from "./write-definitions";
import { writeUi } from "./ui";
import { encodingSchema } from "./codec";
import { BatchWriter, batchDefinition } from "./batch";
import { WriteQueue } from "./write-queue";
import { workspaceMentions } from "./composer";

const readDefinition = declaredTool(manifest, "workspace_read");
export const activate: PluginModule["activate"] = async (host) => {
  const queue = new WriteQueue();
  const writer = new WorkspaceWriter(queue);
  const batch = new BatchWriter(queue);
  host.signal.addEventListener(
    "abort",
    () => {
      writer.clear();
      batch.clear();
    },
    { once: true },
  );
  return {
    composer: [workspaceMentions],
    ui: writeUi(),
    tools: [
      {
        definition: readDefinition,
        isAvailable: (context) => !!context.workspacePath,
        execute: readWorkspace,
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
        isAvailable: (context: import("@modera/plugin-sdk").ToolContext) =>
          !!context.workspacePath,
        execute: (
          input: unknown,
          context: import("@modera/plugin-sdk").ToolContext,
        ) => writer.execute(kind, input, context),
      })),
      {
        definition: batchDefinition,
        isAvailable: (context) => !!context.workspacePath,
        prepare: (input, context) => batch.prepare(input, context),
        execute: (input, context) => batch.execute(input, context),
      },
    ],
  };
};
