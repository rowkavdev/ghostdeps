/**
 * Scanner ceilings. Every byte of a scanned repository is attacker-controlled
 * (docs/security-model.md), so every walk is bounded. The shared ceilings
 * (file count, per-file read, lockfile bytes) come from
 * packages/core/src/limits.ts (issue #89); scanner-specific ceilings stay
 * here. Defaults are documented in docs/repository-scanner.md; keep the two
 * in sync.
 */
import { MAX_FILE_READ_BYTES, MAX_LOCKFILE_BYTES, MAX_REPO_FILES } from "../../limits.js";
export interface ScanLimits {
  /** Maximum number of files listed. The walk stops (truncated) past this. */
  maxFiles: number;
  /** Maximum number of directories visited. The walk stops (truncated) past this. */
  maxDirectories: number;
  /** Maximum directory depth below the root. Deeper directories are skipped. */
  maxDepth: number;
  /** Maximum length of a repository-relative path, in characters. */
  maxPathLength: number;
  /** Maximum size of an ordinary file that can be listed and read. */
  maxFileBytes: number;
  /** Maximum size of a recognised lockfile (lockfiles are legitimately large). */
  maxLockfileBytes: number;
  /** Maximum sum of listed file sizes. The walk stops (truncated) past this. */
  maxTotalBytes: number;
  /** Maximum skipped entries recorded individually; past this only per-reason counts grow. */
  maxSkippedRecords: number;
}

export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  maxFiles: MAX_REPO_FILES,
  maxDirectories: 20_000,
  maxDepth: 32,
  maxPathLength: 1_024,
  maxFileBytes: MAX_FILE_READ_BYTES,
  maxLockfileBytes: MAX_LOCKFILE_BYTES,
  maxTotalBytes: 512 * 1024 * 1024,
  maxSkippedRecords: 10_000,
});

/** Merge caller overrides onto the defaults, rejecting nonsense values. */
export function resolveLimits(overrides: Partial<ScanLimits> = {}): ScanLimits {
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS };
  for (const [key, value] of Object.entries(overrides) as [keyof ScanLimits, unknown][]) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new RangeError(`scan limit ${key} must be a non-negative integer`);
    }
    limits[key] = value;
  }
  return limits;
}
