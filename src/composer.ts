import { opendir, open, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import ignore from "ignore";

import { detectEncoding, decodePrefix } from "./codec";
import { readTarget } from "@modera/plugin-sdk";
import type { ComposerContribution } from "@modera/plugin-sdk";

type FileEntry = { id: string; title: string };
const INDEX_TTL_MS = 15_000;
const MAX_ENTRIES = 8_000;
const ignored = new Set([".git", "node_modules", "dist", "out"]);
const cache = new Map<string, { at: number; entries: FileEntry[] }>();
const pending = new Map<string, Promise<FileEntry[]>>();

function visible(path: string): boolean {
  return (
    path.length <= 200 &&
    !path.split("/").some((segment) => ignored.has(segment))
  );
}

async function buildIndex(root: string): Promise<FileEntry[]> {
  const files: string[] = [];
  const directories = new Set<string>();
  const queue: {
    directory: string;
    rules: { base: string; matcher: ReturnType<typeof ignore> }[];
  }[] = [{ directory: ".", rules: [] }];
  let visited = 0;
  while (
    queue.length &&
    visited < 20_000 &&
    files.length + directories.size < MAX_ENTRIES
  ) {
    const { directory, rules } = queue.shift()!;
    const { target } = await readTarget(root, directory);
    const inherited = [...rules];
    try {
      const checked = await readTarget(
        root,
        directory === "." ? ".gitignore" : `${directory}/.gitignore`,
      );
      const body = await readFile(checked.target, "utf8");
      inherited.push({
        base: directory === "." ? "" : `${directory}/`,
        matcher: ignore().add(body),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for await (const entry of await opendir(target)) {
      if (++visited > 20_000) break;
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const path =
        directory === "." ? entry.name : `${directory}/${entry.name}`;
      if (!visible(path)) continue;
      let excluded = false;
      for (const rule of inherited) {
        const result = rule.matcher.test(
          path.slice(rule.base.length) + (entry.isDirectory() ? "/" : ""),
        );
        if (result.ignored) excluded = true;
        if (result.unignored) excluded = false;
      }
      if (excluded) continue;
      if (entry.isDirectory()) {
        queue.push({ directory: path, rules: inherited });
        directories.add(path);
      } else if (entry.isFile()) files.push(path);
      if (files.length + directories.size >= MAX_ENTRIES) break;
    }
  }
  return [
    ...[...directories].map((id) => ({ id, title: `${id}/` })),
    ...files.map((id) => ({ id, title: id })),
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_ENTRIES);
}

function fileIndex(root: string): Promise<FileEntry[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS)
    return Promise.resolve(hit.entries);
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const build = buildIndex(root)
    .then((entries) => {
      cache.set(root, { at: Date.now(), entries });
      return entries;
    })
    .finally(() => pending.delete(root));
  pending.set(root, build);
  return build;
}

export const workspaceMentions: ComposerContribution = {
  id: "modera.filesystem.files",
  title: "Project files",
  kind: "mentionProvider",
  requiredPermissions: ["workspace.read"],
  async search(request, context) {
    if (!context.workspacePath) return { items: [] };
    const offset = Number(request.cursor ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      throw new Error("Invalid file cursor");
    const entries = await fileIndex(context.workspacePath);
    context.signal.throwIfAborted();
    const query = request.query.toLowerCase();
    const matches = entries.filter((entry) =>
      entry.id.toLowerCase().includes(query),
    );
    return {
      items: matches.slice(offset, offset + 50),
      ...(offset + 50 < matches.length
        ? { nextCursor: String(offset + 50) }
        : {}),
    };
  },
  async resolve(request, context) {
    if (!context.workspacePath || !request.resourceId)
      throw new Error("Project file unavailable");
    context.signal.throwIfAborted();
    const { target } = await readTarget(
      context.workspacePath,
      request.resourceId,
    );
    if ((await stat(target)).isDirectory()) {
      const entries: string[] = [];
      let truncated = false;
      for await (const entry of await opendir(target)) {
        context.signal.throwIfAborted();
        if (entry.isSymbolicLink()) continue;
        if (entries.length >= 500) {
          truncated = true;
          break;
        }
        entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
      }
      entries.sort();
      const text = `${request.resourceId}/\n${entries.join("\n")}`;
      return {
        text: text.slice(0, 100000),
        truncated: truncated || text.length > 100000,
        revision: createHash("sha256").update(text).digest("hex"),
      };
    }
    const handle = await open(target, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Select a regular file");
      const buffer = Buffer.alloc(100001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      context.signal.throwIfAborted();
      const bytes = buffer.subarray(0, bytesRead);

      const encoding = detectEncoding(bytes);
      const page = decodePrefix(bytes, encoding, info.size <= bytesRead);
      const text = page.text.replace(/^\uFEFF/, "");
      return {
        text: text.slice(0, 100000),
        truncated: info.size > page.consumed || text.length > 100000,
        revision: createHash("sha256")
          .update(bytes.subarray(0, page.consumed))
          .digest("hex"),
      };
    } finally {
      await handle.close();
    }
  },
};
