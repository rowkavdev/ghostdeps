/**
 * Turns an AnalysisResult into Check Run output (#32). Pure: no network.
 *
 * Rules (research #34, docs/github-app.md):
 * - success + quiet summary when there are no findings; neutral otherwise; never failure.
 * - Run-level notes (info findings about the whole run, e.g. the unused
 *   confidence cap or an incomplete scan) never count as findings: they go
 *   in a Notes section, not the title, count or confidence groups (#195).
 *   A run with notes but no findings is neutral ("Analysis incomplete"),
 *   never the quiet success: a note can mean an adapter failed.
 * - Awareness notes (info findings about a dependency that suggest no
 *   action, e.g. a cross-ecosystem overlap) never affect the conclusion,
 *   title or count: they go in a collapsed Awareness notes section (#209).
 * - Package facts (core-validated, source-backed observations about the
 *   exact locked version, #61/#351) are listed in a Package facts section
 *   (#385): action-relevant but non-capping, they never affect the
 *   conclusion, title, count, annotations or hidden tallies.
 * - Annotate only high-confidence findings whose evidence points at a line the PR added.
 * - At most 50 annotations (one API request); everything else goes in the summary.
 * - Repository-derived text is data: annotation text is plain, summary text is Markdown-escaped.
 */
import {
  findingGroup,
  type AnalysisResult,
  type Evidence,
  type Finding,
  type FindingGroup,
} from "@ghostdeps/core";
import type { AddedLines } from "./diff.js";

export const checkName = "ghostdeps";
export const quietSummary = "No significant dependency issues found.";
export const incompleteTitle = "Analysis incomplete - see notes";
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
  const open = cut.lastIndexOf("<details") > cut.lastIndexOf("</details>");
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

/**
 * Package facts section (#385): core's fact findings with their structured
 * provenance (source basis, declaring manifest). The summary is core's
 * wording, rendered verbatim as data - the renderer never parses it for
 * semantics and adds no age badges or newer-available framing. Facts never
 * affect the conclusion, title, count or annotations.
 */
function factsSection(facts: readonly Finding[]): string[] {
  if (facts.length === 0) return [];
  const lines = ["", "### Package facts", ""];
  for (const f of facts) {
    const dep = f.dependency ? `**${md(f.dependency)}** - ` : "";
    const bits: string[] = [];
    if (f.source !== undefined) bits.push(`source: ${f.source.basis}`);
    if (f.declaringManifest !== undefined) {
      bits.push(`declared in ${f.declaringManifest.path}, ${f.declaringManifest.ecosystem}`);
    }
    const suffix = bits.length > 0 ? ` _(${md(bits.join("; "))})_` : "";
    lines.push(`- ${dep}${md(f.summary)}${suffix}`);
  }
  return lines;
}

function awarenessSection(awareness: readonly Finding[]): string[] {
  if (awareness.length === 0) return [];
  const n = awareness.length;
  return [
    "",
    `<details><summary>${n} awareness note${n === 1 ? "" : "s"} (no action suggested)</summary>`,
    "",
    ...awareness.map(
      (f) => `- ${f.dependency ? `**${md(f.dependency)}** - ` : ""}${md(f.summary)}`,
    ),
    "",
    "</details>",
  ];
}

function noteLine(f: Finding): string {
  return `- ${f.dependency ? `**${md(f.dependency)}** - ` : ""}${md(f.summary)}`;
}

/**
 * Core's notes (findingGroup "incomplete" and "note") plus the app's own
 * status notes: plain text about a step the app itself skipped, e.g. an
 * unreadable PR diff (#195). Core's notes cover what core decided; the app
 * never repeats them.
 */
function notesSection(notes: readonly Finding[], appNotes: readonly string[]): string[] {
  const lines = [...appNotes.map((n) => `- ${md(n)}`), ...notes.map(noteLine)];
  return lines.length > 0 ? ["", "### Notes", "", ...lines] : [];
}

function summaryLine(f: Finding): string {
  const dep = f.dependency ? `**${md(f.dependency)}** - ` : "";
  return `- ${dep}${md(f.summary)} _(${f.confidence} confidence)_`;
}

/**
 * Builds the check conclusion and output.
 * @param added lines the PR added, by path. Pass an empty map for pushes: no annotations then.
 * @param appNotes the app's own status notes (not Findings); they make a run incomplete like core's notes.
 */
export function renderCheck(
  result: AnalysisResult,
  added: AddedLines,
  appNotes: readonly string[] = [],
): CheckOutput {
  // Grouping is core's (#239): the app only formats. "incomplete" notes and
  // the app's own notes make a finding-free run neutral; plain adapter
  // "note"s are shown but keep success; "awareness" never counts; "fact"s
  // are listed but never cap anything.
  const group = (g: FindingGroup) => result.findings.filter((f) => findingGroup(f) === g);
  const findings = group("verdict");
  const notes = [...group("incomplete"), ...group("note")];
  const awareness = group("awareness");
  const facts = group("fact");
  const incomplete = group("incomplete").length + appNotes.length;
  if (findings.length === 0 && incomplete === 0) {
    return {
      conclusion: "success",
      output: {
        title: quietSummary,
        summary: truncateSummary(
          [
            quietSummary,
            ...factsSection(facts),
            ...awarenessSection(awareness),
            ...notesSection(notes, appNotes),
          ].join("\n"),
        ),
        annotations: [],
      },
    };
  }
  if (findings.length === 0) {
    const intro =
      "GhostDeps found no dependency findings, but the analysis was incomplete, so this is not a clean result. This check is advisory and never blocks merging.";
    return {
      conclusion: "neutral",
      output: {
        title: incompleteTitle,
        summary: truncateSummary(
          [
            intro,
            ...factsSection(facts),
            ...awarenessSection(awareness),
            ...notesSection(notes, appNotes),
          ].join("\n"),
        ),
        annotations: [],
      },
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
      // Open when nothing is high-confidence (e.g. while the #178 cap applies),
      // so the only findings aren't hidden behind a click.
      `<details${high.length === 0 ? " open" : ""}><summary>${lower.length} lower-confidence finding${lower.length === 1 ? "" : "s"} (manual review)</summary>`,
      "",
      ...lower.map(summaryLine),
      "",
      "</details>",
    );
  }
  parts.push(
    ...factsSection(facts),
    ...awarenessSection(awareness),
    ...notesSection(notes, appNotes),
  );

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
