import { lstat, realpath, mkdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Reject links and ambiguous Windows paths. This is not a hostile-filesystem sandbox. */
export async function writeTarget(
  workspace: string,
  path: string,
  createParents = false,
  created: string[] = [],
) {
  if (
    typeof path !== "string" ||
    isAbsolute(path) ||
    !path ||
    path.length > 2000
  )
    throw new Error("Invalid project-relative path");
  const parts = path.split(/[\\/]/);
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /[:\x00-\x1f<>"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Unsafe write path");
  const root = await realpath(workspace);
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = join(target, parts[i]!);
    let info;
    try {
      info = await lstat(target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (createParents && i < parts.length - 1) {
        try {
          await mkdir(target);
          created.push(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        info = await lstat(target);
      }
    }
    if (info?.isSymbolicLink())
      throw new Error("Symlink writes are not supported");
    if (info && (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
      throw new Error("Expected regular file and directory parents");
  }
  return { root, target };
}

export async function cleanParents(created: string[]): Promise<void> {
  for (const path of created.reverse()) {
    try {
      await rmdir(path);
    } catch {
      /* Only remove empty directories created by this transaction. */
    }
  }
}
