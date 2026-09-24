/**
 * Repository scanner: a bounded, read-only walk of a local directory
 * (typically an extracted codeload tarball, see #8) that produces the file
 * list a RepositoryHandle serves and the candidate project roots adapters
 * start from.
 *
 * Rules (docs/security-model.md, ADR 0004):
 * - symlinks are never followed; they are recorded as skipped, not listed
 * - only regular files and real directories are visited (no FIFOs, devices, sockets)
 * - every walk is bounded by ScanLimits; hitting a walk ceiling marks the
 *   result truncated instead of throwing, so analysis degrades confidence
 * - names that are not valid UTF-8 or contain control characters or
 *   backslashes are skipped, so every listed path is an unambiguous POSIX path
 * - nothing is parsed or executed here
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  DEFAULT_EXCLUDED_FILE_SUFFIXES,
  PROJECT_MANIFESTS,
  hasExcludedSuffix,
  isLockfile,
} from "./exclusions.js";
import { resolveLimits, type ScanLimits } from "./limits.js";

export interface ScanOptions {
  limits?: Partial<ScanLimits>;
  /** Replaces the default excluded directory names. */
  excludedDirectories?: ReadonlySet<string>;
  /** Replaces the default excluded file suffixes. */
  excludedFileSuffixes?: readonly string[];
}

/** One listed file. Paths are repository-relative POSIX paths. */
export interface ScannedFile {
  path: string;
  size: number;
  lockfile: boolean;
}

export type SkipReason =
  | "excluded-directory"
  | "excluded-generated-file"
  | "symlink"
  | "special-file"
  | "unsafe-name"
  | "path-too-long"
  | "too-deep"
  | "file-too-large"
  | "unreadable";

/** Something the walk deliberately did not list, with why. */
export interface SkippedEntry {
  path: string;
  reason: SkipReason;
}

export type TruncationReason = "max-files" | "max-directories" | "max-total-bytes";

/** A directory holding a recognised manifest. A hint, not a detection verdict. */
export interface CandidateProjectRoot {
  /** Repository-relative directory; "." for the root. */
  path: string;
  /** Manifest file names found directly in this directory, sorted. */
  manifests: string[];
  /** Ecosystems those manifests hint at, sorted and de-duplicated. */
  ecosystemHints: string[];
}

export interface ScanResult {
  /** Canonical absolute path of the scanned root. */
  root: string;
  /** Listed files, sorted by path. */
  files: ScannedFile[];
  /** Candidate project roots, sorted by path. */
  candidateProjectRoots: CandidateProjectRoot[];
  /** Skipped entries, sorted by path. Excluded-directory skips are listed once, at the directory. */
  skipped: SkippedEntry[];
  /** Set when a walk ceiling stopped the scan early; the file list is incomplete. */
  truncated?: TruncationReason;
  totalBytes: number;
  limits: ScanLimits;
}

// C0/C1 control characters, DEL, and backslash (ambiguous separator on Windows).
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\\]/;

function decodeName(raw: Buffer): string | undefined {
  try {
    const name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (name.length === 0 || name === "." || name === ".." || UNSAFE_NAME.test(name)) {
      return undefined;
    }
    return name;
  } catch {
    return undefined;
  }
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

class Truncated extends Error {
  constructor(readonly reason: TruncationReason) {
    super(reason);
  }
}

/**
 * Walk `rootDir` and return the bounded, deterministic view of it.
 * Throws only when the root itself is unusable (missing, not a directory, or a symlink).
 */
export async function scanRepository(
  rootDir: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const limits = resolveLimits(options.limits);
  const excludedDirs = options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES;
  const excludedSuffixes = options.excludedFileSuffixes ?? DEFAULT_EXCLUDED_FILE_SUFFIXES;

  const rootStat = await lstat(rootDir);
  if (rootStat.isSymbolicLink()) {
    throw new Error("scan root must not be a symlink");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("scan root must be a directory");
  }
  const root = await realpath(rootDir);

  const files: ScannedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const manifestsByDir = new Map<string, string[]>();
  let totalBytes = 0;
  let directories = 0;
  let truncated: TruncationReason | undefined;

  // Iterative depth-first walk; an explicit stack avoids recursion-depth attacks.
  const stack: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];

  try {
    while (stack.length > 0) {
      const { rel, depth } = stack.pop()!;
      directories += 1;
      if (directories > limits.maxDirectories) throw new Truncated("max-directories");

      let entries: { name: Buffer; isDir: boolean; isFile: boolean; isLink: boolean }[];
      try {
        const dirents = await readdir(path.join(root, rel), {
          withFileTypes: true,
          encoding: "buffer",
        });
        entries = dirents.map((d) => ({
          name: d.name,
          isDir: d.isDirectory(),
          isFile: d.isFile(),
          isLink: d.isSymbolicLink(),
        }));
      } catch {
        skipped.push({ path: rel === "" ? "." : rel, reason: "unreadable" });
        continue;
      }

      const childDirs: string[] = [];
      for (const entry of entries) {
        const name = decodeName(entry.name);
        const display =
          rel === "" ? entry.name.toString("latin1") : `${rel}/${entry.name.toString("latin1")}`;
        if (name === undefined) {
          skipped.push({ path: display, reason: "unsafe-name" });
          continue;
        }
        const childRel = rel === "" ? name : `${rel}/${name}`;
        if (childRel.length > limits.maxPathLength) {
          skipped.push({ path: childRel.slice(0, limits.maxPathLength), reason: "path-too-long" });
          continue;
        }

        // Dirent types come from lstat semantics: a symlink is never reported as a dir/file.
        if (entry.isLink) {
          skipped.push({ path: childRel, reason: "symlink" });
          continue;
        }
        if (entry.isDir) {
          if (excludedDirs.has(name)) {
            skipped.push({ path: childRel, reason: "excluded-directory" });
          } else if (depth + 1 > limits.maxDepth) {
            skipped.push({ path: childRel, reason: "too-deep" });
          } else {
            childDirs.push(childRel);
          }
          continue;
        }
        if (!entry.isFile) {
          skipped.push({ path: childRel, reason: "special-file" });
          continue;
        }

        const lockfile = isLockfile(name);
        if (!lockfile && hasExcludedSuffix(name, excludedSuffixes)) {
          skipped.push({ path: childRel, reason: "excluded-generated-file" });
          continue;
        }

        let size: number;
        try {
          const st = await lstat(path.join(root, childRel));
          if (!st.isFile()) {
            skipped.push({
              path: childRel,
              reason: st.isSymbolicLink() ? "symlink" : "special-file",
            });
            continue;
          }
          size = st.size;
        } catch {
          skipped.push({ path: childRel, reason: "unreadable" });
          continue;
        }

        const ceiling = lockfile ? limits.maxLockfileBytes : limits.maxFileBytes;
        if (size > ceiling) {
          skipped.push({ path: childRel, reason: "file-too-large" });
          continue;
        }
        if (files.length + 1 > limits.maxFiles) throw new Truncated("max-files");
        if (totalBytes + size > limits.maxTotalBytes) throw new Truncated("max-total-bytes");

        files.push({ path: childRel, size, lockfile });
        totalBytes += size;

        if (PROJECT_MANIFESTS.has(name)) {
          const dir = rel === "" ? "." : rel;
          const list = manifestsByDir.get(dir) ?? [];
          list.push(name);
          manifestsByDir.set(dir, list);
        }
      }

      // Push in reverse-sorted order so the walk visits directories in sorted order.
      childDirs.sort().reverse();
      for (const dir of childDirs) stack.push({ rel: dir, depth: depth + 1 });
    }
  } catch (error) {
    if (!(error instanceof Truncated)) throw error;
    truncated = error.reason;
  }

  const candidateProjectRoots: CandidateProjectRoot[] = [...manifestsByDir.entries()]
    .map(([dir, manifests]) => ({
      path: dir,
      manifests: [...manifests].sort(),
      ecosystemHints: [...new Set(manifests.map((m) => PROJECT_MANIFESTS.get(m)!))].sort(),
    }))
    .sort(byPath);

  const result: ScanResult = {
    root,
    files: files.sort(byPath),
    candidateProjectRoots,
    skipped: skipped.sort(byPath),
    totalBytes,
    limits,
  };
  if (truncated !== undefined) result.truncated = truncated;
  return result;
}
