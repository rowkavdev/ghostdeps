/**
 * Convenience entry point for local checkouts: scan a directory with the
 * repository scanner (#7), analyse it (#69), and turn scan limits that
 * could hide real source into info findings, so an incomplete scan is
 * never presented as a complete analysis.
 */
import type { AnalysisResult, Finding } from "../types/index.js";
import { normaliseAnalysisResult } from "../report/json.js";
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

const REASON_TEXT: Record<SkipReason, string> = {
  "excluded-directory": "in excluded directories",
  "excluded-generated-file": "generated",
  symlink: "symlinks",
  "special-file": "special files",
  "unsafe-name": "with unsafe names",
  "path-too-long": "with over-long paths",
  "too-deep": "nested too deeply",
  "file-too-large": "over the size ceiling",
  unreadable: "unreadable",
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
  for (const reason of INCOMPLETENESS_REASONS) {
    const count = scan.skippedCounts[reason] ?? 0;
    if (count === 0) continue;
    const examples = scan.skipped.filter((s) => s.reason === reason).slice(0, 5);
    findings.push({
      kind: "info",
      summary: `${count} file(s) or directories ${REASON_TEXT[reason]} were not analysed`,
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
  const result = await analyseRepository(handle, analyseOptions);
  const notes = scanCompletenessFindings(handle.scan);
  if (notes.length === 0) return result;
  return normaliseAnalysisResult({ ...result, findings: [...result.findings, ...notes] });
}
