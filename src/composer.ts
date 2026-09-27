import { opendir, open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readTarget } from "@modera/plugin-sdk";
import type { ComposerContribution } from "@modera/plugin-sdk";

type FileEntry = { id: string; title: string };
const INDEX_TTL_MS = 15_000;
const MAX_ENTRIES = 8_000;
const ignored = new Set([".git", "node_modules", "dist", "out"]);
const cache = new Map<string, { at: number; entries: FileEntry[] }>();
const pending = new Map<string, Promise<FileEntry[]>>();

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise(resolve => {
    const child = spawn("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 4_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { failed = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timer);
      resolve(failed || code !== 0 ? null : Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
    });
  });
}

function visible(path: string): boolean {
  return path.length <= 200 && !path.split("/").some(segment => ignored.has(segment));
}

async function buildIndex(root: string): Promise<FileEntry[]> {
  const git = await gitFiles(root);
  const files: string[] = [];
  const directories = new Set<string>();
  if (git) {
    for (const path of git) {
      const normalized = path.replaceAll("\\", "/");
      if (!visible(normalized)) continue;
      files.push(normalized);
      for (let at = normalized.indexOf("/"); at > 0; at = normalized.indexOf("/", at + 1)) directories.add(normalized.slice(0, at));
    }
  } else {
    const queue = ["."];
    let visited = 0;
    while (queue.length && visited < 20_000 && files.length + directories.size < MAX_ENTRIES) {
      const directory = queue.shift()!;
      const { target } = await readTarget(root, directory);
      for await (const entry of await opendir(target)) {
        if (++visited > 20_000) break;
        if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
        const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (!visible(path)) continue;
        if (entry.isDirectory()) { queue.push(path); directories.add(path); }
        else if (entry.isFile()) files.push(path);
        if (files.length + directories.size >= MAX_ENTRIES) break;
      }
    }
  }
  return [
    ...[...directories].map(id => ({ id, title: `${id}/` })),
    ...files.map(id => ({ id, title: id })),
  ].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_ENTRIES);
}

function fileIndex(root: string): Promise<FileEntry[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return Promise.resolve(hit.entries);
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const build = buildIndex(root).then(entries => { cache.set(root, { at: Date.now(), entries }); return entries; }).finally(() => pending.delete(root));
  pending.set(root, build);
  return build;
}

export const workspaceMentions: ComposerContribution = {
  id: "modera.workspace.files", title: "Project files", kind: "mentionProvider",
  requiredPermissions: ["workspace.read"],
  async search(request, context) {
    if (!context.workspacePath) return { items: [] };
    const offset = Number(request.cursor ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("Invalid file cursor");
    const entries = await fileIndex(context.workspacePath);
    context.signal.throwIfAborted();
    const query = request.query.toLowerCase();
    const matches = entries.filter(entry => entry.id.toLowerCase().includes(query));
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
