import { remoteTransport } from "@modera/plugin-sdk/workspace-transport";
import { unlink } from "@modera/plugin-sdk/workspace-fs";
import type { ToolContext } from "@modera/plugin-sdk";
import { encodeText } from "./codec";
import { cleanParents, writeTarget } from "./write-path";
import { hash, snapshot, type RemoteVersion } from "./file-snapshot";
import type { FileChange } from "./write-transaction";

// Snow's SFTP content versions replace POSIX inode requirements on remote
// hosts. Multi-file rollback is best effort and refuses external changes.
export async function applyRemoteChanges(
  root: string,
  changes: FileChange[],
  context: ToolContext,
  verify: () => Promise<void>,
) {
  const parents: string[] = [];
  const committed: { change: FileChange; version: RemoteVersion }[] = [];
  let uncertain: string | undefined;
  try {
    await verify();
    for (const change of changes) {
      context.signal.throwIfAborted();
      if (
        (await writeTarget(root, change.path, true, parents)).target !==
        change.target
      )
        throw new Error("Path changed since preview");
    }
    await verify();
    for (const change of changes) {
      context.signal.throwIfAborted();
      const content = encodeText(change.after, change.encoding);
      try {
        const result = (await remoteTransport().file("writeVersion", [
          change.target,
          {
            content,
            expectedVersion: change.before?.remoteVersion ?? { exists: false },
            signal: context.signal,
            mode: change.before?.mode,
          },
        ])) as { version: RemoteVersion };
        committed.push({ change, version: result.version });
      } catch (error) {
        if ((error as { sideEffect?: string }).sideEffect === "possible")
          uncertain = change.path;
        throw error;
      }
    }
  } catch (error) {
    const failures: string[] = uncertain ? [uncertain] : [];
    for (const { change, version } of committed.reverse()) {
      try {
        const current = await snapshot(change.target, change.encoding);
        if (
          !current ||
          current.hash !== hash(encodeText(change.after, change.encoding)) ||
          JSON.stringify(current.remoteVersion) !== JSON.stringify(version)
        )
          throw new Error("File changed externally; rollback refused");
        if (change.before)
          await remoteTransport().file("writeVersion", [
            change.target,
            {
              content: encodeText(change.before.text, change.encoding),
              expectedVersion: version,
            },
          ]);
        else await unlink(change.target);
      } catch {
        failures.push(change.path);
      }
    }
    if (failures.length)
      throw new Error(
        `Remote write result or rollback is unconfirmed for ${failures.join(", ")}; reload before retrying`,
        { cause: error },
      );
    throw error;
  } finally {
    await cleanParents(parents);
  }
}
