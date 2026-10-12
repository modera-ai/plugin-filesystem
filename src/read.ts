import { opendir, stat } from "@modera/plugin-sdk/workspace-fs";
import { localPath } from "./write-path";
import { readText } from "./read-text";
import type { ToolContext } from "@modera/plugin-sdk";
import { extensionOf, mediaExtensions, readMedia } from "./media";
import { readOptions } from "./read-options";
import { hash } from "./file-snapshot";

export async function readWorkspace(
  input: unknown,
  context: ToolContext,
  resourcePath?: string,
): Promise<unknown> {
  const options = readOptions(
    input as {
      path: string;
      startLine?: number;
      endLine?: number;
      maxLines?: number;
      offset?: number;
      cursor?: number;
      version?: string;
    },
  );
  const { path, offset = 0 } = options;
  context.signal.throwIfAborted();
  const target = localPath(context.workspacePath ?? process.cwd(), path);
  if ((await stat(target)).isDirectory()) {
    if (options.cursor !== undefined || options.endLine !== undefined)
      throw new Error("Directories use offset, not cursor or endLine");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid directory offset");
    const entries: { name: string; type: string }[] = [];
    const initial = await stat(target);
    for await (const entry of await opendir(target)) {
      context.signal.throwIfAborted();
      if (entries.length >= 50000)
        throw new Error(
          "Directory exceeds 50000 entries; read a narrower directory",
        );
      entries.push({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : "file",
      });
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    const latest = await stat(target);
    if (
      initial.mtimeMs !== latest.mtimeMs ||
      initial.ctimeMs !== latest.ctimeMs
    )
      throw new Error("Directory changed while reading");
    const version = hash(JSON.stringify(entries));
    if (options.version && options.version !== version)
      throw new Error("Directory changed between pages; restart reading");
    const page = entries.slice(offset, offset + 200),
      hasMore = offset + page.length < entries.length;
    return {
      type: "directory",
      path,
      entries: page,
      version,
      empty: offset === 0 && entries.length === 0,
      hasMore,
      ...(hasMore ? { nextOffset: offset + page.length } : {}),
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
  if (options.offset !== undefined)
    throw new Error("Text files use line ranges or cursor, not offset");
  return readText(target, input as Parameters<typeof readText>[1], context);
}
