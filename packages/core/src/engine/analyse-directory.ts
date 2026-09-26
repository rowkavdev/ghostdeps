/**
 * Convenience entry point for local checkouts: scan a directory with the
 * repository scanner (#7), analyse it (#69), and turn scan limits that
 * could hide real source into info findings, so an incomplete scan is
 * never presented as a complete analysis. analyseRepository caps
 * "unused" and "potentially-unnecessary" findings at medium when the scan
 * is incomplete and appends these notes (AnalyseOptions.scanCompleteness).
 */
import type { AnalysisResult, Finding } from "../types/index.js";
import { analyseRepository, type AnalyseOptions } from "./analyse.js";
import { FsRepositoryHandle } from "./scanner/handle.js";
import type { ScanOptions, ScanResult, SkipReason } from "./scanner/scanner.js";

export interface AnalyseDirectoryOptions extends AnalyseOptions {
  scan?: ScanOptions;
}

/**
 * Skip reasons that may hide the project's own files. Excluded
 * vendor/generated directories, symlinks and special files are skipped by
 * design and are not reported.
 */
const INCOMPLETENESS_REASONS: readonly SkipReason[] = [
  "file-too-large",
  "too-deep",
  "path-too-long",
  "unsafe-name",
  "unreadable",
];

/** Summary text per reason, with the right noun for what the count counts. */
const REASON_TEXT: Partial<Record<SkipReason, (count: number) => string>> = {
  "unsafe-name": (n) => `${n} entr${n === 1 ? "y" : "ies"} with unsafe names`,
  "path-too-long": (n) => `${n} path${n === 1 ? "" : "s"} over the length limit`,
  "too-deep": (n) => `${n} director${n === 1 ? "y" : "ies"} nested too deeply`,
  "file-too-large": (n) => `${n} file${n === 1 ? "" : "s"} over the size ceiling`,
  unreadable: (n) => `${n} unreadable path${n === 1 ? "" : "s"}`,
};

/** Info findings describing where the scan was incomplete. */
export function scanCompletenessFindings(scan: ScanResult): Finding[] {
  const findings: Finding[] = [];
  if (scan.truncated !== undefined) {
    findings.push({
      kind: "info",
      summary: `repository scan stopped early (${scan.truncated}); results cover part of the repository`,
      recommendation: "Manual review recommended; raise the scan limits or analyse a subdirectory.",
      evidence: [
        {
          kind: "scan-truncated",
          statement: `scan stopped at ${scan.files.length} files, ${scan.totalBytes} bytes (${scan.truncated})`,
        },
      ],
      confidence: "high",
      limitations: ["Dependencies used only in unscanned files may be reported as unused."],
      affectedFiles: [],
    });
  }
  const scope = scan.scope;
  if (scope && scope.excludedFiles > 0) {
    findings.push({
      kind: "info",
      summary: `fixture scope omitted ${scope.excludedFiles} file(s), including ${scope.excludedManifests} recognised manifest(s)`,
      recommendation:
        "Review the Scan scope record; omitted declarations and references were not analysed.",
      evidence: scope.roots
        .filter((root) => root.matched)
        .slice(0, 5)
        .map((root) => ({
          kind: "scan-scope-excluded",
          statement: `${root.files} file(s), ${root.manifests} recognised manifest(s) omitted`,
          file: root.root,
        })),
      confidence: "high",
      limitations: [
        "Excluded declarations and usage are unknown; absence verdicts are provisional.",
      ],
      affectedFiles: scope.roots
        .filter((root) => root.matched)
        .slice(0, 5)
        .map((root) => root.root),
    });
  }
  for (const reason of INCOMPLETENESS_REASONS) {
    const count = scan.skippedCounts[reason] ?? 0;
    if (count === 0) continue;
    const examples = scan.skipped.filter((s) => s.reason === reason).slice(0, 5);
    findings.push({
      kind: "info",
      summary: `${REASON_TEXT[reason]!(count)} not analysed`,
      recommendation: "Manual review recommended for the skipped paths.",
      evidence: examples.map((s) => ({
        kind: `scan-skipped-${reason}`,
        statement: `skipped: ${reason}`,
        file: s.path,
      })),
      confidence: "high",
      limitations: ["Usage in skipped files is not visible to the analysis."],
      affectedFiles: examples.map((s) => s.path),
    });
  }
  return findings;
}

/** Scan `rootDir`, analyse it, and report scan incompleteness as info findings. */
export async function analyseDirectory(
  rootDir: string,
  options: AnalyseDirectoryOptions,
): Promise<AnalysisResult> {
  const { scan: scanOptions, ...analyseOptions } = options;
  const handle = await FsRepositoryHandle.open(rootDir, scanOptions ?? {});
  // Core caps absence findings and appends these notes (#154).
  return analyseRepository(handle, {
    ...analyseOptions,
    scanCompleteness: scanCompletenessFindings(handle.scan),
    ...(handle.scan.scope ? { scanScope: handle.scan.scope } : {}),
  });
}
