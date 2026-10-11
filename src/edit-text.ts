/** Exact matching with newline normalization; indentation is never discarded. */
export function replaceText(
  before: string,
  search: string,
  replacement: string,
  occurrence?: number,
  fuzzy = false,
  path = "",
): { after: string; matchedLine: number; matchType: string } {
  if (!search) throw new Error("Search text must not be empty");
  const normalized = before.replace(/\r\n/g, "\n");
  let needle = search.replace(/\r\n/g, "\n");
  const positions: number[] = [];
  let offset = 0;
  while ((offset = normalized.indexOf(needle, offset)) !== -1) {
    positions.push(offset);
    offset += needle.length;
  }
  if (!positions.length) {
    const lines = needle.split("\n");
    if (lines.every((line) => /^\s*\d+[:|] /.test(line))) {
      const raw = lines
        .map((line) => line.replace(/^\s*\d+[:|] /, ""))
        .join("\n");
      if (normalized.includes(raw))
        return {
          ...replaceText(before, raw, replacement, occurrence, false, path),
          matchType: "line-prefix",
        };
    }
  }
  if (!positions.length && fuzzy) {
    const repaired = normalizedMatch(normalized, needle, replacement, path);
    if (repaired.length) {
      if (repaired.length > 1 && occurrence === undefined)
        throw new Error("Ambiguous match; specify occurrence");
      const selected = occurrence ?? 1;
      if (
        !Number.isInteger(selected) ||
        selected < 1 ||
        selected > repaired.length
      )
        throw new Error("Invalid occurrence");
      const match = repaired[selected - 1]!;
      const equalBefore =
        normalized.slice(0, match.offset).split(match.text).length - 1;
      return {
        ...replaceText(
          before,
          match.text,
          match.replacement,
          equalBefore + 1,
          false,
          path,
        ),
        matchType: match.type,
      };
    }
  }
  if (!positions.length && fuzzy) {
    const wanted = needle.split("\n"),
      lines = normalized.split("\n");
    let best = 0.85,
      candidate: string | undefined,
      ambiguous = false,
      scanned = 0,
      work = 0;
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      const region = lines.slice(i, i + wanted.length);
      if (
        !region.every(
          (line, at) =>
            line.match(/^\s*/)?.[0] === wanted[at]!.match(/^\s*/)?.[0],
        )
      )
        continue;
      const text = region.join("\n");
      if (
        Math.abs(text.length - needle.length) > needle.length * 0.15 ||
        text.length > 4000 ||
        needle.length > 4000
      )
        continue;
      scanned++;
      work += text.length * needle.length;
      if (scanned > 5000 || work > 5_000_000)
        throw new Error(
          "Fuzzy matching budget exceeded; reread and use exact text",
        );
      const score = similarity(text, needle);
      if (score > best) {
        best = score;
        candidate = text;
        ambiguous = false;
      } else if (score === best && candidate) ambiguous = true;
    }
    if (ambiguous)
      throw new Error(
        "Ambiguous fuzzy match; reread the file and use exact text",
      );
    if (candidate) {
      needle = candidate;
      offset = 0;
      while ((offset = normalized.indexOf(needle, offset)) !== -1) {
        positions.push(offset);
        offset += needle.length;
      }
    }
  }
  if (!positions.length)
    throw new Error(
      "Exact text not found; read the file and preserve indentation",
    );
  if (positions.length > 1 && occurrence === undefined)
    throw new Error("Ambiguous match; specify occurrence");
  const selected = occurrence ?? 1;
  if (
    !Number.isInteger(selected) ||
    selected < 1 ||
    selected > positions.length
  )
    throw new Error("Invalid occurrence");
  const start = positions[selected - 1]!;
  // Map normalized offsets back to the original bytes without rewriting untouched mixed newlines.
  let original = 0,
    logical = 0,
    from = 0,
    to = 0;
  while (logical < start + needle.length) {
    if (logical === start) from = original;
    original +=
      before[original] === "\r" && before[original + 1] === "\n" ? 2 : 1;
    logical++;
  }
  to = original;
  const region = before.slice(from, to);
  const newline =
    region.includes("\r\n") ||
    (!region.includes("\n") && before.includes("\r\n"))
      ? "\r\n"
      : "\n";
  const after =
    before.slice(0, from) +
    replacement.replace(/\r\n|\n/g, newline) +
    before.slice(to);
  return {
    after,
    matchedLine: before.slice(0, from).split("\n").length,
    matchType: needle === search.replace(/\r\n/g, "\n") ? "exact" : "fuzzy",
  };
}

/** Recover copied whitespace without guessing structure in Python/YAML/Makefile. */
function normalizedMatch(
  content: string,
  search: string,
  replacement: string,
  path: string,
) {
  const wanted = search.split("\n"),
    lines = content.split("\n");
  const sensitive =
    /(?:\.(?:py|pyi|ya?ml)|(?:^|[/\\])(?:GNUmakefile|Makefile|[^/\\]+\.mk))$/i.test(
      path,
    );
  const result: {
    offset: number;
    text: string;
    replacement: string;
    type: string;
  }[] = [];
  let offset = 0,
    work = 0;
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    const region = lines.slice(i, i + wanted.length);
    work +=
      region.reduce((size, line) => size + line.length, 0) + search.length;
    if (work > 5_000_000)
      throw new Error("Matching budget exceeded; reread and use exact text");
    if (sensitive) {
      if (
        region.every((line, at) => line.trimStart() === wanted[at]!.trimStart())
      ) {
        const nonblank = wanted
          .map((line, at) => ({ line, at }))
          .filter(({ line }) => line.trim());
        const shifts = nonblank.map(
          ({ line, at }) =>
            region[at]!.match(/^ */)![0].length - line.match(/^ */)![0].length,
        );
        const shift = shifts[0] ?? 0;
        const replaceLines = replacement.replace(/\r\n/g, "\n").split("\n");
        if (
          !region
            .concat(wanted, replaceLines)
            .some((line) => /^\s*\t/.test(line)) &&
          shifts.every((value) => value === shift) &&
          replaceLines.every(
            (line) => !line.trim() || line.match(/^ */)![0].length + shift >= 0,
          )
        ) {
          result.push({
            offset,
            text: region.join("\n"),
            replacement: replaceLines
              .map((line) =>
                !line.trim()
                  ? line
                  : " ".repeat(line.match(/^ */)![0].length + shift) +
                    line.trimStart(),
              )
              .join("\n"),
            type: "indentation",
          });
        }
      }
    } else if (
      region.every(
        (line, at) =>
          line.trim().replace(/\s+/g, " ") ===
          wanted[at]!.trim().replace(/\s+/g, " "),
      )
    ) {
      result.push({
        offset,
        text: region.join("\n"),
        replacement,
        type: "whitespace",
      });
    }
    offset += lines[i]!.length + 1;
  }
  return result;
}

function similarity(left: string, right: string) {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < right.length; j++)
      row.push(
        Math.min(
          row[j]! + 1,
          previous[j + 1]! + 1,
          previous[j]! + (left[i] === right[j] ? 0 : 1),
        ),
      );
    previous = row;
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length, 1);
}
