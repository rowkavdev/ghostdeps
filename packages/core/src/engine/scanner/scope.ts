/** Opt-in, bounded fixture-root scope. Entry points must not enable this until
 * their result renderers disclose the scope and cap absence verdicts (#354).
 */
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { PROJECT_MANIFESTS, DEFAULT_EXCLUDED_DIRECTORIES } from "./exclusions.js";
import type { ScanLimits } from "./limits.js";

const CONFIG = ".ghostdeps.json";
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_ROOTS = 32;
// C0/C1, DEL, backslash, bidi format controls and zero-width format controls.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\\\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
export interface FixtureRootCount {
  root: string;
  matched: boolean;
  files: number;
  manifests: number;
}
export interface ScanScope {
  source: "none" | "repo-config";
  schemaVersion: 1 | null;
  /** SHA-256 of the canonical effective scope, not a timestamp or checkout path. */
  digest: string;
  roots: FixtureRootCount[];
  matchedRoots: number;
  excludedFiles: number;
  excludedManifests: number;
  /** Exact accounting or a visible error: never imply an incomplete count is zero. */
  countingComplete: true;
  builtInPolicy: "default-v1";
}

function digest(roots: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, fixtureRoots: roots }))
    .digest("hex");
}

function validateRoot(root: unknown, limits: ScanLimits): string {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > limits.maxPathLength ||
    root.startsWith("/") ||
    root.endsWith("/") ||
    UNSAFE.test(root)
  ) {
    throw new Error("invalid fixture root in .ghostdeps.json");
  }
  const parts = root.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("*") ||
        part.includes("?") ||
        DEFAULT_EXCLUDED_DIRECTORIES.has(part),
    ) ||
    parts.length > limits.maxDepth
  ) {
    throw new Error(`invalid or built-in-excluded fixture root: ${root}`);
  }
  return root;
}

/** Read at most 16 KiB, reject symlinks, malformed/unknown fields and unsafe paths. */
export async function readFixtureRoots(
  root: string,
  limits: ScanLimits,
): Promise<{
  source: ScanScope["source"];
  roots: string[];
}> {
  const configPath = path.join(root, CONFIG);
  let st;
  try {
    st = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: "none", roots: [] };
    throw error;
  }
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES)
    throw new Error("invalid .ghostdeps.json: not a regular file or exceeds 16 KiB");
  const file = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.ino !== st.ino ||
      current.dev !== st.dev ||
      current.size > MAX_CONFIG_BYTES
    ) {
      throw new Error(".ghostdeps.json changed during read");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error(".ghostdeps.json exceeds 16 KiB");
    bytes = buffer.subarray(0, length);
  } finally {
    await file.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid .ghostdeps.json: expected UTF-8 JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "fixtureRoots,schemaVersion" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((parsed as { fixtureRoots?: unknown }).fixtureRoots)
  ) {
    throw new Error("invalid .ghostdeps.json: expected schemaVersion 1 and fixtureRoots only");
  }
  const values = (parsed as { fixtureRoots: unknown[] }).fixtureRoots;
  if (values.length > MAX_ROOTS) throw new Error(".ghostdeps.json exceeds 32 fixture roots");
  const roots = values.map((r) => validateRoot(r, limits)).sort();
  for (let i = 1; i < roots.length; i++) {
    if (roots[i] === roots[i - 1] || roots[i]!.startsWith(`${roots[i - 1]}/`)) {
      throw new Error("duplicate or overlapping fixture roots in .ghostdeps.json");
    }
  }
  return { source: "repo-config", roots };
}

/** Reject a nonexistent, symlinked or non-directory root before counting. */
async function checkedDirectory(root: string, rel: string): Promise<string> {
  let current = root;
  for (const component of rel.split("/")) {
    current = path.join(current, component);
    const st = await lstat(current);
    if (!st.isDirectory()) throw new Error(`fixture root is not a real directory: ${rel}`);
  }
  // Catch an unexpectedly exchanged ancestor even on platforms with unusual mounts.
  if (!(await realpath(current)).startsWith(`${root}${path.sep}`)) {
    throw new Error(`fixture root leaves checkout: ${rel}`);
  }
  return current;
}

/** Count metadata only. A ceiling/unreadable entry fails visibly, never exact-zero. */
async function countRoot(
  root: string,
  rel: string,
  limits: ScanLimits,
): Promise<{ count: FixtureRootCount; directories: number }> {
  let start: string;
  try {
    start = await checkedDirectory(root, rel);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const top = rel.split("/")[0]!;
      try {
        await lstat(path.join(root, top));
      } catch (topError) {
        if ((topError as NodeJS.ErrnoException).code !== "ENOENT") throw topError;
      }
      return { count: { root: rel, matched: false, files: 0, manifests: 0 }, directories: 0 };
    }
    throw error;
  }
  let files = 0;
  let manifests = 0;
  let directories = 0;
  const stack = [{ full: start, depth: rel.split("/").length }];
  while (stack.length) {
    const { full, depth } = stack.pop()!;
    if (
      !(await lstat(full)).isDirectory() ||
      !(await realpath(full)).startsWith(`${root}${path.sep}`)
    ) {
      throw new Error(`fixture scope directory changed during count: ${rel}`);
    }
    if (++directories > limits.maxDirectories || depth > limits.maxDepth) {
      throw new Error(`fixture scope count exceeds directory/depth limit: ${rel}`);
    }
    const entries = await readdir(full, { withFileTypes: true, encoding: "buffer" });
    for (const entry of entries) {
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(entry.name);
      } catch {
        throw new Error(`fixture scope contains unsafe filename: ${rel}`);
      }
      if (
        !name ||
        name === "." ||
        name === ".." ||
        UNSAFE.test(name) ||
        path.relative(root, path.join(full, name)).length > limits.maxPathLength
      ) {
        throw new Error(`fixture scope contains unsafe filename: ${rel}`);
      }
      if (entry.isDirectory()) {
        if (directories + stack.length + 1 > limits.maxDirectories || depth + 1 > limits.maxDepth) {
          throw new Error(`fixture scope count exceeds directory/depth limit: ${rel}`);
        }
        stack.push({ full: path.join(full, name), depth: depth + 1 });
      } else if (entry.isFile()) {
        if (++files > limits.maxFiles)
          throw new Error(`fixture scope count exceeds file limit: ${rel}`);
        if (PROJECT_MANIFESTS.has(name)) manifests++;
      } else {
        throw new Error(`fixture scope contains symlink or special entry: ${rel}`);
      }
      // Symlinks cannot provide an exact inventory of what lies behind them.
    }
  }
  return { count: { root: rel, matched: true, files, manifests }, directories };
}

/** Call before the filtered walk, so audit counts remain independent of listed-file ceilings. */
export async function fixtureScope(root: string, limits: ScanLimits): Promise<ScanScope> {
  const config = await readFixtureRoots(root, limits);
  const roots: FixtureRootCount[] = [];
  let directories = 0;
  let files = 0;
  for (const rel of config.roots) {
    const counted = await countRoot(root, rel, limits);
    directories += counted.directories;
    files += counted.count.files;
    if (directories > limits.maxDirectories || files > limits.maxFiles) {
      throw new Error("fixture scope count exceeds aggregate limits");
    }
    roots.push(counted.count);
  }
  return {
    source: config.source,
    schemaVersion: config.source === "none" ? null : 1,
    digest: digest(config.roots),
    roots,
    matchedRoots: roots.filter((item) => item.matched).length,
    excludedFiles: files,
    excludedManifests: roots.reduce((total, item) => total + item.manifests, 0),
    countingComplete: true,
    builtInPolicy: "default-v1",
  };
}
