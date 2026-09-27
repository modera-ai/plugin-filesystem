import { opendir, open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readTarget } from "@modera/plugin-sdk";
import type { ComposerContribution } from "@modera/plugin-sdk";

export const workspaceMentions: ComposerContribution = {
  id: "modera.workspace.files", title: "Project files", kind: "mentionProvider",
  requiredPermissions: ["workspace.read"],
  async search(request, context) {
    if (!context.workspacePath) return { items: [] };
    const offset = Number(request.cursor ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("Invalid file cursor");
    const queue = ["."];
    const matches: { id: string; title: string }[] = [];
    let visited = 0;
    while (queue.length && visited < 20000) {
      context.signal.throwIfAborted();
      const directory = queue.shift()!;
      const { target } = await readTarget(context.workspacePath, directory);
      for await (const entry of await opendir(target)) {
        context.signal.throwIfAborted();
        if (++visited > 20000) break;
        if (entry.isSymbolicLink() || [".git", "node_modules", "dist", "out"].includes(entry.name)) continue;
        const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (path.length > 200) continue;
        if (entry.isDirectory()) {
          queue.push(path);
          if (path.toLowerCase().includes(request.query.toLowerCase())) matches.push({ id: path, title: `${path}/` });
        }
        else if (entry.isFile() && path.toLowerCase().includes(request.query.toLowerCase())) matches.push({ id: path, title: path });
      }
    }
    matches.sort((a, b) => a.id.localeCompare(b.id));
    return { items: matches.slice(offset, offset + 50), ...(offset + 50 < matches.length ? { nextCursor: String(offset + 50) } : {}) };
  },
  async resolve(request, context) {
    if (!context.workspacePath || !request.resourceId) throw new Error("Project file unavailable");
    context.signal.throwIfAborted();
    const { target } = await readTarget(context.workspacePath, request.resourceId);
      if ((await stat(target)).isDirectory()) {
        const entries: string[] = [];
        let truncated = false;
        for await (const entry of await opendir(target)) {
          context.signal.throwIfAborted();
          if (entry.isSymbolicLink()) continue;
          if (entries.length >= 500) { truncated = true; break; }
          entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
        }
        entries.sort();
        const text = `${request.resourceId}/\n${entries.join("\n")}`;
        return { text: text.slice(0, 100000), truncated: truncated || text.length > 100000, revision: createHash("sha256").update(text).digest("hex") };
      }
    const handle = await open(target, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Select a regular file");
      const buffer = Buffer.alloc(100001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      context.signal.throwIfAborted();
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new Error("Binary files must be attached instead");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { text: text.slice(0, 100000), truncated: info.size > bytesRead || text.length > 100000, revision: createHash("sha256").update(bytes).digest("hex") };
    } finally { await handle.close(); }
  },
};
