import { opendir, stat } from "node:fs/promises";
import { readTarget } from "@modera/plugin-sdk";
import { readText } from "./read-text";
import type { ToolContext } from "@modera/plugin-sdk";
import { extensionOf, mediaExtensions, readMedia } from "./media";

export async function readWorkspace(
  input: unknown,
  context: ToolContext,
  resourcePath?: string,
): Promise<unknown> {
  const {
    path,
    startLine = 1,
    maxLines = 100,
    offset = 0,
  } = input as {
    path: string;
    startLine?: number;
    maxLines?: number;
    offset?: number;
  };
  context.signal.throwIfAborted();
  const { target } = await readTarget(context.workspacePath!, path);
  if ((await stat(target)).isDirectory()) {
    const entries: { name: string; type: string }[] = [];
    let index = 0;
    let hasMore = false;
    for await (const entry of await opendir(target)) {
      context.signal.throwIfAborted();
      if (index++ < offset) continue;
      if (entries.length === 200) {
        hasMore = true;
        break;
      }
      entries.push({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : "file",
      });
    }
    return {
      type: "directory",
      path,
      entries,
      empty: offset === 0 && entries.length === 0,
      hasMore,
      ...(hasMore ? { nextOffset: offset + entries.length } : {}),
    };
  }
  if (mediaExtensions.has(extensionOf(target))) {
    if (!resourcePath)
      throw new Error("Filesystem media resources are unavailable");
    const options = input as Parameters<typeof readMedia>[1] & {
      cursor?: number;
      offset?: number;
    };
    if (options.cursor !== undefined || options.offset !== undefined)
      throw new Error(
        "Images/documents use startLine/maxLines, not byte cursor or directory offset",
      );
    return readMedia(target, options, context, resourcePath);
  }
  return readText(target, input as Parameters<typeof readText>[1], context);
}
