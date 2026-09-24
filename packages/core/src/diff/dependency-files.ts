/**
 * Which files in a change set are dependency manifests or lockfiles.
 * Matching is by file name only; nothing is read or executed.
 */

export type DependencyFileRole = "manifest" | "lockfile";

export interface DependencyFileMatch {
  ecosystem: string;
  role: DependencyFileRole;
  /** Package manager a lockfile identifies, when the name is specific. */
  packageManager?: string;
}

const FILES: Record<string, DependencyFileMatch> = {
  // JavaScript / TypeScript
  "package.json": { ecosystem: "javascript-typescript", role: "manifest" },
  "package-lock.json": {
    ecosystem: "javascript-typescript",
    role: "lockfile",
    packageManager: "npm",
  },
  "npm-shrinkwrap.json": {
    ecosystem: "javascript-typescript",
    role: "lockfile",
    packageManager: "npm",
  },
  "pnpm-lock.yaml": {
    ecosystem: "javascript-typescript",
    role: "lockfile",
    packageManager: "pnpm",
  },
  "yarn.lock": { ecosystem: "javascript-typescript", role: "lockfile", packageManager: "yarn" },
  "bun.lock": { ecosystem: "javascript-typescript", role: "lockfile", packageManager: "bun" },
  "bun.lockb": { ecosystem: "javascript-typescript", role: "lockfile", packageManager: "bun" },
  // Python
  "pyproject.toml": { ecosystem: "python", role: "manifest" },
  "requirements.txt": { ecosystem: "python", role: "manifest" },
  Pipfile: { ecosystem: "python", role: "manifest" },
  "setup.cfg": { ecosystem: "python", role: "manifest" },
  "setup.py": { ecosystem: "python", role: "manifest" },
  "poetry.lock": { ecosystem: "python", role: "lockfile", packageManager: "poetry" },
  "uv.lock": { ecosystem: "python", role: "lockfile", packageManager: "uv" },
  "Pipfile.lock": { ecosystem: "python", role: "lockfile", packageManager: "pipenv" },
  // Rust
  "Cargo.toml": { ecosystem: "rust", role: "manifest" },
  "Cargo.lock": { ecosystem: "rust", role: "lockfile", packageManager: "cargo" },
  // Go
  "go.mod": { ecosystem: "go", role: "manifest" },
  // go.sum is a checksum database, not a resolution record. It counts as a
  // lockfile only for "did the lock state move with the manifest"; never
  // parse it as the dependency graph (go.mod carries the resolved versions).
  "go.sum": { ecosystem: "go", role: "lockfile", packageManager: "go-modules" },
};

/** requirements-dev.txt, requirements/base.txt and similar pip files. */
const REQUIREMENTS =
  /(^|\/)requirements([-_.][\w.-]*)?\.(txt|in)$|(^|\/)requirements\/[\w.-]+\.(txt|in)$/;

/** Paths never treated as a project's own dependency files. */
const VENDORED = /(^|\/)(node_modules|vendor|\.venv|venv|site-packages|target)\//;

/** Classify a repository-relative path, or undefined when it is not a dependency file. */
export function classifyDependencyFile(path: string): DependencyFileMatch | undefined {
  if (VENDORED.test(path)) return undefined;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const known = Object.hasOwn(FILES, base) ? FILES[base] : undefined;
  if (known) return known;
  if (REQUIREMENTS.test(path)) return { ecosystem: "python", role: "manifest" };
  return undefined;
}
