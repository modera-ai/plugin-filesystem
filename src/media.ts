import { open } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { extname, join } from "node:path";
import type { ToolContext } from "@modera/plugin-sdk";
import { readOptions } from "./read-options";

export const mediaExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "xlsb",
  "xlsm",
  "ods",
]);
export const extensionOf = (path: string) =>
  extname(path).slice(1).toLowerCase();
export async function readMedia(
  target: string,
  input: {
    path: string;
    startLine?: number;
    endLine?: number;
    maxLines?: number;
    version?: string;
  },
  context: ToolContext,
  resourcePath: string,
) {
  input = readOptions(input);
  const file = await open(target, "r");
  let bytes: Buffer, version: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error("Media must be a regular file at most 32 MiB");
    version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (input.version && input.version !== version)
      throw new Error("File changed between pages; restart reading");
    bytes = Buffer.alloc(info.size);
    let count = 0;
    while (count < bytes.length) {
      context.signal.throwIfAborted();
      const part = await file.read(bytes, count, bytes.length - count, count);
      if (!part.bytesRead) break;
      count += part.bytesRead;
    }
    const latest = await file.stat();
    if (
      count !== info.size ||
      `${latest.dev}:${latest.ino}:${latest.size}:${latest.mtimeMs}:${latest.ctimeMs}` !==
        version
    )
      throw new Error("File changed while reading");
  } finally {
    await file.close();
  }
  context.signal.throwIfAborted();
  const worker = new Worker(join(resourcePath, "dist/media.worker.cjs"), {
    workerData: { resourcePath },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  const result = await new Promise<Record<string, any>>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Record<string, any>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      void worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(new Error("Media extraction aborted"));
    const timer = setTimeout(
      () => finish(new Error("Media extraction exceeded 30 seconds")),
      30_000,
    );
    context.signal.addEventListener("abort", abort, { once: true });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`Media extractor exited (${code})`));
    });
    worker.once("message", (message) =>
      finish(
        message.error ? new Error(message.error) : undefined,
        message.value,
      ),
    );
    if (context.signal.aborted) abort();
    else worker.postMessage({ bytes, extension: extensionOf(target) });
  });
  if (result.type === "image") return { ...result, path: input.path, version };
  // A single Office paragraph can be larger than the response budget; keep it readable in pages.
  const lines = (result.text as string).split(/\r?\n/).flatMap((line) => {
    if (line.length <= 2000) return [line];
    const chunks: string[] = [];
    let chunk = "";
    for (const character of line) {
      if (chunk.length + character.length > 2000) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += character;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
  const start = input.startLine ?? 1,
    max = input.maxLines ?? 100;
  const selected: string[] = [];
  let length = 0;
  for (let i = start - 1; i < Math.min(lines.length, start - 1 + max); i++) {
    const line = `${i + 1}: ${lines[i]}`;
    if (length + line.length > 12000) {
      if (!selected.length)
        throw new Error("Extracted line exceeds output budget");
      break;
    }
    selected.push(line);
    length += line.length + 1;
  }
  const { text: _text, ...metadata } = result;
  const nextLine = start + selected.length,
    hasMore = nextLine <= lines.length;
  return {
    ...metadata,
    type: "document",
    path: input.path,
    version,
    totalLines: lines.length,
    content: selected.join("\n"),
    hasMore,
    ...(hasMore ? { nextLine } : {}),
  };
}
