import { open } from "node:fs/promises";
import iconv from "iconv-lite";
import type { ToolContext } from "@modera/plugin-sdk";
import { decodeText, detectEncoding, type TextEncoding } from "./codec";

interface ReadInput {
  path: string;
  startLine?: number;
  maxLines?: number;
  encoding?: TextEncoding;
  cursor?: number;
  version?: string;
}
/** Large files use byte-cursor pages; a line is never silently consumed past the response budget. */
export async function readText(
  target: string,
  input: ReadInput,
  context: ToolContext,
) {
  const file = await open(target, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Expected a regular file");
    const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (input.version && input.version !== version)
      throw new Error("File changed between pages; restart reading");
    const cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > info.size)
      throw new Error("Invalid byte cursor");
    if (info.size <= 2 * 1024 * 1024 && input.cursor === undefined) {
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      let count = 0;
      while (count < buffer.length) {
        context.signal.throwIfAborted();
        const read = await file.read(
          buffer,
          count,
          buffer.length - count,
          count,
        );
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      const bytes = buffer.subarray(0, count);
      context.signal.throwIfAborted();
      if (bytes.length > 2 * 1024 * 1024)
        throw new Error("File grew; retry using byte cursor");
      const { text, encoding } = decodeText(bytes, input.encoding);
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
      const start = input.startLine ?? 1,
        max = input.maxLines ?? 100;
      const selected: string[] = [];
      let length = 0;
      for (
        let i = start - 1;
        i < Math.min(lines.length, start - 1 + max);
        i++
      ) {
        const line = `${i + 1}: ${lines[i]!}`;
        if (length + JSON.stringify(line).length > 12000) {
          if (!selected.length)
            throw new Error(
              "Line exceeds output budget; use cursor=0 byte paging instead",
            );
          break;
        }
        selected.push(line);
        length += JSON.stringify(line).length + 1;
      }
      const nextLine = start + selected.length,
        hasMore = nextLine <= lines.length;
      const latest = await file.stat();
      if (
        `${latest.dev}:${latest.ino}:${latest.size}:${latest.mtimeMs}:${latest.ctimeMs}` !==
        version
      )
        throw new Error("File changed while reading");
      return {
        type: "file",
        path: input.path,
        encoding,
        version,
        totalLines: lines.length,
        content: selected.join("\n"),
        hasMore,
        ...(hasMore ? { nextLine } : {}),
      };
    }
    if (input.startLine !== undefined && input.startLine !== 1)
      throw new Error("Large files require byte cursor paging, not startLine");
    const header = Buffer.alloc(3);
    await file.read(header, 0, 3, 0);
    const encoding = detectEncoding(header, input.encoding);
    const buffer = Buffer.alloc(Math.min(3000, info.size - cursor));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
    context.signal.throwIfAborted();
    let page: { text: string; encoding: TextEncoding } | undefined,
      consumed = bytesRead;
    // UTF-8/GB18030 code points can cross a byte-page boundary; never split them.
    for (
      let trim = 0;
      trim < (cursor + bytesRead < info.size ? 4 : 1) && trim <= bytesRead;
      trim++
    ) {
      try {
        page = decodeText(buffer.subarray(0, bytesRead - trim), encoding);
        consumed = bytesRead - trim;
        break;
      } catch {
        /* Try only a trailing partial sequence. */
      }
    }
    if (!page || (bytesRead && !consumed))
      throw new Error("Invalid encoding or cursor boundary");
    // Avoid accepting a trailing incomplete character as a replacement character.
    if (
      page.text.includes("�") &&
      !iconv.encode(page.text, encoding).equals(buffer.subarray(0, consumed))
    )
      throw new Error("Invalid encoded page");
    const latest = await file.stat();
    if (
      `${latest.dev}:${latest.ino}:${latest.size}:${latest.mtimeMs}:${latest.ctimeMs}` !==
      version
    )
      throw new Error("File changed while reading");
    return {
      type: "file",
      path: input.path,
      mode: "bytes",
      encoding,
      version,
      content: page.text.replace(cursor === 0 ? /^\uFEFF/ : /$^/, ""),
      nextCursor: cursor + consumed,
      hasMore: cursor + consumed < info.size,
    };
  } finally {
    await file.close();
  }
}
