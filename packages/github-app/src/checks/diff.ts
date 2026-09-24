/**
 * Added lines per file, for annotation gating. GitHub's PR files API returns
 * a bare hunk `patch` per file; each one goes through core's hardened
 * unified-diff parser so there is a single parser to harden (#76).
 */
import { addedLines, parseUnifiedDiff } from "@ghostdeps/core";

/** path -> added line numbers, for every file in a PR. */
export type AddedLines = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * Line numbers (in the new file) that one file's patch adds. A fixed,
 * well-formed header is prepended so attacker-controlled file names never
 * reach the header parser; the caller keys results by the API's filename.
 */
export function addedLinesFromPatch(patch: string | undefined): Set<number> {
  if (!patch) return new Set();
  const parsed = parseUnifiedDiff(`diff --git a/f b/f\n--- a/f\n+++ b/f\n${patch}`, {
    maxFiles: 1,
  });
  const file = parsed.files[0];
  return new Set(
    file
      ? addedLines(file)
          .map((l) => l.line)
          .filter((n) => n > 0)
      : [],
  );
}

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
