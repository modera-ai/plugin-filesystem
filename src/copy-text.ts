export interface CopyInput {
  path: string;
  sourceFilePath: string;
  sourceStartLine: number;
  sourceEndLine?: number;
  mode?: "insert" | "replace";
  targetLine?: number;
  targetEndLine?: number;
  position?: "before" | "after";
  deleteSource?: boolean;
}

function line(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || value! < 1)
    throw new Error(`${name} must be a positive integer`);
  return value!;
}
function document(text: string) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const raw = body ? body.split("\n") : [];
  const trailing = body.endsWith("\n");
  const lines = raw.map((line, index) => {
    const terminated = index < raw.length - 1;
    const crlf = terminated && line.endsWith("\r");
    return {
      text: crlf ? line.slice(0, -1) : line,
      ending: terminated ? (crlf ? "\r\n" : "\n") : "",
    };
  });
  if (trailing) lines.pop();
  return {
    bom,
    lines,
    trailing,
    newline: body.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** Line coordinates always refer to the snapshots before the operation. */
export function copyText(
  source: string,
  target: string | null,
  sameFile: boolean,
  input: CopyInput,
) {
  const from = document(source),
    to = document(target ?? source);
  if (target === null) to.lines = [];
  const first = line(input.sourceStartLine, "sourceStartLine");
  const last =
    input.sourceEndLine === undefined
      ? first
      : line(input.sourceEndLine, "sourceEndLine");
  const start = Math.min(first, last) - 1,
    end = Math.min(Math.max(first, last), from.lines.length);
  if (start >= from.lines.length)
    throw new Error("Source range is beyond the end of the file");
  const copied = from.lines
    .slice(start, end)
    .map((line) => ({ text: line.text, ending: to.newline }));
  const mode = input.mode ?? "insert",
    position = input.position ?? "before";
  if (mode !== "insert" && mode !== "replace")
    throw new Error("Invalid copy mode");
  if (position !== "before" && position !== "after")
    throw new Error("Invalid insert position");
  let at: number, until: number;
  if (mode === "insert") {
    if (input.targetEndLine !== undefined)
      throw new Error("targetEndLine requires mode=replace");
    const anchor =
      input.targetLine === undefined
        ? undefined
        : line(input.targetLine, "targetLine");
    if (anchor !== undefined && anchor > to.lines.length + 1)
      throw new Error("targetLine is beyond the end of the file");
    at =
      anchor === undefined
        ? to.lines.length
        : Math.min(anchor - (position === "before" ? 1 : 0), to.lines.length);
    until = at;
  } else {
    if (input.position !== undefined)
      throw new Error("position is only supported with mode=insert");
    const a = line(input.targetLine, "targetLine"),
      b = line(input.targetEndLine, "targetEndLine");
    at = Math.min(a, b) - 1;
    until = Math.min(Math.max(a, b), to.lines.length);
    if (at >= to.lines.length)
      throw new Error("Target range is beyond the end of the file");
  }
  const replaced = to.lines.slice(at, until);
  const cut = sameFile && input.deleteSource;
  if (
    cut &&
    (mode === "insert" ? at >= start && at <= end : at < end && start < until)
  )
    throw new Error(
      "Source and target ranges overlap or the move makes no changes",
    );
  let targetLines = [...to.lines];
  if (cut) {
    targetLines.splice(start, end - start);
    if (at >= end) at -= end - start;
    if (until >= end) until -= end - start;
  }
  targetLines = targetLines
    .slice(0, at)
    .concat(copied, targetLines.slice(until));
  const trailing =
    target === null ? from.trailing && end === from.lines.length : to.trailing;
  const build = (lines: typeof to.lines, style: typeof to, tail: boolean) => {
    return (
      style.bom +
      lines
        .map(
          (line, index) =>
            line.text +
            (index < lines.length - 1 || tail
              ? line.ending || style.newline
              : ""),
        )
        .join("")
    );
  };
  const after = build(targetLines, to, trailing);
  const sourceLines = [...from.lines];
  sourceLines.splice(start, end - start);
  const sourceAfter =
    input.deleteSource && !sameFile
      ? build(sourceLines, from, from.trailing)
      : source;
  if (after === (target ?? "") && sourceAfter === source)
    throw new Error("No changes requested");
  return {
    after,
    sourceAfter,
    matchedLineStart: at + 1,
    matchedLineEnd: at + copied.length,
    totalLines: targetLines.length,
    pastedContent: copied
      .map((line) => line.text)
      .join(to.newline)
      .slice(0, 6000),
    replacedContent: replaced
      .map((line) => line.text)
      .join(to.newline)
      .slice(0, 6000),
    omittedContent:
      copied.map((line) => line.text).join(to.newline).length > 6000 ||
      replaced.map((line) => line.text).join(to.newline).length > 6000,
  };
}
