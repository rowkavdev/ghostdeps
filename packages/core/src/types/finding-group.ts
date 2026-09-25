import type { Finding } from "./index.js";

/**
 * How presenters group a finding (#239). One classifier in core, so the CLI
 * and the GitHub App can't drift; each surface owns only its formatting.
 *
 * - "verdict": every non-info finding. Grouped by confidence; drives the
 *   conclusion and exit code per severity.
 * - "fact": core-validated health observation about the exact locked version.
 *   It does not gate or change the conclusion, title or count. Distinct from
 *   awareness, because the observation can suggest a review action.
 * - "incomplete": engine cap and incompleteness notes (adapter failure or
 *   timeout, truncation, partial scan, policy error, cap notes, PR changes
 *   not analysed) and any other unmarked info finding. Listed in Notes; a
 *   run whose only notes are these is neutral "Analysis incomplete" (#197).
 * - "note": a non-capping run-level adapter note, marked `adapterNote` by
 *   the engine when it maps an adapter's note in (#205). Listed in Notes;
 *   the conclusion stays success when these are the only notes.
 * - "awareness": `awareness: true` (#234). Awareness section; never affects
 *   the conclusion, title, count or exit code.
 *
 * Fail-closed: only an explicit `true` marker moves an info finding out of
 * "incomplete", so an unknown or unmarked note always costs a clean check
 * rather than hiding behind one. Both markers are engine-owned: the engine
 * strips them from adapter and policy output, so adapters can never pick
 * "note" or "awareness", and the engine never needs to mark "incomplete".
 */
export type FindingGroup = "verdict" | "fact" | "incomplete" | "note" | "awareness";

export function findingGroup(
  finding: Pick<Finding, "kind" | "healthFact" | "awareness" | "adapterNote">,
): FindingGroup {
  if (finding.kind !== "info") return "verdict";
  if (finding.healthFact === true) return "fact";
  if (finding.awareness === true) return "awareness";
  if (finding.adapterNote === true) return "note";
  return "incomplete";
}
