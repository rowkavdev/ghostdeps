/**
 * Scanner recognition rules. The exclusion lists themselves live in
 * packages/core/src/limits.ts (issue #89 single source); they are
 * re-exported here so existing scanner imports keep working.
 */

export {
  EXCLUDED_DIRECTORIES as DEFAULT_EXCLUDED_DIRECTORIES,
  EXCLUDED_FILE_SUFFIXES as DEFAULT_EXCLUDED_FILE_SUFFIXES,
} from "../../limits.js";

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
