import type { AnalysisResult, FindingKind } from "@ghostdeps/core";
import { escapeTerminal } from "./escape.js";

/**
 * Human renderer for a full-repository scan. The canonical layout lives in
 * docs/output-formats.md ("Repository summary"); if this file and that one
 * disagree, that one wins.
 */

/** Display names for known ecosystem ids; unknown ids render capitalised. */
const ecosystemNames: Record<string, string> = {
  "javascript-typescript": "JavaScript/TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
};

/** Finding kind -> label used in the summary's Findings section. */
const findingLabels: Record<FindingKind, string> = {
  unused: "unused",
  "potentially-unnecessary": "potentially unnecessary",
  "duplicate-capability": "duplicate capabilities",
  "maintenance-risk": "maintenance risks",
  footprint: "footprint",
  info: "info",
};

/** Canonical display order for finding kinds; zero-count kinds are omitted. */
const findingOrder: readonly FindingKind[] = [
  "unused",
  "potentially-unnecessary",
  "duplicate-capability",
  "maintenance-risk",
  "footprint",
  "info",
];

function ecosystemName(id: string): string {
  // Known names are ours; unknown ids are adapter data, so escape them.
  return ecosystemNames[id] ?? escapeTerminal(id.charAt(0).toUpperCase() + id.slice(1));
}

/** 1482 -> "1,482", matching the canonical format's grouping. */
function groupThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Render the repository summary for a full scan.
 *
 * Transitive totals come from `surface`. When the engine could not build a
 * graph for any project (no lockfiles), surface is empty and the summary
 * says "unknown" rather than guessing - conservative by design.
 */
export function renderRepositorySummary(result: AnalysisResult): string {
  const languages = unique(result.detected.map((d) => ecosystemName(d.ecosystem)));
  const packageManagers = unique(
    result.projects.flatMap((project) =>
      // Package-manager names come from the repository's manifests.
      project.packageManagers.map((pm) => escapeTerminal(pm.name)),
    ),
  );
  const direct = result.dependencies.length;
  const transitive =
    result.surface.length > 0
      ? groupThousands(result.surface.reduce((total, s) => total + s.transitive, 0))
      : "unknown";

  const counts = new Map<FindingKind, number>();
  for (const finding of result.findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  const findingLines = findingOrder
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => `  ${counts.get(kind)} ${findingLabels[kind]}`);

  const section = (title: string, lines: string[]): string[] => [
    `${title}:`,
    ...(lines.length > 0 ? lines.map((line) => `  ${line}`) : ["  none detected"]),
  ];

  return [
    "GhostDeps",
    "",
    ...section("Languages", languages),
    "",
    ...section("Package managers", packageManagers),
    "",
    "Direct dependencies:",
    `  ${groupThousands(direct)}`,
    "",
    "Transitive dependencies:",
    `  ${transitive}`,
    "",
    "Findings:",
    ...(findingLines.length > 0 ? findingLines : ["  none"]),
  ].join("\n");
}
