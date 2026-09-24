/**
 * Shared exclusion lists and size ceilings (issue #89).
 *
 * This module is the single source: scanner, detection and usage code
 * import from here and nobody forks a list. The ceilings bound hostile
 * input (ADR 0004); they are deliberately generous so real monorepos are
 * never silently excluded. Oversize input must surface as
 * reduced-confidence evidence (a limitation or skip record), never a
 * silent skip.
 */

/**
 * Directory names skipped wherever they appear. Matched case-sensitively.
 * Excluded directories are vendored, generated, cached or VCS content that
 * is never the project's own source. Exclusion keeps analysis focused and
 * bounded; it is not a security control (the byte ceilings below are).
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  // VCS metadata
  ".git",
  ".hg",
  ".svn",
  // JavaScript / TypeScript installs and build output
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  // Python environments and caches
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages",
  // Rust / JVM build output
  "target",
  ".gradle",
  // Vendored dependencies (Go, PHP, Ruby, general)
  "vendor",
  "third_party",
  "Pods",
]);

/** Generated files skipped by name suffix (minified bundles, source maps). */
export const EXCLUDED_FILE_SUFFIXES: readonly string[] = [
  ".min.js",
  ".min.mjs",
  ".min.cjs",
  ".min.css",
  ".map",
];

/**
 * True when any "/"-separated segment of a repository-relative path names
 * an excluded directory. Detection and usage walking use this; the scanner
 * matches directory names directly during its walk (same set, same
 * semantics).
 */
export function hasExcludedSegment(path: string): boolean {
  return path.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

/**
 * The one lockfile byte cap, shared by scanner listing and lockfile graph
 * parsing. 32 MiB: the largest real-world lockfiles (big pnpm/yarn
 * monorepos) run to a few MiB, so 32 MiB never excludes a real repository,
 * and it still bounds the parse cost of hostile input. The scanner (#73)
 * and the js-adapter lockfile graph (#83) previously carried 32 MiB and
 * 64 MiB; they converge here on the more conservative value. Anything
 * larger must be reported as a limitation, not parsed and not silently
 * dropped.
 */
export const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;

/**
 * Maximum number of files a repository scan lists before truncating
 * (`max-files`). Bounds walk cost on hostile trees; real monorepos with
 * more files surface as truncated scans, not silent partial results.
 */
export const MAX_REPO_FILES = 50_000;

/**
 * Maximum size of an ordinary file read as text (per-file read cap).
 * 2 MiB covers every plausible manifest and source file; larger files are
 * skipped with a recorded reason, never read partially.
 */
export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
