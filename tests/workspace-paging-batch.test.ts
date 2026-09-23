import { mkdtemp, writeFile, readFile, rm, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import iconv from "iconv-lite";
import { readWorkspace } from "../src/read";
import { WorkspaceWriter } from "../src/write";
import { BatchWriter } from "../src/batch";
import { WriteQueue } from "../src/write-queue";
import { commitBatch } from "../src/batch-transaction";
import { snapshot } from "../src/file-snapshot";

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

it("batch previews without writes, applies ordered edits, preserves encoding and rejects stale/duplicate files", () =>
  fixture(async (root, context) => {
    const writer = new BatchWriter(new WriteQueue());
    await writeFile(join(root, "a.txt"), "one\ntwo");
    await writeFile(join(root, "b.txt"), "two");
    const input = {
      files: ["a.txt", "b.txt"].map((path) => ({
        path,
        edits: [{ searchContent: "two", replaceContent: "three" }],
      })),
    };
    const prepared = await writer.prepare(input, context);
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("two");
    expect(await writer.execute(prepared.input, context)).toMatchObject({
      status: "applied",
      files: [{ path: "a.txt" }, { path: "b.txt" }],
    });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\nthree");
    await expect(writer.execute(prepared.input, context)).rejects.toThrow(
      "approval",
    );
    const next = await writer.prepare(
      {
        files: [
          {
            path: "a.txt",
            edits: [{ searchContent: "three", replaceContent: "four" }],
          },
        ],
      },
      context,
    );
    await writeFile(join(root, "a.txt"), "external");
    await expect(writer.execute(next.input, context)).rejects.toThrow(
      "changed",
    );
    await expect(
      writer.prepare({ files: [input.files[1], input.files[1]] }, context),
    ).rejects.toThrow();
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".modera")),
    ).toEqual([]);
  }));

it("batch compensates prior writes if a later atomic rename fails", () =>
  fixture(async (root, context) => {
    await writeFile(join(root, "a.txt"), "before");
    await writeFile(join(root, "b.txt"), "before");
    const writer = new BatchWriter(new WriteQueue());
    const plan = await writer.prepare(
      {
        files: ["a.txt", "b.txt"].map((path) => ({
          path,
          edits: [{ searchContent: "before", replaceContent: "after" }],
        })),
      },
      context,
    );
    let calls = 0;
    const changes = await Promise.all(
      ["a.txt", "b.txt"].map(async (path) => ({
        path,
        target: join(root, path),
        before: (await snapshot(join(root, path)))!,
        after: "after",
      })),
    );
    await expect(
      commitBatch(changes, root, context, async (...args) => {
        if (++calls === 2) throw new Error("injected rename failure");
        return fs.rename(...args);
      }),
    ).rejects.toThrow("injected");
    plan.dispose();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("before");
    expect((await readdir(root)).sort()).toEqual(["a.txt", "b.txt"]);
  }));
