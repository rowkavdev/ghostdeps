import type { Evidence, Finding } from "../types/index.js";

/** At most this many manifests get their own note; the rest share one. */
export const MAX_MALFORMED_MANIFEST_NOTES = 100;

/**
 * Engine mapping for adapter `manifest-malformed` detection evidence
 * (#269, arbiter ruling: core-owned, uniform for every ecosystem). A
 * manifest the adapter could not parse hides its declared dependencies, so
 * "Findings: none" would be a silent wrong answer (ADR 0004). Each one
 * becomes a scan-completeness note: unmarked info (findingGroup
 * "incomplete"), which caps verdicts and makes the run neutral (#154,
 * #197). Adapters need no contract change; the evidence kind already exists.
 * Only detected ecosystems are mapped: below-threshold detection is not
 * analysed at all.
 */
export function manifestMalformedNotes(
  detected: readonly { ecosystem: string; evidence: readonly Evidence[] }[],
): Finding[] {
  // One note per (ecosystem, file); lines and statements are kept as evidence.
  const byManifest = new Map<string, { ecosystem: string; file?: string; evidence: Evidence[] }>();
  for (const outcome of detected) {
    for (const e of outcome.evidence) {
      if (e.kind !== "manifest-malformed") continue;
      const file = typeof e.file === "string" ? e.file : undefined;
      const key = `${outcome.ecosystem}\0${file ?? ""}`;
      let entry = byManifest.get(key);
      if (entry === undefined) {
        entry = {
          ecosystem: outcome.ecosystem,
          ...(file !== undefined ? { file } : {}),
          evidence: [],
        };
        byManifest.set(key, entry);
      }
      if (entry.evidence.length < 5) entry.evidence.push({ ...e });
    }
  }
  const entries = [...byManifest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const notes: Finding[] = entries.slice(0, MAX_MALFORMED_MANIFEST_NOTES).map(([, m]) => ({
    kind: "info",
    rule: "manifest-malformed",
    summary: `${m.ecosystem}: ${m.file ?? "a manifest"} could not be parsed; its declared dependencies may be missing`,
    recommendation:
      "Manual review recommended: fix or check this manifest; results for its project are incomplete.",
    evidence: m.evidence,
    confidence: "high",
    limitations: ["Dependencies declared in this manifest are not visible to the analysis."],
    affectedFiles: m.file !== undefined ? [m.file] : [],
  }));
  const rest = entries.length - notes.length;
  if (rest > 0) {
    notes.push({
      kind: "info",
      rule: "manifest-malformed",
      summary: `${rest} more manifest(s) could not be parsed; their declared dependencies may be missing`,
      recommendation: "Manual review recommended for the unparsed manifests.",
      evidence: [
        {
          kind: "manifest-malformed",
          statement: `${rest} further unparsed manifest(s) past the note limit of ${MAX_MALFORMED_MANIFEST_NOTES}`,
        },
      ],
      confidence: "high",
      limitations: ["Dependencies declared in these manifests are not visible to the analysis."],
      affectedFiles: [],
    });
  }
  return notes;
}
