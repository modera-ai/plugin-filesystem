import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import iconv from "iconv-lite";
import { readWorkspace } from "../src/read";
import { WorkspaceWriter } from "../src/write";

async function fixture(
  run: (
    root: string,
    context: {
      workspacePath: string;
      sessionId: string;
      runId: string;
      signal: AbortSignal;
    },
  ) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "df-files-")));
  try {
    await run(root, {
      workspacePath: root,
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    });
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}

it("large files page without corrupting Unicode, reject stale versions and support UTF16/GB18030", () =>
  fixture(async (root, context) => {
    const contents = "你好🙂abc\n".repeat(180000);
    await writeFile(join(root, "large.txt"), contents);
    const page = (await readWorkspace({ path: "large.txt" }, context)) as {
      content: string;
      nextCursor: number;
      version: string;
      hasMore: boolean;
    };
    expect(page.content).not.toContain("�");
    expect(page.hasMore).toBe(true);
    const next = (await readWorkspace(
      { path: "large.txt", cursor: page.nextCursor, version: page.version },
      context,
    )) as { content: string };
    expect(contents.startsWith(page.content + next.content)).toBe(true);
    await writeFile(join(root, "large.txt"), "changed");
    await expect(
      readWorkspace(
        { path: "large.txt", cursor: 0, version: page.version },
        context,
      ),
    ).rejects.toThrow("changed");
    for (const encoding of ["utf16le", "utf16be", "gb18030"] as const) {
      const text =
        (encoding === "gb18030" ? "" : "\uFEFF") + "第一行\r\n第二行";
      await writeFile(join(root, "encoded.txt"), iconv.encode(text, encoding));
      const options = encoding === "gb18030" ? { encoding } : {};
      expect(
        await readWorkspace({ path: "encoded.txt", ...options }, context),
      ).toMatchObject({ encoding, content: "1: 第一行\n2: 第二行" });
      const writer = new WorkspaceWriter();
      const prepared = await writer.prepare(
        "edit",
        {
          path: "encoded.txt",
          ...options,
          searchContent: "第二行",
          replaceContent: "abc",
        },
        context,
      );
      await writer.execute("edit", prepared.input, context);
      expect(await readFile(join(root, "encoded.txt"))).toEqual(
        iconv.encode(text.replace("第二行", "abc"), encoding),
      );
    }
  }));
