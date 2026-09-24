/**
 * Turns an AnalysisResult into Check Run output (#32). Pure: no network.
 *
 * Rules (research #34, docs/github-app.md):
 * - success + quiet summary when there are no findings; neutral otherwise; never failure.
 * - Annotate only high-confidence findings whose evidence points at a line the PR added.
 * - At most 50 annotations (one API request); everything else goes in the summary.
 * - Repository-derived text is data: annotation text is plain, summary text is Markdown-escaped.
 */
import type { AnalysisResult, Evidence, Finding } from "@ghostdeps/core";
import type { AddedLines } from "./diff.js";

export const checkName = "ghostdeps";
export const quietSummary = "No significant dependency issues found.";
export const maxAnnotations = 50;
export const busySummary =
  "GhostDeps was too busy to analyse this commit, so no dependency analysis ran. Push a new commit to re-run.";

// GitHub limits: output.summary/text 65535 chars, annotation title 255, message 64 KB.
const summaryLimit = 65_000;
const titleLimit = 255;
const messageLimit = 4_000;

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning";
  title: string;
  message: string;
}

export interface CheckOutput {
  conclusion: "success" | "neutral";
  output: { title: string; summary: string; annotations: CheckAnnotation[] };
}

// Strip control characters (keeps \n and \t) so repository text cannot smuggle terminal or bidi tricks.
// eslint-disable-next-line no-control-regex
const controlChars = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

export function plain(text: string, limit: number): string {
  const clean = text.replace(controlChars, "");
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Escape Markdown/HTML so repository text renders literally inside the
 * summary. `@` becomes an entity so names like `@some-team` never mention anyone.
 */
export function md(text: string): string {
  return plain(text, 1_000)
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*_{}[\]()#+\-.!|>~<&]/g, (c) => `\\${c}`)
    .replace(/@/g, "&#64;");
}

/**
 * Cut the summary on a line boundary under GitHub's limit, closing an open
 * `<details>` so the rest of the check page still renders.
 */
export function truncateSummary(summary: string, limit = summaryLimit): string {
  if (summary.length <= limit) return summary;
  const note = "\n\n_Summary truncated._";
  const closing = "\n</details>";
  let cut = summary.slice(0, limit - note.length - closing.length);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  const open = cut.lastIndexOf("<details>") > cut.lastIndexOf("</details>");
  return `${cut}${open ? closing : ""}${note}`;
}

function locatedOnAddedLine(
  e: Evidence,
  added: AddedLines,
): e is Evidence & { file: string; line: number } {
  return e.file !== undefined && e.line !== undefined && (added.get(e.file)?.has(e.line) ?? false);
}

function annotationFor(f: Finding, e: Evidence & { file: string; line: number }): CheckAnnotation {
  const lines = [f.summary, "", `Recommendation: ${f.recommendation}`, "", "Evidence:"];
  for (const ev of f.evidence) lines.push(`- ${ev.statement}`);
  if (f.limitations.length > 0) {
    lines.push("", "Limitations:");
    for (const l of f.limitations) lines.push(`- ${l}`);
  }
  return {
    path: e.file,
    start_line: e.line,
    end_line: e.line,
    annotation_level: "notice",
    title: plain(f.dependency ? `${f.dependency}: ${f.kind}` : f.kind, titleLimit),
    message: plain(lines.join("\n"), messageLimit),
  };
}

function summaryLine(f: Finding): string {
  const dep = f.dependency ? `**${md(f.dependency)}** - ` : "";
  return `- ${dep}${md(f.summary)} _(${f.confidence} confidence)_`;
}

/**
 * Builds the check conclusion and output.
 * @param added lines the PR added, by path. Pass an empty map for pushes: no annotations then.
 */
export function renderCheck(result: AnalysisResult, added: AddedLines): CheckOutput {
  const findings = result.findings;
  if (findings.length === 0) {
    return {
      conclusion: "success",
      output: { title: quietSummary, summary: quietSummary, annotations: [] },
    };
  }

  const annotations: CheckAnnotation[] = [];
  const annotated = new Set<Finding>();
  const summaryOnly: Finding[] = [];
  let overflow = 0;

  for (const f of findings) {
    const at =
      f.confidence === "high" ? f.evidence.find((e) => locatedOnAddedLine(e, added)) : undefined;
    if (at && annotations.length < maxAnnotations) {
      annotations.push(annotationFor(f, at));
      annotated.add(f);
    } else {
      if (at) overflow++;
      summaryOnly.push(f);
    }
  }

  const high = summaryOnly.filter((f) => f.confidence === "high");
  const lower = summaryOnly.filter((f) => f.confidence !== "high");
  const n = findings.length;
  const parts: string[] = [
    `GhostDeps found ${n} finding${n === 1 ? "" : "s"} worth review. This check is advisory and never blocks merging.`,
  ];
  if (annotated.size > 0) parts.push("", `${annotated.size} annotated on lines this change added.`);
  if (overflow > 0)
    parts.push(
      "",
      `${overflow} more high-confidence findings exceeded the ${maxAnnotations}-annotation cap and are listed below.`,
    );
  if (high.length > 0) parts.push("", "### High confidence", "", ...high.map(summaryLine));
  if (lower.length > 0) {
    parts.push(
      "",
      `<details><summary>${lower.length} lower-confidence finding${lower.length === 1 ? "" : "s"} (manual review)</summary>`,
      "",
      ...lower.map(summaryLine),
      "",
      "</details>",
    );
  }

  const summary = truncateSummary(parts.join("\n"));

  return {
    conclusion: "neutral",
    output: {
      title: `${n} dependency finding${n === 1 ? "" : "s"} to review`,
      summary,
      annotations,
    },
  };
}

/** Output for a job dropped because the queue was full. Neutral: nothing was checked, nothing is blocked. */
export function busyCheck(): CheckOutput {
  return {
    conclusion: "neutral",
    output: { title: "GhostDeps was busy", summary: busySummary, annotations: [] },
  };
}

/**
 * Output for an analysis that could not finish (download, extraction or
 * engine failure). Neutral, never failure: GhostDeps advises, it does not gate.
 * `reason` is our own message, never repository content.
 */
export function failedCheck(reason: string): CheckOutput {
  const summary = truncateSummary(
    `GhostDeps could not analyse this commit: ${md(reason)}\n\nNothing was checked, so nothing is blocked. Use Re-run on this check to try again.`,
  );
  return {
    conclusion: "neutral",
    output: { title: "GhostDeps could not run", summary, annotations: [] },
  };
}
