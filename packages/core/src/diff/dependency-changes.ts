/**
 * Dependency changes in a pull request: which direct dependencies were
 * added, removed or changed, whether lockfiles moved with them, and which
 * source lines changed so usage analysis can check the new dependencies.
 *
 * Format-agnostic by design. Core never parses manifests itself: the caller
 * supplies `readDeclared`, normally an adapter's listDirectDependencies()
 * run against the base and head trees (ADR 0002). package.json is the first
 * format wired through the JavaScript/TypeScript adapter.
 */
import type { Dependency, DependencyKind, SourceLineChanges } from "../types/index.js";
import { classifyDependencyFile, type DependencyFileMatch } from "./dependency-files.js";
import { addedLines, removedLines, type FileDiff, type ParsedDiff } from "./unified.js";

export type DiffSide = "base" | "head";

/**
 * Declared direct dependencies of one manifest on one side of the PR.
 * Return undefined when the manifest could not be read or parsed; the
 * extraction records that as a limitation instead of guessing.
 *
 * Implementations must:
 * - read through the job's RepositoryHandle for that side, never the host
 *   filesystem (paths come from an attacker-controlled diff; core already
 *   drops absolute, `..`, backslash and control-character paths);
 * - extract statically. A manifest with an executable surface (setup.py) is
 *   parsed as text or reported as unreadable by returning undefined - never
 *   imported, evaluated or run (ADR 0004 rule 2).
 */
export type ReadDeclaredDependencies = (
  side: DiffSide,
  manifestPath: string,
  file: DependencyFileMatch,
) => Promise<Dependency[] | undefined>;

export interface DeclaredVersion {
  constraint: string;
  kind: DependencyKind;
}

export interface DependencyChange {
  change: "added" | "removed" | "changed";
  name: string;
  ecosystem: string;
  /** Manifest path on the head side (base side for removals). */
  manifest: string;
  before?: DeclaredVersion;
  after?: DeclaredVersion;
  /**
   * Added dependencies need usage analysis before anything can be said
   * about them; "added but never used" is decided downstream, not here.
   */
  usageCheck?: "pending";
}

export interface ChangedLockfile {
  path: string;
  ecosystem: string;
  packageManager?: string;
  status: FileDiff["status"];
}

export interface ChangedSourceFile {
  path: string;
  /** Lines added in the head version, for import/usage scanning. */
  addedLines: { line: number; text: string }[];
}

export interface PullRequestDependencyChanges {
  changes: DependencyChange[];
  /** Manifests touched by the PR (head-side paths). */
  manifestsChanged: string[];
  lockfilesChanged: ChangedLockfile[];
  /**
   * Manifests whose dependencies changed with no lockfile change in the
   * same ecosystem and directory. Information only: the lockfile may live
   * at a workspace root.
   */
  manifestsWithoutLockfileChange: string[];
  /** Non-dependency files that gained lines (not deleted, not binary). */
  changedSourceFiles: ChangedSourceFile[];
  /**
   * Removed and added lines for every non-dependency, non-binary file the
   * PR touched, including deleted files and removal-only edits (#101).
   * Pass it as AnalyseOptions.pullRequestSourceChanges; core caps it there.
   */
  sourceLineChanges: SourceLineChanges[];
  /** Why this result may be incomplete. Empty when the diff was fully read. */
  limitations: string[];
}

/**
 * Diff paths are attacker data. Reject anything that could escape the
 * repository root or hide in terminal/annotation output.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH = /[\u0000-\u001f\u007f\\]|^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/;

export function isSafeRepositoryPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !UNSAFE_PATH.test(path);
}

const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
};

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Direct dependencies keyed by name + kind (the same name can be runtime and dev). */
function index(deps: Dependency[]): Map<string, Dependency> {
  const map = new Map<string, Dependency>();
  for (const dep of deps) map.set(`${dep.kind}\u0000${dep.name}`, dep);
  return map;
}

/** Compare one manifest's declared dependencies between base and head. */
export function diffDeclaredDependencies(
  base: Dependency[],
  head: Dependency[],
  manifest: { base?: string; head?: string; ecosystem: string },
): DependencyChange[] {
  const before = index(base);
  const after = index(head);
  const added: Dependency[] = [];
  const removed: Dependency[] = [];
  const changes: DependencyChange[] = [];
  const headPath = manifest.head ?? manifest.base ?? "";
  const basePath = manifest.base ?? manifest.head ?? "";

  for (const [key, dep] of after) {
    const old = before.get(key);
    if (!old) added.push(dep);
    else if (old.constraint !== dep.constraint) {
      changes.push({
        change: "changed",
        name: dep.name,
        ecosystem: manifest.ecosystem,
        manifest: headPath,
        before: { constraint: old.constraint, kind: old.kind },
        after: { constraint: dep.constraint, kind: dep.kind },
      });
    }
  }
  for (const [key, dep] of before) if (!after.has(key)) removed.push(dep);

  // A dependency moved between kinds (dev -> runtime) is one change, not two.
  const removedByName = new Map<string, Dependency[]>();
  for (const dep of removed) {
    const list = removedByName.get(dep.name);
    if (list) list.push(dep);
    else removedByName.set(dep.name, [dep]);
  }
  const moved = new Set<Dependency>();
  for (const dep of added) {
    const old = removedByName.get(dep.name)?.shift();
    if (old) {
      moved.add(old);
      changes.push({
        change: "changed",
        name: dep.name,
        ecosystem: manifest.ecosystem,
        manifest: headPath,
        before: { constraint: old.constraint, kind: old.kind },
        after: { constraint: dep.constraint, kind: dep.kind },
      });
      continue;
    }
    changes.push({
      change: "added",
      name: dep.name,
      ecosystem: manifest.ecosystem,
      manifest: headPath,
      after: { constraint: dep.constraint, kind: dep.kind },
      usageCheck: "pending",
    });
  }
  for (const old of removed) {
    if (moved.has(old)) continue;
    changes.push({
      change: "removed",
      name: old.name,
      ecosystem: manifest.ecosystem,
      manifest: basePath,
      before: { constraint: old.constraint, kind: old.kind },
    });
  }
  return changes.sort(byName);
}

/** Extract dependency changes from a parsed PR diff. */
export async function extractDependencyChanges(
  diff: ParsedDiff,
  readDeclared: ReadDeclaredDependencies,
): Promise<PullRequestDependencyChanges> {
  const limitations: string[] = [];
  if (diff.truncated) limitations.push("The diff was too large to read in full.");
  for (const p of diff.problems) limitations.push(`Part of the diff could not be read: ${p}.`);

  const changes: DependencyChange[] = [];
  const manifestsChanged: string[] = [];
  const lockfilesChanged: ChangedLockfile[] = [];
  const changedSourceFiles: ChangedSourceFile[] = [];
  const sourceLineChanges: SourceLineChanges[] = [];
  const manifestsWithDependencyChanges: { path: string; ecosystem: string }[] = [];

  for (const file of diff.files) {
    const path = file.newPath ?? file.oldPath;
    if (path === undefined) {
      limitations.push("A file in the diff had no readable path.");
      continue;
    }
    const unsafe = [file.oldPath, file.newPath].find(
      (p) => p !== undefined && !isSafeRepositoryPath(p),
    );
    if (unsafe !== undefined) {
      limitations.push(`Skipped a file with an unsafe path: ${JSON.stringify(unsafe)}.`);
      continue;
    }
    const match =
      classifyDependencyFile(path) ??
      (file.oldPath ? classifyDependencyFile(file.oldPath) : undefined);

    if (!match) {
      if (!file.binary) {
        const added = file.newPath !== undefined ? addedLines(file) : [];
        const removed = removedLines(file);
        if (file.newPath !== undefined && added.length > 0) {
          changedSourceFiles.push({ path: file.newPath, addedLines: added });
        }
        if (added.length > 0 || removed.length > 0) {
          sourceLineChanges.push({ path, removedLines: removed, addedLines: added });
        }
      }
      continue;
    }

    if (match.role === "lockfile") {
      const lock: ChangedLockfile = { path, ecosystem: match.ecosystem, status: file.status };
      if (match.packageManager !== undefined) lock.packageManager = match.packageManager;
      lockfilesChanged.push(lock);
      continue;
    }

    manifestsChanged.push(path);
    const [base, head] = await Promise.all([
      file.oldPath !== undefined ? readDeclared("base", file.oldPath, match) : Promise.resolve([]),
      file.newPath !== undefined ? readDeclared("head", file.newPath, match) : Promise.resolve([]),
    ]);
    if (base === undefined || head === undefined) {
      const side = base === undefined ? "base" : "head";
      limitations.push(
        `Could not read the dependencies in ${path} (${side}); its changes are unknown.`,
      );
      continue;
    }
    const manifest: { base?: string; head?: string; ecosystem: string } = {
      ecosystem: match.ecosystem,
    };
    if (file.oldPath !== undefined) manifest.base = file.oldPath;
    if (file.newPath !== undefined) manifest.head = file.newPath;
    const found = diffDeclaredDependencies(base, head, manifest);
    if (found.length > 0) manifestsWithDependencyChanges.push({ path, ecosystem: match.ecosystem });
    changes.push(...found);
  }

  // Workspaces keep one lockfile at the workspace root, so any changed
  // lockfile of the same ecosystem in the manifest's directory or an
  // ancestor counts.
  const coveredBy = (manifest: string, lockfile: string): boolean => {
    const lockDir = dirOf(lockfile);
    for (let dir = dirOf(manifest); ; dir = dirOf(dir)) {
      if (dir === lockDir) return true;
      if (dir === ".") return false;
    }
  };
  const manifestsWithoutLockfileChange = manifestsWithDependencyChanges
    .filter(
      (m) =>
        !lockfilesChanged.some((l) => l.ecosystem === m.ecosystem && coveredBy(m.path, l.path)),
    )
    .map((m) => m.path);

  return {
    changes,
    manifestsChanged,
    lockfilesChanged,
    manifestsWithoutLockfileChange,
    changedSourceFiles,
    sourceLineChanges,
    limitations,
  };
}
