import { EXCLUDED_FILE_SUFFIXES, hasExcludedSegment } from "@ghostdeps/core";

/**
 * Dependency manifests and lockfiles that make a change worth analysing.
 * Matched on the file's basename so monorepo members count too.
 * Keep in sync with docs/github-app.md ("Trigger table").
 */
const exactNames = new Set([
  // JavaScript / TypeScript
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  // Python
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "setup.py",
  "setup.cfg",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // Go
  "go.mod",
  "go.sum",
  "go.work",
]);

/** requirements.txt, requirements-dev.txt, requirements/base.txt, dev-requirements.in ... */
const requirementsPattern =
  /(^|\/)(requirements[^/]*|[^/]*-requirements)\.(txt|in)$|(^|\/)requirements\/[^/]+\.(txt|in)$/;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** True when the path is a dependency manifest or lockfile GhostDeps understands. */
export function isDependencyFile(path: string): boolean {
  return exactNames.has(basename(path)) || requirementsPattern.test(path);
}

/** The subset of changed paths that are dependency manifests or lockfiles. */
export function dependencyFilesIn(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of paths) if (isDependencyFile(p)) out.push(p);
  return out;
}

/**
 * Source files an adapter can scan for imports (#101). JS/TS only today,
 * matching the JS/TS adapter's scanner (including `.d.ts`). Add an
 * ecosystem's extensions here when its adapter gains usage analysis.
 * Keep in sync with docs/github-app.md ("Triggers for analysis").
 */
export const ANALYSABLE_SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
];

/**
 * True when a changed path is project source the analysis would read:
 * a scannable extension, outside core's excluded directories (installs,
 * build output, vendored code) and not a generated bundle.
 */
export function isAnalysableSource(path: string): boolean {
  if (hasExcludedSegment(path)) return false;
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;
  return ANALYSABLE_SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** The subset of changed paths that are analysable source files. */
export function sourceFilesIn(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of paths) if (isAnalysableSource(p)) out.push(p);
  return out;
}
