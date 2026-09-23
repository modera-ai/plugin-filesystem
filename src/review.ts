/** Bounded excerpts around the first changed line, shared by approval and history. */
export function fileReview(before: string, after: string) {
  const left = before.split("\n"),
    right = after.split("\n");
  let first = 0;
  while (
    first < Math.min(left.length, right.length) &&
    left[first] === right[first]
  )
    first++;
  const start = Math.max(0, first - 2);
  const excerpt = (lines: string[]) =>
    lines.slice(start, start + 120).join("\n");
  const oldText = excerpt(left),
    newText = excerpt(right);
  return {
    before: oldText.slice(0, 6000),
    after: newText.slice(0, 6000),
    startLine: start + 1,
    reviewIsExcerpt:
      start > 0 ||
      left.length > start + 120 ||
      right.length > start + 120 ||
      oldText.length > 6000 ||
      newText.length > 6000,
  };
}
