/**
 * Comment renderer (PR-comment design slice 3): one maintained PR comment
 * rendered from the SAME AnalysisResult the check run came from - the app
 * never reclassifies a finding for the comment. Only independently eligible
 * findings (core fix-preview statically-checked, ADR 0005) get a checkbox;
 * everything else gets an explanation with the reason it cannot be ticked.
 */
import type { AnalysisResult } from "@ghostdeps/core";
import { buildMarker, MAX_MARKER_KEYS } from "./marker.js";

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
   * Eligibility per finding, keyed by `<rule>:<dependency>`, computed by the
   * worker from core's fix preview at analysis time. A finding missing from
   * this map is rendered explanation-only ("not evaluated").
   */
  readonly eligibility: ReadonlyMap<string, FindingEligibility>;
  /**
   * When false (installation declined issues:write, or apply not yet
   * available), tickboxes are still rendered but the footer says plainly
   * that apply is not enabled. Rendering stays honest either way.
   */
  readonly applyAvailable: boolean;
}

/** `rule:dependency` joins a finding to its eligibility entry. */
export function eligibilityId(rule: string, dependency: string): string {
  return `${rule}:${dependency}`;
}

/** Repository-controlled text is capped and fenced of markdown control. */
function clean(text: string): string {
  const noControls = text.replace(/[`\r]/g, "'").replace(/\n/g, " ");
  return noControls.length > MAX_LINE ? `${noControls.slice(0, MAX_LINE - 1)}…` : noControls;
}

function findingLine(
  rule: string,
  dependency: string,
  summary: string,
  recommendation: string,
  confidence: string,
  eligibility: FindingEligibility | undefined,
): { line: string; tickKey?: string } {
  const base = `**${rule} \`${clean(dependency)}\`** - ${clean(summary)} ${clean(recommendation)} _Confidence: ${confidence}._`;
  if (eligibility?.status === "eligible") {
    return {
      line: `- [ ] ${base} <!-- gd-key:${eligibility.key} -->`,
      tickKey: eligibility.key,
    };
  }
  const reason =
    eligibility?.status === "ineligible" ? eligibility.reason : "not evaluated for a safe removal";
  return { line: `- ${base}\n  - _No tickbox: ${clean(reason)}_` };
}

export function renderPrComment(input: RenderInput): string {
  const findings = input.result.findings.filter(
    (f) => f.dependency !== undefined && f.rule !== undefined && f.awareness !== true,
  );
  const notes = input.result.findings.filter((f) => f.dependency === undefined);
  const tickKeys: string[] = [];
  const lines: string[] = [];

  for (const f of findings.slice(0, MAX_MARKER_KEYS * 2)) {
    const rule = f.rule!;
    const dep = f.dependency!;
    const eligibility = TICKABLE_RULES.has(rule)
      ? input.eligibility.get(eligibilityId(rule, dep))
      : ({ status: "ineligible", reason: "this rule is explanation-only" } as const);
    const { line, tickKey } = findingLine(
      rule,
      dep,
      f.summary,
      f.recommendation,
      f.confidence,
      eligibility,
    );
    if (tickKey && tickKeys.length < MAX_MARKER_KEYS) tickKeys.push(tickKey);
    lines.push(line);
  }

  const marker = buildMarker({
    repositoryId: input.repositoryId,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    keys: tickKeys,
  });

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

  const parts = [marker, "", header];
  if (intro) parts.push(intro);
  if (lines.length > 0) parts.push("", ...lines);
  if (notes.length > 0) {
    parts.push("", "### Notes");
    for (const n of notes.slice(0, 10)) parts.push(`- ${clean(n.summary)}`);
  }
  parts.push(
    "",
    "---",
    `_Head analysed: \`${input.headSha.slice(0, 7)}\`. If the branch moves, this comment is re-rendered from a fresh scan instead of acting on stale ticks._`,
  );

  let body = parts.join("\n");
  // Cap: drop finding lines from the end rather than ship a truncated marker
  // or footer; the check run always carries the full list.
  while (Buffer.byteLength(body) > MAX_COMMENT_BYTES && lines.length > 0) {
    lines.pop();
    body = [
      marker,
      "",
      header,
      intro,
      "",
      ...lines,
      "",
      `_List capped; see the check run for the full findings._`,
      "",
      "---",
      `_Head analysed: \`${input.headSha.slice(0, 7)}\`._`,
    ].join("\n");
  }
  return body;
}
