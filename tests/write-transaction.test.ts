import { it, expect, vi, afterEach } from "vitest";
const failure = vi.hoisted(() => ({
  at: "",
  once: false,
  afterRename: undefined as (() => void | Promise<void>) | undefined,
}));
vi.mock("@modera/plugin-sdk/workspace-fs", async (original) => {
  const actual = await original<typeof import("@modera/plugin-sdk/workspace-fs")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (
        to.replace(/\\/g, "/").split("/").pop() ===
          failure.at.replace(/\\/g, "/").split("/").pop() &&
        failure.once
      ) {
        failure.once = false;
        throw new Error("Injected publication failure");
      }
      await actual.rename(from, to);
      await failure.afterRename?.();
    },
  };
});
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceWriter } from "../src/write";
afterEach(() => {
  failure.at = "";
  failure.once = false;
  failure.afterRename = undefined;
});

async function fixture(
  run: (
    root: string,
    writer: WorkspaceWriter,
    context: any,
    controller: AbortController,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "modera-transaction-")),
    controller = new AbortController();
  try {
    await writeFile(join(root, "source"), "a\nb\n");
    await writeFile(join(root, "target"), "x\n");
    await run(
      root,
      new WorkspaceWriter(),
      {
        workspacePath: root,
        sessionId: "s",
        projectId: "p",
        runId: "r",
        signal: controller.signal,
      },
      controller,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const input = {
  path: "target",
  sourceFilePath: "source",
  sourceStartLine: 1,
  deleteSource: true,
};
it("preserves external changes during rollback and reports the affected path", () =>
  fixture(async (root, writer, context) => {
    const prepared = await writer.prepare("copy", input, context);
    failure.at = join(root, "source");
    failure.once = true;
    failure.afterRename = async () => {
      failure.afterRename = undefined;
      await writeFile(join(root, "target"), "external\n");
    };
    await expect(
      writer.execute("copy", prepared.input, context),
    ).rejects.toThrow("rollback incomplete for target");
    expect(await readFile(join(root, "target"), "utf8")).toBe("external\n");
    expect(await readFile(join(root, "source"), "utf8")).toBe("a\nb\n");
    expect((await readdir(root)).sort()).toEqual(["source", "target"]);
  }));
it("rolls back the target when cross-file source publication fails and cleans staging files", () =>
  fixture(async (root, writer, context) => {
    const prepared = await writer.prepare("copy", input, context);
    failure.at = join(root, "source");
    failure.once = true;
    await expect(
      writer.execute("copy", prepared.input, context),
    ).rejects.toThrow("Injected");
    expect(await readFile(join(root, "source"), "utf8")).toBe("a\nb\n");
    expect(await readFile(join(root, "target"), "utf8")).toBe("x\n");
    expect((await readdir(root)).sort()).toEqual(["source", "target"]);
  }));
it("removes a newly published target and empty parents when a cut fails", () =>
  fixture(async (root, writer, context) => {
    const prepared = await writer.prepare(
      "copy",
      { ...input, path: "nested/new" },
      context,
    );
    failure.at = join(root, "source");
    failure.once = true;
    await expect(
      writer.execute("copy", prepared.input, context),
    ).rejects.toThrow("Injected");
    expect((await readdir(root)).sort()).toEqual(["source", "target"]);
    expect(await readFile(join(root, "source"), "utf8")).toBe("a\nb\n");
  }));
it("rolls back an already published target when cancellation interrupts a cut", () =>
  fixture(async (root, writer, context, controller) => {
    const prepared = await writer.prepare("copy", input, context);
    failure.afterRename = () => {
      failure.afterRename = undefined;
      controller.abort();
    };
    await expect(
      writer.execute("copy", prepared.input, context),
    ).rejects.toThrow();
    expect(await readFile(join(root, "target"), "utf8")).toBe("x\n");
    expect(await readFile(join(root, "source"), "utf8")).toBe("a\nb\n");
    expect((await readdir(root)).sort()).toEqual(["source", "target"]);
  }));
