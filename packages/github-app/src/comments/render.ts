/**
 * Comment renderer (PR-comment design slice 3): one maintained PR comment
 * rendered from the SAME AnalysisResult the check run came from - the app
 * never reclassifies a finding for the comment. Only independently eligible
 * findings (core fix-preview statically-checked, ADR 0005) get a checkbox;
 * everything else gets an explanation with the reason it cannot be ticked.
 * Eligibility is joined by rule + project + dependency (reviewer-1 #425):
 * same-named declarations in different projects never share a verdict.
 */
import type { AnalysisResult, Finding } from "@ghostdeps/core";
import { buildMarker, MAX_MARKER_KEYS } from "./marker.js";
import { eligibilityId, resolveFindingDeclaration } from "./resolve.js";

/** GitHub's comment body cap is 65536; stay well under it. */
export const MAX_COMMENT_BYTES = 60_000;
/** A finding summary longer than this is truncated rather than dropped. */
const MAX_LINE = 300;
/** Eligible rules per ADR 0005's guards; anything else is explanation-only. */
export const TICKABLE_RULES = new Set(["unused", "should-be-dev", "type-only"]);

export type FindingEligibility =
  | { readonly status: "eligible"; readonly key: string }
  | { readonly status: "ineligible"; readonly reason: string };

export interface RenderInput {
  readonly result: AnalysisResult;
  readonly repositoryId: number;
  readonly pullNumber: number;
  readonly headSha: string;
  /**
   * Eligibility per finding, keyed by `rule:projectPath:dependency` (see
   * resolve.ts), computed by the worker from core's fix preview at analysis
   * time. A finding missing from this map renders explanation-only.
   */
  readonly eligibility: ReadonlyMap<string, FindingEligibility>;
  /**
   * When false (installation declined issues:write, or apply not yet
   * available), the intro says plainly that ticking does nothing yet.
   */
  readonly applyAvailable: boolean;
}

/**
 * Neutralise repository-controlled text for markdown/HTML: backslash-escape
 * every markdown-significant character so no link, image, tag, emphasis,
 * table or raw-HTML construct survives, then cap length. The text stays
 * readable as plain text; it can never become markup.
 */
function clean(text: string): string {
  const flat = text.replace(/\r/g, " ").replace(/\n/g, " ");
  let out = "";
  for (const ch of flat) {
    // Hyphen is not escaped: mid-line it is plain text, and the comment
    // controls every line start, so list markers cannot be injected.
    if ("\\`*_{}[]<>()#+.!|~".includes(ch)) out += "\\";
    out += ch;
  }
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE - 1)}…` : out;
}

/**
 * Neutralise a name that sits INSIDE a backtick code span: only a backtick
 * or backslash can break out of the span; every other character renders
 * literally, so escaping it would show the backslash to the reader.
 */
function cleanCode(text: string): string {
  return text.replace(/\\/g, "'").replace(/`/g, "'").replace(/\r/g, " ").replace(/\n/g, " ");
}

interface Entry {
  readonly lines: string[];
  readonly tickKey?: string;
}

function findingEntry(f: Finding, eligibility: FindingEligibility | undefined): Entry {
  const base = `**${clean(f.rule!)} \`${cleanCode(f.dependency!)}\`** - ${clean(f.summary)} ${clean(f.recommendation)} _Confidence: ${clean(f.confidence)}._`;
  if (eligibility?.status === "eligible") {
    return {
      lines: [`- [ ] ${base} <!-- gd-key:${eligibility.key} -->`],
      tickKey: eligibility.key,
    };
  }
  const reason =
    eligibility?.status === "ineligible" ? eligibility.reason : "not evaluated for a safe removal";
  return { lines: [`- ${base}`, `  - _No tickbox: ${clean(reason)}_`] };
}

/** Where a finding's eligibility lives in the map; unresolved = none. */
function eligibilityFor(input: RenderInput, f: Finding): FindingEligibility | undefined {
  if (!TICKABLE_RULES.has(f.rule!)) {
    return { status: "ineligible", reason: "this rule is explanation-only" };
  }
  const decl = resolveFindingDeclaration(input.result, f);
  if (decl.status !== "resolved") {
    return {
      status: "ineligible",
      reason:
        decl.status === "ambiguous"
          ? "the dependency is declared in more than one project; eligibility cannot be assigned safely"
          : "the declaration could not be located for revalidation",
    };
  }
  return input.eligibility.get(eligibilityId(f.rule!, decl.dependency.project.path, f.dependency!));
}

export function renderPrComment(input: RenderInput): string {
  const findings = input.result.findings.filter(
    (f) => f.dependency !== undefined && f.rule !== undefined && f.awareness !== true,
  );
  const notes = input.result.findings.filter((f) => f.dependency === undefined);

  const entries = findings
    .slice(0, MAX_MARKER_KEYS * 2)
    .map((f) => findingEntry(f, eligibilityFor(input, f)));

  const header =
    findings.length === 0
      ? "## GhostDeps - no dependency findings"
      : `## GhostDeps - ${findings.length} finding${findings.length === 1 ? "" : "s"} to review`;
  const intro =
    findings.length === 0
      ? ""
      : "\nAdvisory only; this never blocks merging. " +
        (input.applyAvailable
          ? "Tick a box and a trusted workflow on this repository will commit that removal to this PR branch. Only repository maintainers' ticks count, and everything is re-verified before any write."
          : "Tick-to-apply is not enabled on this installation yet, so boxes are shown for review only - ticking does nothing until the app update is accepted and the trusted workflow ships.");
  const footer =
    "---\n" +
    `_Head analysed: \`${input.headSha.slice(0, 7)}\`. If the branch moves, this comment is re-rendered from a fresh scan instead of acting on stale ticks._`;

  // Cap FIRST, marker SECOND: the hidden marker may only name tickable keys
  // whose checkboxes actually survive in the visible body (reviewer-1 #425).
  let shown = entries;
  let capped = false;
  const assemble = (): string => {
    const tickKeys = shown.flatMap((e) => (e.tickKey ? [e.tickKey] : [])).slice(0, MAX_MARKER_KEYS);
    const marker = buildMarker({
      repositoryId: input.repositoryId,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      keys: tickKeys,
    });
    const parts = [marker, "", header];
    if (intro) parts.push(intro);
    if (shown.length > 0) parts.push("", ...shown.flatMap((e) => e.lines));
    if (capped) parts.push("", "_List capped; see the check run for the full findings._");
    if (notes.length > 0) {
      parts.push("", "### Notes");
      for (const n of notes.slice(0, 10)) parts.push(`- ${clean(n.summary)}`);
    }
    parts.push("", footer);
    return parts.join("\n");
  };

  let body = assemble();
  while (Buffer.byteLength(body) > MAX_COMMENT_BYTES && shown.length > 0) {
    shown = shown.slice(0, -1);
    capped = true;
    body = assemble();
  }
  return body;
}
