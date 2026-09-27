import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceMentions } from "../src/composer";

it("pages matching project files, resolves versions, and rejects traversal and binary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-mentions-"));
  const context = { workspacePath: root, projectId: "p", sessionId: "s", runId: "composer", signal: new AbortController().signal };
  try {
    await Promise.all(Array.from({ length: 55 }, (_, index) => writeFile(join(root, `note-${String(index).padStart(2, "0")}.txt`), "original")));
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
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "child.txt"), "child");
    const directories = await workspaceMentions.search!({ query: "folder", locale: "en" }, context);
    expect(directories.items).toContainEqual({ id: "folder", title: "folder/" });
    const folder = await workspaceMentions.resolve!({ ...request, resourceId: "folder" }, context);
    expect(folder.text).toBe("folder/\nchild.txt");
    await writeFile(join(root, "folder", "second.txt"), "second");
    const changedFolder = await workspaceMentions.resolve!({ ...request, resourceId: "folder" }, context);
    expect(changedFolder.revision).not.toBe(folder.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});
