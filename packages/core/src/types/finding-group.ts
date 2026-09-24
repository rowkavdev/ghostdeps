import type { Finding } from "./index.js";

/**
 * How presenters group a finding (#234 follow-through). One classifier in
 * core, so the CLI and the GitHub App can't drift; each surface owns only
 * its formatting.
 *
 * - "awareness": `awareness` is explicitly `true`. Listed separately and
 *   never affects a check conclusion, title, count or exit code.
 * - "note": any other info finding (run notes, scan completeness,
 *   unverified-no-imports, ...). Keeps its Notes / neutral meaning.
 * - "verdict": every non-info finding.
 *
 * Fail-closed: anything but an explicit `true` is not awareness, and
 * awareness only applies to info findings.
 */
export type FindingGroup = "verdict" | "note" | "awareness";

export function findingGroup(finding: Pick<Finding, "kind" | "awareness">): FindingGroup {
  if (finding.kind !== "info") return "verdict";
  return finding.awareness === true ? "awareness" : "note";
}
