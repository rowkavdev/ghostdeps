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
