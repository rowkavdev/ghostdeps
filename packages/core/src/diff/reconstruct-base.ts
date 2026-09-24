import type { SourceLineChanges } from "../types/index.js";

/**
 * The file as it was at the PR's base, rebuilt from the head file and the
 * diff (#259, shared by the adapters' removedInPr scans): removed lines go
 * back at their base line numbers, added lines come out, everything else
 * is shared. Undefined when the lines do not fit together (a capped or
 * malformed diff, or an unreadable head file), so the caller records no
 * evidence rather than guessing the surrounding code. Pure: the diff text
 * is data, never evaluated.
 */
export function reconstructBase(
  head: readonly string[],
  change: SourceLineChanges,
): string[] | undefined {
  const removed = new Map<number, string>();
  for (const l of change.removedLines) removed.set(l.line, l.text);
  const added = new Set(change.addedLines.map((l) => l.line));
  for (const n of added) if (n > head.length) return undefined;
  const lastRemoved = Math.max(0, ...removed.keys());
  const base: string[] = [];
  let h = 0; // index into head (0-based)
  for (let n = 1; ; n++) {
    if (removed.has(n)) {
      base.push(removed.get(n)!);
      continue;
    }
    while (h < head.length && added.has(h + 1)) h++;
    if (h >= head.length) {
      // Head is used up: every removed line must already be placed.
      return n > lastRemoved ? base : undefined;
    }
    base.push(head[h]!);
    h++;
  }
}
