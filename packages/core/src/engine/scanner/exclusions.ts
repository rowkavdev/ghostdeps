/**
 * Default exclusion and recognition rules for the repository scanner.
 *
 * Excluded directories are vendored, generated, cached or VCS content that
 * is never the project's own source. Excluding them keeps analysis focused
 * and bounded; it is not a security control (the ceilings in limits.ts are).
 */

/** Directory names skipped wherever they appear. Matched case-sensitively. */
export const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
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
export const DEFAULT_EXCLUDED_FILE_SUFFIXES: readonly string[] = [
  ".min.js",
  ".min.mjs",
  ".min.cjs",
  ".min.css",
  ".map",
];

/**
 * Lockfiles are always listed (never excluded as generated) and get the
 * larger lockfile size ceiling. Graph parsing depends on them.
 */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "pdm.lock",
  "Cargo.lock",
  "go.sum",
]);

/**
 * Manifest names that make a directory a candidate project root, with the
 * ecosystem they hint at. Hints only: adapters make the real, evidence-based
 * detection decision (ADR 0002). The scanner never parses these.
 */
export const PROJECT_MANIFESTS: ReadonlyMap<string, string> = new Map([
  ["package.json", "javascript-typescript"],
  ["deno.json", "javascript-typescript"],
  ["deno.jsonc", "javascript-typescript"],
  ["pyproject.toml", "python"],
  ["setup.cfg", "python"],
  ["setup.py", "python"],
  ["requirements.txt", "python"],
  ["Pipfile", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["go.work", "go"],
]);

export function isLockfile(fileName: string): boolean {
  return LOCKFILE_NAMES.has(fileName);
}

export function hasExcludedSuffix(fileName: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => fileName.endsWith(suffix));
}
