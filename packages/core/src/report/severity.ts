import type { Confidence, Finding, FindingKind, Severity } from "../types/index.js";

export type { Severity };

/*
 * Severity for CI gating and display filtering. Derived from kind +
 * confidence, never from the policy rule. The engine derives it once,
 * before the #178 confidence cap, and stamps it on every emitted finding
 * (Finding.severity). Consumers read the stamp through effectiveSeverity.
 */

/** Highest first; the array index is the rank used for comparisons. */
export const severityOrder: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

/** Parse a severity name (e.g. a CLI flag value); undefined when it is not one. */
export function parseSeverity(text: string): Severity | undefined {
  return (severityOrder as readonly string[]).includes(text) ? (text as Severity) : undefined;
}

/**
 * Shipping gate for `unused` (#173, ADR-0004): a false "unused" is the worst
 * output ghostdeps can produce, so until the pinned corpus check (#172) has
 * been green on every nightly run for 14 consecutive days, `unused` findings
 * can never reach high or critical and so cannot gate CI at `--fail-on high`.
 * The cap is the kind's ceiling; confidence still drops rungs below it.
 *
 * Lifting it is a one-line change: set this to "high" (the kind's default)
 * and update the contract test in severity.test.ts in the same PR. If the
 * corpus regresses after the lift, the cap does not return by itself - that
 * needs a fresh decision.
 */
export const UNUSED_SEVERITY_CAP: Severity = "medium";

/**
 * Companion gate (#178): the confidence core emits for `unused` findings is
 * min(computed, this). It never raises confidence. The engine applies it
 * where findings are produced (assembleAnalysisResult), never the
 * renderers, and adds one run-level info note when it capped anything.
 * The lift criterion is the same as UNUSED_SEVERITY_CAP (#172 green for 14
 * consecutive nightly runs). Both caps come off in one PR, with their
 * contract tests updated together.
 *
 * Composition (#188): the engine stamps severity BEFORE applying this cap,
 * so the cap limits only the displayed confidence. An unused finding
 * computed at high confidence is severity medium (the #173 ceiling) with
 * displayed confidence medium, not low, so `--fail-on medium` catches it.
 */
export const UNUSED_CONFIDENCE_CAP: Confidence = "medium";

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** min(confidence, cap): a ceiling, never a floor. */
export function capConfidence(confidence: Confidence, cap: Confidence): Confidence {
  return CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[cap] ? cap : confidence;
}

/**
 * The worst a finding of each kind can be. Every FindingKind needs an
 * explicit entry - the Record type fails typecheck otherwise, and
 * severity.test.ts asserts completeness at runtime - so a new kind must be
 * placed deliberately, never silently inherit a severity.
 */
const kindCeiling: Record<FindingKind, Severity> = {
  unused: UNUSED_SEVERITY_CAP,
  "should-be-dev": "medium",
  "type-only": "medium",
  "duplicate-capability": "medium",
  "potentially-unnecessary": "low",
  "maintenance-risk": "low",
  footprint: "low",
  info: "info",
};

/** Kinds this build does not know (a newer engine) fall back to info. */
const UNKNOWN_KIND_CEILING: Severity = "info";

/** Confidence downgrade: high keeps the ceiling, each lower step drops one rung. */
const confidenceDrop: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Severity of one finding. Info-kind findings (scan-completeness notes,
 * policy-missing notices) are always info whatever their confidence, so
 * they can never trip `--fail-on high` (#110 x cli #155).
 */
export function severityOf(finding: Finding): Severity {
  const ceiling = kindCeiling[finding.kind] ?? UNKNOWN_KIND_CEILING;
  const rank = Math.min(
    severityOrder.indexOf(ceiling) + confidenceDrop[finding.confidence],
    severityOrder.length - 1,
  );
  return severityOrder[rank] ?? "info";
}

/**
 * The severity consumers act on: the engine's stamp (Finding.severity).
 * Only a finding that never went through the engine (a hand-built one in a
 * test or tool) falls back to deriving it from its own kind and confidence.
 */
export function effectiveSeverity(finding: Finding): Severity {
  return finding.severity ?? severityOf(finding);
}

/** True when the finding's effective severity is at or above the threshold. */
export function atOrAboveSeverity(finding: Finding, threshold: Severity): boolean {
  return severityOrder.indexOf(effectiveSeverity(finding)) <= severityOrder.indexOf(threshold);
}
