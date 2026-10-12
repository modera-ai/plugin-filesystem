import { afterEach, expect, it, vi } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import { readWorkspace } from "../src/read";

afterEach(() => vi.useRealTimers());

it("lists and pages SSH directories in two transport calls without per-entry metadata calls", async () => {
  vi.useFakeTimers();
  const operations: string[] = [];
  let extra = false;
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation) {
      operations.push(operation);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (operation === "stat") return { isDirectory: () => true };
      if (operation === "opendir")
        return {
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < (extra ? 221 : 220); index++)
              yield {
                name: `file-${String(index).padStart(3, "0")}`,
                isDirectory: () => false,
                isSymbolicLink: () => false,
              };
          },
        };
      throw new Error(`Unexpected remote request ${operation}`);
    },
    spawn() {
      throw new Error("unused");
    },
    async pty() {
      throw new Error("unused");
    },
  });
  const context = {
    workspacePath: "ssh://test/project",
    sessionId: "s",
    runId: "r",
    signal: new AbortController().signal,
  };
  try {
    const start = Date.now();
    const reading = readWorkspace({ path: "." }, context);
    await vi.runAllTimersAsync();
    const first = (await reading) as any;
    expect(Date.now() - start).toBe(200);
    expect(operations).toEqual(["stat", "opendir"]);
    expect(first.entries).toHaveLength(200);
    expect(first.nextOffset).toBe(200);
    const paging = readWorkspace(
      { path: ".", offset: 200, version: first.version },
      context,
    );
    await vi.runAllTimersAsync();
    expect(await paging).toMatchObject({
      hasMore: false,
      entries: expect.any(Array),
    });
    extra = true;
    const changed = expect(
      readWorkspace(
        { path: ".", offset: 200, version: first.version },
        context,
      ),
    ).rejects.toThrow("changed between pages");
    await vi.runAllTimersAsync();
    await changed;
  } finally {
    uninstall();
  }
});
