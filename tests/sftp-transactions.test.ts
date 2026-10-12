import * as fs from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import {
  isRemotePath,
  remotePath,
  workspaceUri,
} from "@modera/plugin-sdk/workspace-path";
import { WorkspaceWriter } from "../src/write";

async function fixture(
  run: (root: string, writer: WorkspaceWriter, context: any) => Promise<void>,
) {
  const root = await fs.mkdtemp(join(tmpdir(), "modera-sftp-transactions-"));
  const local = (uri: string) =>
    join(root, remotePath(uri).path.replace(/^\/workspace\/?/, ""));
  const versioned = async (path: string) => {
    try {
      const [info, content] = await Promise.all([
        fs.stat(path),
        fs.readFile(path),
      ]);
      return {
        content,
        version: {
          exists: true,
          size: info.size,
          mtimeMs: info.mtimeMs,
          mode: info.mode,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { content: null, version: { exists: false } };
      throw error;
    }
  };
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation, args) {
      const mapped = args.map((arg) =>
        isRemotePath(arg) ? local(arg as string) : arg,
      );
      if (operation === "readVersion") return versioned(mapped[0] as string);
      if (operation === "writeVersion") {
        const input = mapped[1] as any;
        expect(input.expectedVersion).toEqual(
          (await versioned(mapped[0] as string)).version,
        );
        await fs.writeFile(mapped[0] as string, input.content);
        return { version: (await versioned(mapped[0] as string)).version };
      }
      const result = await (fs as any)[
        operation === "statIdentity" ? "stat" : operation
      ](...mapped);
      if (operation === "realpath")
        return workspaceUri(
          "test",
          "/workspace/" + relative(root, result).replaceAll("\\", "/"),
        );
      if (operation !== "open") return result;
      // Simulate SFTP handles lacking inode, nlink and ctime, while path stat is real.
      const stat = result.stat.bind(result);
      result.stat = async () => {
        const info = await stat();
        return {
          size: info.size,
          mode: info.mode,
          mtimeMs: Math.floor(info.mtimeMs / 1000) * 1000,
          isFile: () => info.isFile(),
        };
      };
      return result;
    },
    spawn() {
      throw new Error("unused");
    },
    async pty() {
      throw new Error("unused");
    },
  });
  try {
    await run(root, new WorkspaceWriter(), {
      workspacePath: workspaceUri("test", "/workspace"),
      sessionId: "s",
      projectId: "p",
      runId: "r",
      signal: new AbortController().signal,
    });
  } finally {
    uninstall();
    await fs.rm(root, { recursive: true, force: true });
  }
}
it("creates and edits approved remote files through the versioned SFTP protocol", () =>
  fixture(async (root, writer, context) => {
    const create = await writer.prepare(
      "create",
      { path: "nested/a.txt", content: "before\n" },
      context,
    );
    await expect(fs.stat(join(root, "nested/a.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writer.execute("create", create.input, context);
    const edit = await writer.prepare(
      "edit",
      {
        path: "nested/a.txt",
        searchContent: "before",
        replaceContent: "after",
      },
      context,
    );
    await writer.execute("edit", edit.input, context);
    expect(await fs.readFile(join(root, "nested/a.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(await fs.readdir(join(root, "nested"))).toEqual(["a.txt"]);
  }));
it("refuses a remote edit when the file changes after approval preview", () =>
  fixture(async (root, writer, context) => {
    await fs.writeFile(join(root, "a.txt"), "before\n");
    const edit = await writer.prepare(
      "edit",
      { path: "a.txt", searchContent: "before", replaceContent: "after" },
      context,
    );
    await fs.writeFile(join(root, "a.txt"), "external\n");
    await expect(writer.execute("edit", edit.input, context)).rejects.toThrow(
      "changed",
    );
    expect(await fs.readFile(join(root, "a.txt"), "utf8")).toBe("external\n");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  }));
