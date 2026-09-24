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
 * and the js-adapter lockfile graph (#83) each defined their own constant
 * (32 MiB on main); they now share this one. Anything
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

/**
 * Caps on AnalyseOptions.pullRequestSourceChanges (#101), in the #133 style:
 * the payload is attacker-shaped diff text that core forwards to every
 * adapter (and clones into every worker), so it is bounded before it leaves
 * the engine. Lines past a per-file cap, files past the total byte cap, and
 * malformed entries are dropped and reported in one info finding. Dropping
 * is the safe direction: a missed removed line only means no PR-scoped
 * "unused" finding, never a false one.
 */
export const PR_SOURCE_CHANGE_LIMITS = {
  /** Removed lines kept per file; the same cap applies to added lines. */
  maxLinesPerFile: 5_000,
  /** Longer lines are dropped, not truncated (a cut import could mismatch). */
  maxLineChars: 2_000,
  /** Total UTF-16 code units of paths plus line text across the payload. */
  maxTotalChars: 8 * 1024 * 1024,
} as const;

/**
 * Hard cap on one bounded head read (RepositoryHandle.readFileHead, #113).
 * Head reads skip the per-file ceiling, so they need their own bound: a
 * larger maxBytes is clamped to this. 64 KiB is far more than any format
 * sniff needs (the berry check reads 512 bytes).
 */
export const MAX_HEAD_READ_BYTES = 64 * 1024;

/**
 * Most packages the emitted unified graph carries (#55). The cap applies to
 * the output only: findings are computed from the full in-memory graphs
 * before emission, so it can never change a verdict. When it bites, the
 * result carries one info note and per-ecosystem emitted/total counts.
 */
export const MAX_EMITTED_GRAPH_NODES = 5_000;
