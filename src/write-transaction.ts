import { randomUUID } from "node:crypto";
import { open, rename, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolContext } from "@modera/plugin-sdk";
import { snapshot, hash } from "./file-snapshot";
import { encodeText, type TextEncoding } from "./codec";
import { cleanParents, writeTarget } from "./write-path";

export interface FileChange {
  path: string;
  target: string;
  before: Awaited<ReturnType<typeof snapshot>>;
  after: string;
  encoding: TextEncoding;
}
export async function verifyChanges(root: string, changes: FileChange[]) {
  for (const change of changes) {
    if ((await writeTarget(root, change.path)).target !== change.target)
      throw new Error("Path changed since preview");
    const current = await snapshot(change.target, change.encoding);
    if (
      current?.hash !== change.before?.hash ||
      current?.identity !== change.before?.identity
    )
      throw new Error("File changed since preview; generate a new preview");
  }
}

/** Stage every output before publication. Cross-file operations roll back on failure. */
export async function applyChanges(
  root: string,
  changes: FileChange[],
  context: ToolContext,
  observed = changes,
) {
  const parents: string[] = [],
    staged: {
      change: FileChange;
      temporary: string;
      committed: boolean;
      identity?: string;
    }[] = [];
  try {
    await verifyChanges(root, observed);
    for (const change of changes) {
      context.signal.throwIfAborted();
      if (
        (await writeTarget(root, change.path, true, parents)).target !==
        change.target
      )
        throw new Error("Path changed");
      const temporary = join(
        dirname(change.target),
        `.modera-${randomUUID()}.tmp`,
      );
      const file = await open(
        temporary,
        "wx",
        change.before ? change.before.mode & 0o777 : 0o666,
      );
      staged.push({ change, temporary, committed: false });
      try {
        const info = await file.stat();
        staged[staged.length - 1]!.identity = `${info.dev}:${info.ino}`;
        await file.writeFile(encodeText(change.after, change.encoding));
        if (change.before) await file.chmod(change.before.mode & 0o777);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await verifyChanges(root, observed);
    for (const item of staged) {
      context.signal.throwIfAborted();
      await verifyChanges(root, [item.change]);
      if (item.change.before) await rename(item.temporary, item.change.target);
      else await link(item.temporary, item.change.target);
      item.committed = true;
    }
  } catch (error) {
    const failures: string[] = [];
    for (const item of [...staged].reverse()) {
      if (!item.committed) continue;
      let backup: string | undefined;
      try {
        const current = await snapshot(
          item.change.target,
          item.change.encoding,
          !item.change.before,
        );
        if (
          current?.identity.split(":").slice(0, 2).join(":") !==
            item.identity ||
          current?.hash !==
            hash(encodeText(item.change.after, item.change.encoding))
        )
          throw new Error("File changed externally; rollback refused");
        if (item.change.before) {
          backup = join(
            dirname(item.change.target),
            `.modera-${randomUUID()}.tmp`,
          );
          const file = await open(
            backup,
            "wx",
            item.change.before.mode & 0o777,
          );
          try {
            await file.writeFile(
              encodeText(item.change.before.text, item.change.encoding),
            );
            await file.chmod(item.change.before.mode & 0o777);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(backup, item.change.target);
        } else await unlink(item.change.target);
      } catch {
        failures.push(item.change.path);
      } finally {
        if (backup) await unlink(backup).catch(() => {});
      }
    }
    if (failures.length)
      throw new Error(
        `Write failed; rollback incomplete for ${failures.join(", ")}`,
        { cause: error },
      );
    throw error;
  } finally {
    for (const item of staged) await unlink(item.temporary).catch(() => {});
    await cleanParents(parents);
  }
}
