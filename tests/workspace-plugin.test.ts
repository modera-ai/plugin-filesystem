import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activate } from "../src";

it("reads bounded numbered lines and accepts absolute and parent paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "modera-workspace-test-"));
  const root = join(parent, "project");
  await mkdir(root);
  try {
    await writeFile(join(root, "sample.txt"), "one\ntwo\nthree");
    const contributions = await activate({
      pluginId: "modera.filesystem",
      storagePath: root,
      grantedPermissions: new Set(["workspace.read"]),
      signal: new AbortController().signal,
    });
    const tool = contributions!.tools![0]!;
    expect(contributions!.tools!.map((item) => item.definition.id)).toEqual([
      "filesystem_read",
      "filesystem_create",
      "filesystem_replace_edit",
      "filesystem_copy",
    ]);
    const context = {
      sessionId: "s",
      runId: "r",
      workspacePath: root,
      signal: new AbortController().signal,
    };
    expect(await tool.execute({ path: "." }, context)).toMatchObject({
      type: "directory",
      empty: false,
      entries: [{ name: "sample.txt", type: "file" }],
      hasMore: false,
    });
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        writeFile(join(root, `entry-${index}`), ""),
      ),
    );
    const first = (await contributions!.tools![0]!.execute(
      { path: "." },
      context,
    )) as { entries: { name: string }[]; hasMore: boolean; nextOffset: number };
    expect(first.entries).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const next = (await contributions!.tools![0]!.execute(
      { path: ".", offset: first.nextOffset },
      context,
    )) as { entries: { name: string }[]; hasMore: boolean };
    expect(next.entries).toHaveLength(2);
    expect(next.hasMore).toBe(false);
    expect(
      new Set([...first.entries, ...next.entries].map((entry) => entry.name))
        .size,
    ).toBe(202);
    expect(
      await tool.execute(
        { path: "sample.txt", startLine: 2, maxLines: 1 },
        context,
      ),
    ).toMatchObject({ content: "2: two", totalLines: 3 });
    expect(await tool.execute({ path: ".." }, context)).toMatchObject({
      type: "directory",
    });
    expect(
      await tool.execute({ path: join(root, "sample.txt") }, context),
    ).toMatchObject({ content: "1: one\n2: two\n3: three" });
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await expect(tool.execute({ path: "binary" }, context)).rejects.toThrow(
      "Binary",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("reports an empty directory without guessing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-empty-test-"));
  try {
    const contributions = await activate({
      pluginId: "test",
      storagePath: root,
      grantedPermissions: new Set(["workspace.read"]),
      signal: new AbortController().signal,
    });
    expect(
      await contributions!.tools![0]!.execute(
        { path: "." },
        {
          workspacePath: root,
          sessionId: "s",
          runId: "r",
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({
      type: "directory",
      path: ".",
      entries: [],
      version: expect.any(String),
      empty: true,
      hasMore: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
