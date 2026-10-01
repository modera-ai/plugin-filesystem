import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceMentions } from "../src/composer";

it("pages matching project files, resolves versions, and rejects traversal and binary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-mentions-"));
  const context = { workspacePath: root, projectId: "p", sessionId: "s", runId: "composer", signal: new AbortController().signal };
  try {
    await Promise.all(Array.from({ length: 55 }, (_, index) => writeFile(join(root, `note-${String(index).padStart(2, "0")}.txt`), "original")));
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "child.txt"), "child");
    const first = await workspaceMentions.search!({ query: "note", locale: "en" }, context);
    expect(first.items).toHaveLength(50);
    const second = await workspaceMentions.search!({ query: "note", locale: "en", cursor: first.nextCursor! }, context);
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(55);
    const request = { locale: "en", query: "", resourceId: first.items[0]!.id };
    const before = await workspaceMentions.resolve!(request, context);
    await writeFile(join(root, request.resourceId), "changed");
    const after = await workspaceMentions.resolve!(request, context);
    expect(after.text).toBe("changed");
    expect(after.revision).not.toBe(before.revision);
    await expect(workspaceMentions.resolve!({ ...request, resourceId: "../outside" }, context)).rejects.toThrow("outside project");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await expect(workspaceMentions.resolve!({ ...request, resourceId: "binary.bin" }, context)).rejects.toThrow("Binary");
    const directories = await workspaceMentions.search!({ query: "folder", locale: "en" }, context);
    expect(directories.items).toContainEqual({ id: "folder", title: "folder/" });
    const folder = await workspaceMentions.resolve!({ ...request, resourceId: "folder" }, context);
    expect(folder.text).toBe("folder/\nchild.txt");
    await writeFile(join(root, "folder", "second.txt"), "second");
    const changedFolder = await workspaceMentions.resolve!({ ...request, resourceId: "folder" }, context);
    expect(changedFolder.revision).not.toBe(folder.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses Git ignore rules for file mentions when the workspace is a repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-mentions-git-"));
  const context = { workspacePath: root, projectId: "p", sessionId: "s", runId: "composer", signal: new AbortController().signal };
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "hidden.txt\n");
    await writeFile(join(root, "hidden.txt"), "ignored");
    await writeFile(join(root, "visible.txt"), "shown");
    const result = await workspaceMentions.search!({ query: ".txt", locale: "en" }, context);
    expect(result.items.map(item => item.id)).toEqual(["visible.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
