import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { WorkspaceWriter } from "../src/write";
import { readWorkspace } from "../src/read";
it("creates, reads and edits outside the project using absolute and parent paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "filesystem-paths-"));
  try {
    const context = {
      workspacePath: join(root, "project"),
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    };
    const writer = new WorkspaceWriter();
    const path = join(root, "external/nested/file.txt");
    const create = { path, content: "old" };
    const preview = (await writer.execute("create", create, context)) as {
      previewId: string;
    };
    await writer.execute(
      "create",
      { ...create, mode: "apply", previewId: preview.previewId },
      context,
    );
    expect(
      await readWorkspace({ path: "../external/nested/file.txt" }, context),
    ).toMatchObject({ content: "1: old" });
    const edit = { path, searchContent: "old", replaceContent: "new" };
    const next = (await writer.execute("edit", edit, context)) as {
      previewId: string;
    };
    await writer.execute(
      "edit",
      { ...edit, mode: "apply", previewId: next.previewId },
      context,
    );
    expect(await readFile(path, "utf8")).toBe("new");
    expect(
      await readWorkspace({ path }, { ...context, workspacePath: undefined }),
    ).toMatchObject({ content: "1: new" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
