import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { decodeText, type TextEncoding } from "./codec";

export const FILE_LIMIT = 2 * 1024 * 1024;
export const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function snapshot(path: string, encoding?: TextEncoding) {
  let file;
  try {
    file = await open(path, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > FILE_LIMIT || info.nlink > 1)
      throw new Error("Expected a single-link file at most 2 MiB");
    const bytes = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > FILE_LIMIT) throw new Error("File exceeds 2 MiB");
    const data = bytes.subarray(0, size);
    const decoded = decodeText(data, encoding);
    return {
      ...decoded,
      hash: hash(data),
      mode: info.mode,
      size,
      identity: `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`,
    };
  } finally {
    await file.close();
  }
}
