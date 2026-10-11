import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceWriter } from "../src/write";
import { copyText } from "../src/copy-text";
import { encodeText, decodeText } from "../src/codec";
import { replaceText } from "../src/edit-text";
import { readWorkspace } from "../src/read";
import { localPath } from "../src/write-path";
import { homedir } from "node:os";
import { WriteQueue } from "../src/write-queue";
import { activate } from "../src";
import { ToolRegistry } from "@modera-host/agent-host/src/tool-registry";
import { ToolExecutor } from "@modera-host/agent-host/src/tool-executor";

async function fixture(
  run: (root: string, writer: WorkspaceWriter, context: any) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "modera-copy-"));
  try {
    await run(root, new WorkspaceWriter(), {
      workspacePath: root,
      sessionId: "s",
      projectId: "p",
      runId: "r",
      signal: new AbortController().signal,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("copies without writing until approval and binds both snapshots, arguments and session", () =>
  fixture(async (root, writer, context) => {
    await writeFile(join(root, "source"), "a\nb\nc\n");
    await writeFile(join(root, "target"), "x\r\ny\r\n");
    const input = {
      path: "target",
      sourceFilePath: "source",
      sourceStartLine: 2,
      sourceEndLine: 3,
      targetLine: 1,
      position: "after",
    };
    const prepared = await writer.prepare("copy", input, context);
    expect(prepared.preview).toMatchObject({
      after: "x\r\nb\r\nc\r\ny\r\n",
      changes: [{ path: "target" }],
    });
    expect(await readFile(join(root, "target"), "utf8")).toBe("x\r\ny\r\n");
    await expect(
      writer.execute(
        "copy",
        { ...prepared.input, deleteSource: true },
        context,
      ),
    ).rejects.toThrow("preview");
    await expect(
      writer.execute("copy", prepared.input, {
        ...context,
        sessionId: "other",
      }),
    ).rejects.toThrow("preview");
    await writeFile(join(root, "source"), "changed\n");
    await expect(
      writer.execute("copy", prepared.input, context),
    ).rejects.toThrow("changed");
    expect(await readFile(join(root, "target"), "utf8")).toBe("x\r\ny\r\n");
  }));

it("cuts across files, inherits BOM/encoding for a new target and keeps an emptied source", () =>
  fixture(async (root, writer, context) => {
    const content = "\uFEFF你好\r\n世界\r\n";
    await writeFile(join(root, "source"), encodeText(content, "utf16le"));
    const prepared = await writer.prepare(
      "copy",
      {
        path: "nested/target",
        sourceFilePath: "source",
        sourceStartLine: 1,
        sourceEndLine: 99,
        deleteSource: true,
      },
      context,
    );
    expect(prepared.preview).toMatchObject({
      encoding: "utf16le",
      changes: [{ path: "nested/target" }, { path: "source", after: "\uFEFF" }],
    });
    await writer.execute("copy", prepared.input, context);
    expect(decodeText(await readFile(join(root, "nested/target"))).text).toBe(
      content,
    );
    expect(decodeText(await readFile(join(root, "source"))).text).toBe(
      "\uFEFF",
    );
    await expect(
      writer.execute("copy", prepared.input, context),
    ).rejects.toThrow("preview");
    expect(await readdir(join(root, "nested"))).toEqual(["target"]);
  }));

it("uses original coordinates for same-file moves, swaps ranges and rejects overlapping/no-op cuts", () => {
  const input = {
    path: "f",
    sourceFilePath: "f",
    sourceStartLine: 2,
    sourceEndLine: 3,
    deleteSource: true,
  };
  expect(
    copyText("a\nb\nc\nd\ne\n", "a\nb\nc\nd\ne\n", true, input).after,
  ).toBe("a\nd\ne\nb\nc\n");
  expect(
    copyText("a\nb\nc\nd\ne", "a\nb\nc\nd\ne", true, {
      ...input,
      sourceStartLine: 4,
      sourceEndLine: 3,
      targetLine: 1,
    }).after,
  ).toBe("c\nd\na\nb\ne");
  expect(() =>
    copyText("a\nb\nc", "a\nb\nc", true, { ...input, targetLine: 2 }),
  ).toThrow("overlap");
  expect(() =>
    copyText("a\nb\nc", "a\nb\nc", true, {
      ...input,
      mode: "replace",
      targetLine: 1,
      targetEndLine: 2,
    }),
  ).toThrow("overlap");
  expect(() =>
    copyText("a", "x", false, { ...input, targetEndLine: 1 }),
  ).toThrow("Source range");
});

it("preserves unrelated mixed newlines and target EOF while adapting pasted lines", () => {
  const input = { path: "f", sourceFilePath: "s", sourceStartLine: 1 };
  expect(
    copyText("new\n", "a\r\nb\nc", false, { ...input, targetLine: 2 }).after,
  ).toBe("a\r\nnew\r\nb\nc");
  expect(copyText("new\n", "a\r\nb\nc", false, input).after).toBe(
    "a\r\nb\nc\r\nnew",
  );
  expect(
    copyText("a\r\nb\nc\r\n", "x\n", false, {
      ...input,
      sourceStartLine: 2,
      deleteSource: true,
    }).sourceAfter,
  ).toBe("a\r\nc\r\n");
  expect(
    copyText("new\n", "a\nb\n", false, {
      ...input,
      mode: "replace",
      targetLine: 2,
      targetEndLine: 1,
    }).after,
  ).toBe("new\n");
  expect(
    copyText("new\n", "a\r\nb\r", false, { ...input, targetLine: 1 }).after,
  ).toBe("new\r\na\r\nb\r");
});

it("copies many short lines within the file limit without overflowing the argument stack", () => {
  const source = "a\n".repeat(150000);
  const result = copyText(source, null, false, {
    path: "target",
    sourceFilePath: "source",
    sourceStartLine: 1,
    sourceEndLine: 150000,
  });
  expect(result.after).toBe(source);
  expect(result.totalLines).toBe(150000);
  expect(result.omittedContent).toBe(true);
});

it("previews formatted copy/create content before approval", () =>
  fixture(async (root, _, context) => {
    const writer = new WorkspaceWriter(undefined, async () => ({
      autoFormat: true,
    }));
    await writeFile(join(root, "source.ts"), "const x=1\n");
    const prepared = await writer.prepare(
      "copy",
      { path: "target.ts", sourceFilePath: "source.ts", sourceStartLine: 1 },
      context,
    );
    expect(prepared.preview).toMatchObject({
      formatted: true,
      after: "const x = 1;\n",
    });
    await writer.execute("copy", prepared.input, context);
    expect(await readFile(join(root, "target.ts"), "utf8")).toBe(
      "const x = 1;\n",
    );
    expect(
      await writer.inspect(
        "create",
        { path: "new.ts", content: "const y=2" },
        context,
      ),
    ).toMatchObject({ formatted: true, after: "const y = 2;\n" });
  }));

it("recovers copied line prefixes and opt-in indentation without accepting ambiguous structure", () => {
  expect(replaceText("a\nb\n", "1: a\n2: b", "c", undefined).after).toBe("c\n");
  const python = "if True:\n    value = 1\n    print(value)\n";
  expect(() =>
    replaceText(
      python,
      "value = 1\nprint(value)",
      "value = 2\nprint(value)",
      undefined,
      false,
      "a.py",
    ),
  ).toThrow("not found");
  expect(
    replaceText(
      python,
      "value = 1\nprint(value)",
      "value = 2\nprint(value)",
      undefined,
      true,
      "a.py",
    ),
  ).toMatchObject({
    matchType: "indentation",
    after: "if True:\n    value = 2\n    print(value)\n",
  });
  expect(() =>
    replaceText("  a\n    b\n", "a\nb", "c", undefined, true, "a.py"),
  ).toThrow("not found");
  expect(() =>
    replaceText("  a\n  a\n", "a", "b", undefined, true, "a.py"),
  ).toThrow("Ambiguous");
});

it("reads reversed inclusive ranges with bounds and rejects changed directory continuations", () =>
  fixture(async (root, _, context) => {
    await writeFile(join(root, "f"), "a\nb\nc\nd");
    expect(
      await readWorkspace({ path: "f", startLine: 3, endLine: 2 }, context),
    ).toMatchObject({ content: "2: b\n3: c" });
    const directory = (await readWorkspace({ path: "." }, context)) as {
      version: string;
    };
    await writeFile(join(root, "a"), "x");
    await expect(
      readWorkspace(
        { path: ".", offset: 1, version: directory.version },
        context,
      ),
    ).rejects.toThrow("changed");
    expect(await readWorkspace({ path: "." }, context)).toMatchObject({
      entries: [{ name: "a" }, { name: "f" }],
    });
    expect(localPath(root, "~/x")).toBe(join(homedir(), "x"));
  }));

it.each(["allow", "deny", "conflict", "cancel"])(
  "previews both cut files once in the real host approval flow: %s",
  (decision) =>
    fixture(async (root, _, context) => {
      await writeFile(join(root, "source"), "a\nb\n");
      await writeFile(join(root, "target"), "x\n");
      const controller = new AbortController(),
        grants = new Set<"workspace.read" | "workspace.write">([
          "workspace.read",
          "workspace.write",
        ]);
      context.signal = controller.signal;
      const contribution = await activate({
        pluginId: "modera.filesystem",
        storagePath: root,
        signal: context.signal,
        grantedPermissions: grants,
      });
      const registry = new ToolRegistry();
      for (const tool of contribution!.tools!)
        registry.register("modera.filesystem", tool);
      let approvals = 0;
      const executor = new ToolExecutor(
        registry,
        async (call) => {
          approvals++;
          expect(call.approvalPreview).toMatchObject({
            changes: [
              { path: "target", after: "x\na\n" },
              { path: "source", after: "b\n" },
            ],
          });
          expect(await readFile(join(root, "source"), "utf8")).toBe("a\nb\n");
          expect(await readFile(join(root, "target"), "utf8")).toBe("x\n");
          if (decision === "conflict")
            await writeFile(join(root, "source"), "external\n");
          if (decision === "cancel") controller.abort();
          return decision !== "deny";
        },
        grants,
      );
      const result = JSON.parse(
        await executor.execute(
          {
            id: "cut",
            name: "filesystem_copy",
            input: {
              path: "target",
              sourceFilePath: "source",
              sourceStartLine: 1,
              deleteSource: true,
            },
          },
          context,
        ),
      );
      expect(approvals).toBe(1);
      if (decision === "allow") {
        expect(result.status).toBe("applied");
        expect(await readFile(join(root, "source"), "utf8")).toBe("b\n");
        expect(await readFile(join(root, "target"), "utf8")).toBe("x\na\n");
      } else {
        expect(result.error).toBeTruthy();
        expect(await readFile(join(root, "source"), "utf8")).toBe(
          decision === "conflict" ? "external\n" : "a\nb\n",
        );
        expect(await readFile(join(root, "target"), "utf8")).toBe("x\n");
      }
    }),
);

it("serializes shared file lanes while allowing unrelated writes and recovers after errors", async () => {
  const queue = new WriteQueue(),
    events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    events.push("first");
    await gate;
    events.push("done");
  }, ["a", "b"]);
  const second = queue.run(async () => {
    events.push("second");
  }, ["b", "c"]);
  await queue.run(async () => {
    events.push("other");
  }, ["d"]);
  expect(events).toEqual(["first", "other"]);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(["first", "other", "done", "second"]);
  await expect(
    queue.run(async () => {
      throw new Error("failed");
    }, ["a"]),
  ).rejects.toThrow("failed");
  await expect(queue.run(async () => 1, ["a"])).resolves.toBe(1);
});
