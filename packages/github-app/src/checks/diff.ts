/**
 * Unified-diff helpers. GitHub's PR files API returns a `patch` per file;
 * annotations only go on lines the PR added or changed.
 */

/** Line numbers (in the new file) that a unified diff patch adds. */
export function addedLinesFromPatch(patch: string | undefined): Set<number> {
  const added = new Set<number>();
  if (!patch) return added;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      added.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed line: new-file counter does not move
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      newLine++;
    }
  }
  return added;
}

/** path -> added line numbers, for every file in a PR. */
export type AddedLines = ReadonlyMap<string, ReadonlySet<number>>;

export function addedLinesFromFiles(
  files: readonly { filename: string; patch?: string }[],
): AddedLines {
  const map = new Map<string, Set<number>>();
  for (const f of files) {
    const lines = addedLinesFromPatch(f.patch);
    if (lines.size > 0) map.set(f.filename, lines);
  }
  return map;
}
