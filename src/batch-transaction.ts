import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolContext } from "@modera/plugin-sdk";
import { encodeText } from "./codec";
import { hash, snapshot } from "./file-snapshot";
import { writeTarget } from "./write-path";

export interface FileChange {
  path: string;
  target: string;
  before: NonNullable<Awaited<ReturnType<typeof snapshot>>>;
  after: string;
}
async function unchanged(change: FileChange, root: string) {
  const checked = await writeTarget(root, change.path);
  if (checked.target !== change.target)
    throw new Error("Path changed since preview");
  const now = await snapshot(change.target, change.before.encoding);
  if (
    now?.hash !== change.before.hash ||
    now?.identity !== change.before.identity
  )
    throw new Error(`File changed since preview: ${change.path}`);
}
/** Per-file atomic rename + compensating rollback, not crash-atomic multi-file storage. */
export async function commitBatch(
  changes: FileChange[],
  root: string,
  context: ToolContext,
  publish = rename,
) {
  const staged: {
    change: FileChange;
    temporary: string;
    backup: string;
    applied: boolean;
    retainBackup: boolean;
  }[] = [];
  const stage = async (path: string, bytes: Buffer, mode: number) => {
    const file = await open(path, "wx", mode & 0o777);
    try {
      await file.writeFile(bytes);
      await file.chmod(mode & 0o777);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  try {
    for (const change of changes) {
      context.signal.throwIfAborted();
      await unchanged(change, root);
      const prefix = join(
        dirname(change.target),
        `.modera-${randomUUID()}`,
      );
      const item = {
        change,
        temporary: prefix + ".tmp",
        backup: prefix + ".bak",
        applied: false,
        retainBackup: false,
      };
      staged.push(item);
      await stage(
        item.temporary,
        encodeText(change.after, change.before.encoding),
        change.before.mode,
      );
      await stage(
        item.backup,
        encodeText(change.before.text, change.before.encoding),
        change.before.mode,
      );
    }
    // Validate the entire read-set again before the first publication.
    for (const change of changes) await unchanged(change, root);
    for (const item of staged) {
      context.signal.throwIfAborted();
      await unchanged(item.change, root);
      await publish(item.temporary, item.change.target);
      item.applied = true;
    }
  } catch (error) {
    const failures: string[] = [];
    for (const item of [...staged].reverse()) {
      if (!item.applied) continue;
      try {
        const { change } = item;
        await writeTarget(root, change.path);
        const now = await snapshot(change.target, change.before.encoding);
        if (
          now?.hash !== hash(encodeText(change.after, change.before.encoding))
        )
          throw new Error(
            "File edited externally; will not overwrite it during rollback",
          );
        await rename(item.backup, change.target);
      } catch {
        item.retainBackup = true;
        failures.push(`${item.change.path}: recovery copy ${item.backup}`);
      }
    }
    if (failures.length)
      throw new Error(
        `Batch failed; rollback incomplete. ${String(error)}. ${failures.join("; ")}`,
      );
    throw error;
  } finally {
    for (const item of staged) {
      await unlink(item.temporary).catch(() => {});
      if (!item.retainBackup) await unlink(item.backup).catch(() => {});
    }
  }
}
