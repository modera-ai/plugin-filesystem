import { it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import { snapshot } from "../src/file-snapshot";
let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());
function provider(result: unknown) {
  const file = vi.fn(async () => result);
  uninstall = installRemoteWorkspaceTransport({
    file,
    spawn() {
      throw new Error("unused");
    },
    async pty() {
      throw new Error("unused");
    },
  });
  return file;
}
it("uses SFTP content versions without requiring POSIX inode or exec capabilities", async () => {
  const version = {
    exists: true,
    size: 3,
    mode: 0o100644,
    mtimeMs: 1000,
    sha256: createHash("sha256").update("abc").digest("hex"),
  };
  const file = provider({ content: Buffer.from("abc"), version });
  const result = await snapshot("ssh://test/a");
  expect(result?.text).toBe("abc");
  expect(result?.remoteVersion).toEqual(version);
  expect(file).toHaveBeenCalledWith("readVersion", [
    "ssh://test/a",
    { maxBytes: 2 * 1024 * 1024 },
  ]);
  expect(file).toHaveBeenCalledOnce();
});
it("distinguishes a missing file from an empty remote file", async () => {
  provider({
    content: Buffer.alloc(0),
    version: { exists: true, size: 0, mode: 0o100600 },
  });
  expect((await snapshot("ssh://test/a"))?.text).toBe("");
  uninstall?.();
  provider({ content: null, version: { exists: false } });
  expect(await snapshot("ssh://test/a")).toBeNull();
});
it("propagates a versioned read conflict instead of preparing a write", async () => {
  const file = provider(undefined);
  file.mockRejectedValue(
    Object.assign(new Error("changed during read"), {
      code: "SSH_FILE_CHANGED_DURING_READ",
    }),
  );
  await expect(snapshot("ssh://test/a")).rejects.toMatchObject({
    code: "SSH_FILE_CHANGED_DURING_READ",
  });
});
