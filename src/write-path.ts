import { realpath, mkdir, rmdir, stat } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";

export function localPath(workspace: string, path: string) {
  if (typeof path !== "string") throw new Error("File path required");
  const normalized = path
    .trim()
    .replace(/\0/g, "")
    .replace(/^\uFEFF/, "");
  if (!normalized) throw new Error("File path must not be empty");
  return resolve(
    workspace,
    normalized === "~"
      ? homedir()
      : /^~[/\\]/.test(normalized)
        ? resolve(homedir(), normalized.slice(2))
        : normalized,
  );
}

/** Resolve existing links without imposing a project boundary. */
export async function writeTarget(
  workspace: string,
  path: string,
  createParents = false,
  created: string[] = [],
) {
  const root = resolve(workspace);
  async function resolveTarget(
    target: string,
    parent: boolean,
  ): Promise<string> {
    try {
      const actual = await realpath(target);
      const info = await stat(actual);
      if (parent ? !info.isDirectory() : !info.isFile())
        throw new Error("Expected regular file and directory parents");
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const directory = dirname(target);
      if (directory === target) throw error;
      const actualParent = await resolveTarget(directory, true);
      const actual = resolve(actualParent, basename(target));
      if (parent && createParents) {
        try {
          await mkdir(actual);
          created.push(actual);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        }
        if (!(await stat(actual)).isDirectory())
          throw new Error("Expected directory parent");
        return realpath(actual);
      }
      return actual;
    }
  }
  return { root, target: await resolveTarget(localPath(root, path), false) };
}

export async function cleanParents(created: string[]): Promise<void> {
  for (const path of created.reverse()) {
    try {
      await rmdir(path);
    } catch {
      /* Only remove empty created directories. */
    }
  }
}
