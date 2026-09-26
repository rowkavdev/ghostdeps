import { findingGroup, scanScopeRows, scanScopeSummary } from "@ghostdeps/core";
import type {
  AnalysisResult,
  DependencyImpact,
  Finding,
  FindingKind,
  SurfaceEntry,
} from "@ghostdeps/core";
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
  "should-be-dev": "should be dev dependencies",
  "type-only": "type-only dependencies",
  info: "info",
};

/** Canonical display order for finding kinds; zero-count kinds are omitted. */
const findingOrder: readonly FindingKind[] = [
  "unused",
  "potentially-unnecessary",
  "duplicate-capability",
  "maintenance-risk",
  "footprint",
  "should-be-dev",
  "type-only",
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

/** Evidence lines shown per verdict before a "+N more" cap. */
const MAX_EVIDENCE_LINES = 8;

/** Verdict kinds whose claim is about removing the dependency, so impact applies (#59 C). */
const IMPACT_KINDS: ReadonlySet<FindingKind> = new Set([
  "unused",
  "potentially-unnecessary",
  "duplicate-capability",
]);

/** 1_400_000 -> "1.4 MB" (decimal units, like registries report). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  // Compare the rounded value, so 999,950 B reads "1.0 MB", not "1000.0 kB".
  while (Number(value.toFixed(1)) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Directory of a repository-relative file, "." for the root. */
function dirOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i <= 0 ? "." : file.slice(0, i);
}

/**
 * The one impact entry a verdict is about (#59 C): same name, and the
 * declaring project when the finding names its manifest. Ambiguous or
 * missing means none - better no line than another project's numbers.
 */
function impactFor(
  finding: Finding,
  impact: readonly DependencyImpact[] | undefined,
): DependencyImpact | undefined {
  if (!impact || finding.dependency === undefined || !IMPACT_KINDS.has(finding.kind)) {
    return undefined;
  }
  let matches = impact.filter((entry) => entry.name === finding.dependency);
  if (matches.length > 1 && finding.affectedFiles.length > 0) {
    const projects = new Set(finding.affectedFiles.map(dirOf));
    matches = matches.filter((entry) => projects.has(entry.project));
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The impact line under a verdict (#59 C), or undefined when nothing is
 * known. Facts only, never a verdict: "at least" on a partial graph, no
 * removal count unless core computed one, and footprint always as a lower
 * bound with its coverage. Unknown counts print nothing rather than 0.
 */
export function impactLine(entry: DependencyImpact): string | undefined {
  if (entry.transitive === null || entry.limited === true) return undefined;
  const n = groupThousands(entry.transitive);
  const plural = entry.transitive === 1 ? "package" : "packages";
  const parts = [
    entry.graph === "complete" ? `${n} transitive ${plural}` : `at least ${n} transitive ${plural}`,
  ];
  if (entry.exclusive !== null) {
    parts.push(
      entry.exclusive === 0
        ? "removing it drops no other packages"
        : `removing it drops ${groupThousands(entry.exclusive)} of them`,
    );
  }
  const footprint = entry.footprint;
  if (footprint && Number.isFinite(footprint.bytes) && footprint.bytes >= 0) {
    const { sized, total } = footprint.coverage;
    parts.push(
      `at least ${formatBytes(footprint.bytes)} installed (${sized} of ${total} packages sized, ${escapeTerminal(footprint.basis)})`,
    );
  }
  return `      - impact: ${parts.join("; ")}`;
}

/**
 * One verdict line plus its evidence. Dependency names, summaries and
 * evidence statements are policy text built from repository facts, so
 * everything goes through escapeTerminal (security-model rule 6).
 */
function renderVerdict(finding: Finding, impact?: readonly DependencyImpact[]): string[] {
  const name = finding.dependency ?? "(repository-wide)";
  const rule = finding.rule === undefined ? "" : `, rule: ${finding.rule}`;
  const lines = [
    `    ${escapeTerminal(name)} - ${escapeTerminal(finding.summary)} (${finding.confidence} confidence${rule})`,
  ];
  const evidence = finding.evidence;
  for (const item of evidence.slice(0, MAX_EVIDENCE_LINES)) {
    lines.push(`      - ${escapeTerminal(item.statement)}`);
  }
  if (evidence.length > MAX_EVIDENCE_LINES) {
    lines.push(`      - ... and ${evidence.length - MAX_EVIDENCE_LINES} more`);
  }
  const entry = impactFor(finding, impact);
  const line = entry ? impactLine(entry) : undefined;
  if (line) lines.push(line);
  return lines;
}

/**
 * Verdicts are the findings core's findingGroup (#239) classifies as
 * "verdict" - every non-info finding, grouped by kind in canonical order.
 * Info findings (scan completeness, coverage gaps, awareness-only notes)
 * are caveats about the analysis, not verdicts on dependencies - they
 * render as Notes and Awareness notes below. The section is omitted when
 * there is nothing to say.
 */
function renderVerdicts(
  findings: readonly Finding[],
  impact?: readonly DependencyImpact[],
): string[] {
  const verdicts = findings.filter((finding) => findingGroup(finding) === "verdict");
  if (verdicts.length === 0) return [];
  const lines = ["Verdicts:"];
  for (const kind of findingOrder) {
    if (kind === "info") continue;
    const group = verdicts.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;
    lines.push(`  ${findingLabels[kind]}:`);
    for (const finding of group) {
      lines.push(...renderVerdict(finding, impact));
    }
  }
  return ["", ...lines];
}

/**
 * One package fact line (#385): dependency, core's summary, then the
 * structured provenance fields - `source.basis` and the declaring manifest.
 * The summary is core's wording and is shown verbatim; presenters never
 * parse it (or evidence) for semantics, and never add relative-age badges
 * or newer-available framing. Basis and manifest fields are external and
 * repository data, so everything goes through escapeTerminal.
 */
function renderFact(finding: Finding): string[] {
  const name = finding.dependency ?? "(repository-wide)";
  const parts: string[] = [];
  if (finding.source !== undefined) {
    parts.push(`source: ${escapeTerminal(finding.source.basis)}`);
  }
  const manifest = finding.declaringManifest;
  if (manifest !== undefined) {
    parts.push(
      `declared in ${escapeTerminal(manifest.path)}, ${escapeTerminal(manifest.ecosystem)}`,
    );
  }
  const suffix = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  return [`    ${escapeTerminal(name)} - ${escapeTerminal(finding.summary)}${suffix}`];
}

/**
 * Package facts are the source-backed health observations findingGroup
 * (#239) calls "fact" (core's `healthFact: true`, #61/#351): facts about
 * the exact locked version, action-relevant but never capping. Always
 * visible like Notes and Awareness notes; they never affect the verdict
 * lines, the tally or the exit code. Omitted when there are none.
 */
function renderFacts(findings: readonly Finding[]): string[] {
  const facts = findings.filter((finding) => findingGroup(finding) === "fact");
  if (facts.length === 0) return [];
  return ["", "Package facts:", ...facts.flatMap((fact) => renderFact(fact))];
}

/**
 * Notes are the info findings findingGroup (#239) calls "incomplete" or
 * "note": engine cap and incompleteness notes (partial scans, adapter
 * failures, cap notices, manual-review notes such as unverified-no-imports)
 * plus non-capping run-level adapter notes. They are always visible (same
 * analysis, same picture on every surface) and they never change the
 * verdict lines or the exit code. Omitted when there are none.
 */
function renderNotes(findings: readonly Finding[]): string[] {
  const notes = findings.filter((finding) => {
    const group = findingGroup(finding);
    return group === "incomplete" || group === "note";
  });
  if (notes.length === 0) return [];
  return ["", "Notes:", ...notes.flatMap((note) => renderVerdict(note))];
}

/**
 * Awareness notes are the no-action info findings findingGroup (#239)
 * calls "awareness" (core's `awareness: true`, #234, fail-closed). They
 * are always visible and never affect the verdicts, the counts or the
 * exit code. Omitted when there are none.
 */
function renderAwarenessNotes(findings: readonly Finding[]): string[] {
  const notes = findings.filter((finding) => findingGroup(finding) === "awareness");
  if (notes.length === 0) return [];
  return ["", "Awareness notes:", ...notes.flatMap((note) => renderVerdict(note))];
}

/**
 * Transitive totals come from `surface`, read through the #114 completeness
 * marker: "complete" makes the sum exact, anything else makes it a lower
 * bound, and no usable graph at all makes it unknown. A missing marker reads
 * as unknown, never as complete - conservative by design.
 */
function transitiveSummary(surface: readonly SurfaceEntry[]): string {
  if (surface.length === 0) return "unknown";
  const lower = surface.reduce((total, s) => total + s.transitive, 0);
  if (surface.every((s) => s.graphs === "complete")) return groupThousands(lower);
  if (lower > 0) return `at least ${groupThousands(lower)}`;
  return "unknown";
}

/**
 * Render the repository summary for a full scan.
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
  const transitive = transitiveSummary(result.surface);

  // Awareness and source-backed facts never inflate the finding tally.
  const counts = new Map<FindingKind, number>();
  for (const finding of result.findings) {
    if (["awareness", "fact"].includes(findingGroup(finding))) continue;
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
    ...(result.scanScope
      ? [
          "",
          "Scan scope:",
          `  ${scanScopeSummary(result.scanScope)}`,
          ...scanScopeRows(result.scanScope).map((row) => `  ${escapeTerminal(row)}`),
        ]
      : []),
    "",
    "Direct dependencies:",
    `  ${groupThousands(direct)}`,
    "",
    "Transitive dependencies:",
    `  ${transitive}`,
    "",
    "Findings:",
    ...(findingLines.length > 0 ? findingLines : ["  none"]),
    ...renderVerdicts(result.findings, result.impact),
    ...renderFacts(result.findings),
    ...renderNotes(result.findings),
    ...renderAwarenessNotes(result.findings),
  ].join("\n");
}
