import { it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceWriter } from "../src/write";
import { activate } from "../src";
import { readPluginManifest } from "@modera/plugin-host/testing";

const manifest = readPluginManifest(new URL("..", import.meta.url));

import { AgentPluginRuntime as PluginRuntime } from "@modera/agent-host";
import { ToolRegistry } from "@modera-host/agent-host/src/tool-registry";
import { ToolExecutor } from "@modera-host/agent-host/src/tool-executor";

async function fixture(
  run: (
    root: string,
    writer: WorkspaceWriter,
    context: {
      workspacePath: string;
      sessionId: string;
      projectId: string;
      runId: string;
      signal: AbortSignal;
    },
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "modera-write-"));
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
const previewId = (value: unknown) =>
  (value as { previewId: string }).previewId;

it("creation is preview-only until apply, creates parents, refuses clobber and replay", () =>
  fixture(async (root, writer, context) => {
    const input = { path: "nested/hello.txt", content: "你好\r\n" };
    const review = await writer.inspect("create", input, context);
    expect(review).toMatchObject({
      status: "preview",
      before: "",
      after: input.content,
    });
    expect(await readdir(root)).toEqual([]);
    const id = previewId(await writer.execute("create", input, context));
    expect(await readdir(root)).toEqual([]);
    await expect(
      writer.execute(
        "create",
        { ...input, content: "changed", mode: "apply", previewId: id },
        context,
      ),
    ).rejects.toThrow("preview");
    await expect(
      writer.execute(
        "create",
        { ...input, mode: "apply", previewId: id },
        { ...context, sessionId: "other" },
      ),
    ).rejects.toThrow("preview");
    await writer.execute(
      "create",
      { ...input, mode: "apply", previewId: id },
      context,
    );
    expect(await readFile(join(root, input.path), "utf8")).toBe(input.content);
    await expect(
      writer.execute(
        "create",
        { ...input, mode: "apply", previewId: id },
        context,
      ),
    ).rejects.toThrow("preview");
    await expect(writer.execute("create", input, context)).rejects.toThrow(
      "exists",
    );
    expect(await readdir(join(root, "nested"))).toEqual(["hello.txt"]);
  }));

it("exact edit preserves BOM/CRLF, refuses ambiguity/no-op and detects concurrent changes", () =>
  fixture(async (root, writer, context) => {
    const path = join(root, "file.txt");
    const original = "\uFEFFone\r\none\r\n";
    await writeFile(path, original);
    const input = {
      path: "file.txt",
      searchContent: "one",
      replaceContent: "two",
    };
    await expect(writer.execute("edit", input, context)).rejects.toThrow(
      "Ambiguous",
    );
    await expect(
      writer.execute("edit", { ...input, searchContent: "missing" }, context),
    ).rejects.toThrow("not found");
    const args = { ...input, occurrence: 2 };
    let id = previewId(await writer.execute("edit", args, context));
    await writeFile(path, "external change");
    await expect(
      writer.execute(
        "edit",
        { ...args, mode: "apply", previewId: id },
        context,
      ),
    ).rejects.toThrow("changed");
    expect(await readFile(path, "utf8")).toBe("external change");
    await writeFile(path, original);
    id = previewId(await writer.execute("edit", args, context));
    await writer.execute(
      "edit",
      { ...args, mode: "apply", previewId: id },
      context,
    );
    expect(await readFile(path, "utf8")).toBe("\uFEFFone\r\ntwo\r\n");
    await expect(
      writer.execute("edit", { ...input, searchContent: "two" }, context),
    ).rejects.toThrow("No changes");
  }));

it("rejects traversal, alternate streams, linked parents, binary and oversized data; cancellation does not write", () =>
  fixture(async (root, writer, context) => {
    for (const path of [
      "../bad",
      "C:\\bad",
      "a:stream",
      ".git/config",
      "a/../b",
      "NUL.txt",
    ])
      await expect(
        writer.execute("create", { path, content: "x" }, context),
      ).rejects.toThrow();
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await expect(
      writer.execute(
        "create",
        { path: "binary", content: "x", overwrite: true },
        context,
      ),
    ).rejects.toThrow("Binary");
    await expect(
      writer.execute(
        "create",
        { path: "huge", content: "你".repeat(800000) },
        context,
      ),
    ).rejects.toThrow("2 MiB");
    await mkdir(join(root, "actual"));
    await symlink(join(root, "actual"), join(root, "linked"), "junction");
    await expect(
      writer.execute("create", { path: "linked/x", content: "x" }, context),
    ).rejects.toThrow("Symlink");
    const input = { path: "cancelled", content: "x" };
    const id = previewId(await writer.execute("create", input, context));
    await expect(
      writer.execute(
        "create",
        { ...input, previewId: id, mode: "apply" },
        { ...context, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    await expect(readFile(join(root, "cancelled"))).rejects.toThrow();
  }));

it("real kernel approval denial cannot apply a write", () =>
  fixture(async (root, _writer, context) => {
    const registry = new ToolRegistry();
    const runtime = new PluginRuntime(
      registry,
      () => true,
      async () => root,
    );
    runtime.add({
      manifest,
      load: async () => ({ activate }),
      readFrontend: async () => ({ body: new Uint8Array(await readFile(new URL("../dist/ui/write-result.js", import.meta.url))), mime: "text/javascript" }),
    });
    await runtime.reconcile(new Set([manifest.id]));
    const executor = new ToolExecutor(
      registry,
      async () => false,
      new Set(manifest.permissions),
    );
    const input = { path: "denied.txt", content: "hello" };
    expect(
      JSON.parse(
        await executor.execute(
          {
            id: "apply",
            name: "workspace_create",
            input,
          },
          context,
        ),
      ),
    ).toMatchObject({
      error: "PERMISSION_DENIED",
      reason: "user_rejected",
      retryable: false,
    });
    await expect(readFile(join(root, "denied.txt"))).rejects.toThrow();
    await runtime.close();
  }));
