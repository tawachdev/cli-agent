const MAX_DIFF_LINES = 200;

export function lineDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return `(large change: ${oldLines.length} lines -> ${newLines.length} lines)`;
  }
  const removed = oldLines.filter((line) => !newLines.includes(line));
  const added = newLines.filter((line) => !oldLines.includes(line));
  const parts: string[] = [];
  for (const line of removed) parts.push("- " + line);
  for (const line of added) parts.push("+ " + line);
  return parts.join("\n") || "(no line changes)";
}
