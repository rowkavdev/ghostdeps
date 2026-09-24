/**
 * Bound AnalyseOptions.pullRequestSourceChanges before adapters see it
 * (#101, #133 caps discipline). Validates the shape, keeps only safe
 * repository paths, and applies PR_SOURCE_CHANGE_LIMITS. Everything that is
 * dropped is counted in one info finding, so the result says the PR removal
 * check was partial.
 */
import { isSafeRepositoryPath } from "../diff/dependency-changes.js";
import { PR_SOURCE_CHANGE_LIMITS } from "../limits.js";
import type { ChangedLine, Finding, SourceLineChanges } from "../types/index.js";

export interface SourceChangeLimits {
  maxLinesPerFile: number;
  maxLineChars: number;
  maxTotalChars: number;
}

export interface BoundedSourceChanges {
  changes: SourceLineChanges[];
  /** Empty when nothing was dropped. */
  findings: Finding[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function boundSourceChanges(
  input: readonly SourceLineChanges[],
  limits: SourceChangeLimits = PR_SOURCE_CHANGE_LIMITS,
): BoundedSourceChanges {
  const changes: SourceLineChanges[] = [];
  let budget = limits.maxTotalChars;
  let droppedFiles = 0;
  let droppedLines = 0;
  let cappedFiles = 0;

  const takeLines = (raw: unknown): { lines: ChangedLine[]; dropped: number; capped: boolean } => {
    const lines: ChangedLine[] = [];
    let dropped = 0;
    let capped = false;
    if (!Array.isArray(raw)) return { lines, dropped: 0, capped: raw !== undefined };
    for (const item of raw as unknown[]) {
      if (
        !isRecord(item) ||
        typeof item.text !== "string" ||
        typeof item.line !== "number" ||
        !Number.isSafeInteger(item.line) ||
        item.line < 1 ||
        item.text.length > limits.maxLineChars
      ) {
        dropped++;
        continue;
      }
      if (lines.length >= limits.maxLinesPerFile || item.text.length > budget) {
        dropped++;
        capped = true;
        continue;
      }
      budget -= item.text.length;
      lines.push({ line: item.line, text: item.text });
    }
    return { lines, dropped, capped };
  };

  for (const entry of Array.isArray(input) ? input : []) {
    const raw = entry as unknown;
    if (!isRecord(raw) || typeof raw.path !== "string" || !isSafeRepositoryPath(raw.path)) {
      droppedFiles++;
      continue;
    }
    if (raw.path.length > budget) {
      droppedFiles++;
      continue;
    }
    budget -= raw.path.length;
    const removed = takeLines(raw.removedLines);
    const added = takeLines(raw.addedLines);
    droppedLines += removed.dropped + added.dropped;
    if (removed.capped || added.capped || removed.dropped + added.dropped > 0) cappedFiles++;
    changes.push({ path: raw.path, removedLines: removed.lines, addedLines: added.lines });
  }

  const findings: Finding[] = [];
  if (droppedFiles > 0 || droppedLines > 0) {
    findings.push({
      kind: "info",
      rule: "pr-source-changes-capped",
      summary: `pull request source changes were capped: ${droppedFiles} file(s) and ${droppedLines} line(s) not checked for removed usages`,
      recommendation:
        "Manual review recommended: a dependency whose last use this pull request removed may not be reported.",
      evidence: [
        {
          kind: "pr-source-changes-capped",
          statement: `${cappedFiles + droppedFiles} file(s) affected; limits: ${limits.maxLinesPerFile} lines per file, ${limits.maxLineChars} characters per line, ${limits.maxTotalChars} characters in total`,
        },
      ],
      confidence: "high",
      limitations: ["Removed-usage evidence is partial for this pull request."],
      affectedFiles: [],
    });
  }
  return { changes, findings };
}
