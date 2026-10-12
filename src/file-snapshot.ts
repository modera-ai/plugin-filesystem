import { fileIdentity } from "./file-identity";
import { createHash } from "node:crypto";
import { open } from "@modera/plugin-sdk/workspace-fs";
import { isRemotePath } from "@modera/plugin-sdk/workspace-path";
import { decodeText, type TextEncoding } from "./codec";
import { remoteTransport } from "@modera/plugin-sdk/workspace-transport";

export interface RemoteVersion {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  mode?: number;
  sha256?: string;
}

export const FILE_LIMIT = 2 * 1024 * 1024;
export const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function snapshot(
  path: string,
  encoding?: TextEncoding,
  allowStagingLink = false,
) {
  if (isRemotePath(path)) {
    const result = (await remoteTransport().file("readVersion", [
      path,
      { maxBytes: FILE_LIMIT },
    ])) as {
      content: Buffer | null;
      version: RemoteVersion;
    };
    if (!result.version.exists || !result.content) return null;
    if (result.content.length > FILE_LIMIT)
      throw new Error("File exceeds 2 MiB");
    return {
      ...decodeText(result.content, encoding),
      hash: hash(result.content),
      mode: result.version.mode!,
      size: result.content.length,
      identity: JSON.stringify(result.version),
      remoteVersion: result.version,
    };
  }
  let file;
  try {
    file = await open(path, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  try {
    const handleInfo = await file.stat();
    const info = isRemotePath(path) ? await fileIdentity(path) : handleInfo;
    if (
      !handleInfo.isFile() ||
      handleInfo.size !== info.size ||
      Math.floor(handleInfo.mtimeMs / 1000) !== Math.floor(info.mtimeMs / 1000)
    )
      throw new Error("File path changed while opening snapshot");
    if (![info.dev, info.ino, info.nlink, info.ctimeMs].every(Number.isFinite))
      throw Object.assign(
        new Error(
          "服务器文件协议未提供可靠的 inode、硬链接数和变更时间；无法安全预览或提交事务编辑",
        ),
        { code: "ENOTSUP" },
      );
    if (
      !info.isFile() ||
      info.size > FILE_LIMIT ||
      (info.nlink > 1 && !allowStagingLink)
    )
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
    const handleLatest = await file.stat();
    const latest = isRemotePath(path) ? await fileIdentity(path) : handleLatest;
    if (
      handleLatest.size !== size ||
      handleLatest.mtimeMs !== handleInfo.mtimeMs ||
      latest.dev !== info.dev ||
      latest.ino !== info.ino ||
      latest.size !== size ||
      latest.mtimeMs !== info.mtimeMs ||
      latest.ctimeMs !== info.ctimeMs ||
      latest.nlink !== info.nlink
    )
      throw new Error("File changed while reading snapshot");
    const decoded = decodeText(data, encoding);
    return {
      ...decoded,
      hash: hash(data),
      mode: info.mode,
      size,
      identity: `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`,
      remoteVersion: undefined as RemoteVersion | undefined,
    };
  } finally {
    await file.close();
  }
}
