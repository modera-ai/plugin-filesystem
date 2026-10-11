export function readOptions<
  T extends { startLine?: number; endLine?: number; maxLines?: number },
>(input: T): T & { startLine: number; maxLines: number } {
  let start = input.startLine ?? 1,
    end = input.endLine;
  for (const [name, value] of [
    ["startLine", start],
    ["endLine", end],
    ["maxLines", input.maxLines],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`${name} must be a positive integer`);
  }
  if (input.maxLines !== undefined && input.maxLines > 200)
    throw new Error("maxLines must not exceed 200");
  if (end !== undefined && start > end) [start, end] = [end, start];
  const maxLines = Math.min(
    input.maxLines ?? (end === undefined ? 100 : 200),
    end === undefined ? 200 : end - start + 1,
  );
  return { ...input, startLine: start, maxLines };
}
