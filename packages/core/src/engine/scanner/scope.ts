/** Opt-in, bounded fixture-root scope (#354). The committed `.ghostdeps.json`
 * is the versioned default; the CLI (scan and fix), the GitHub Action and the
 * GitHub App's full scans honour it, and the CLI/Action accept an explicit
 * per-run override payload with the same grammar that replaces the committed
 * roots for that run. PR analyses stay unscoped until the base/head slice.
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
  source: "none" | "repo-config" | "per-run-override";
  schemaVersion: 1 | null;
  /** SHA-256 of the canonical effective scope (roots + built-in policy). */
  digest: string;
  /** Digest of the committed config's roots; null when no committed config. */
  configDigest: string | null;
  /** Digest of the per-run override payload's roots; null without an override. */
  overrideDigest: string | null;
  /** Analysed commit, when the caller knows it (the App does; the CLI cannot). */
  analysedSha: string | null;
  roots: FixtureRootCount[];
  matchedRoots: number;
  excludedFiles: number;
  excludedManifests: number;
  /** Exact accounting or a visible error: never imply an incomplete count is zero. */
  countingComplete: true;
  builtInPolicy: "default-v1";
}

/** Canonical scope-content digest; shared by config, override and base/head comparison (#354). */
export function fixtureRootsDigest(roots: readonly string[]): string {
  return digest(roots);
}

function digest(roots: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, fixtureRoots: roots, policy: "default-v1" }))
    .digest("hex");
}

function validateRoot(root: unknown, limits: ScanLimits, origin: string): string {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > limits.maxPathLength ||
    root.startsWith("/") ||
    root.endsWith("/") ||
    UNSAFE.test(root)
  ) {
    throw new Error(`invalid fixture root in ${origin}`);
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
    throw new Error(`invalid or built-in-excluded fixture root in ${origin}: ${root}`);
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
  commentsOff: boolean;
}> {
  const configPath = path.join(root, CONFIG);
  let st;
  try {
    st = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { source: "none", roots: [], commentsOff: false };
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
  const config = parsePayload(decode(bytes, CONFIG), limits, CONFIG);
  return { source: "repo-config" as const, roots: config.roots, commentsOff: config.commentsOff };
}

function decode(bytes: Buffer, origin: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`invalid ${origin}: expected UTF-8 JSON`);
  }
}

/**
 * One payload grammar for the committed file and the per-run override (#354):
 * a bounded, schema-versioned list of literal roots. `origin` names the source
 * in errors (`.ghostdeps.json` or `--fixture-roots`).
 */
export interface ScopeConfig {
  roots: string[];
  /** Opt-out of PR comments: the App never maintains its comment when true. */
  commentsOff: boolean;
}

function parsePayload(text: string, limits: ScanLimits, origin: string): ScopeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid ${origin}: expected UTF-8 JSON`);
  }
  const keys = Object.keys(parsed === null || typeof parsed !== "object" ? {} : parsed).sort();
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    keys.join(",") !== "fixtureRoots,schemaVersion" &&
      keys.join(",") !== "commentsOff,fixtureRoots,schemaVersion" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((parsed as { fixtureRoots?: unknown }).fixtureRoots)
  ) {
    throw new Error(
      `invalid ${origin}: expected schemaVersion 1, fixtureRoots, and optional commentsOff only`,
    );
  }
  const commentsOff = (parsed as { commentsOff?: unknown }).commentsOff;
  if (commentsOff !== undefined && typeof commentsOff !== "boolean") {
    throw new Error(`invalid ${origin}: commentsOff must be a boolean`);
  }
  const values = (parsed as { fixtureRoots: unknown[] }).fixtureRoots;
  if (values.length > MAX_ROOTS) throw new Error(`${origin} exceeds 32 fixture roots`);
  const roots = values.map((r) => validateRoot(r, limits, origin)).sort();
  for (let i = 1; i < roots.length; i++) {
    if (roots[i] === roots[i - 1] || roots[i]!.startsWith(`${roots[i - 1]}/`)) {
      throw new Error(`duplicate or overlapping fixture roots in ${origin}`);
    }
  }
  return { roots, commentsOff: commentsOff === true };
}

/**
 * One bounded payload grammar wherever a root list arrives as text (#354):
 * the per-run override (origin `--fixture-roots`) and a base-side committed
 * config read over the API (origin `.ghostdeps.json`).
 */
export function parseScopeConfigText(
  text: string,
  limits: ScanLimits,
  origin: string,
): ScopeConfig {
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    throw new Error(`${origin} exceeds 16 KiB`);
  }
  return parsePayload(text, limits, origin);
}

export function parseFixtureRootsText(text: string, limits: ScanLimits, origin: string): string[] {
  return parseScopeConfigText(text, limits, origin).roots;
}

/** The per-run override payload is bounded exactly like the committed file. */
export function parseFixtureRootsOverride(text: string, limits: ScanLimits): string[] {
  return parseFixtureRootsText(text, limits, "--fixture-roots");
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
export async function fixtureScope(
  root: string,
  limits: ScanLimits,
  options: { override?: string; analysedSha?: string } = {},
): Promise<ScanScope> {
  // The committed file is always read first: a malformed, unsupported or
  // unreadable config fails the scan even when an override is present, so an
  // override can never launder a broken versioned declaration into a clean
  // result. A present override then REPLACES the committed roots for the run
  // (an explicit empty list clears them) and is recorded with both digests.
  const config = await readFixtureRoots(root, limits);
  const overrideRoots =
    options.override === undefined
      ? undefined
      : parseFixtureRootsOverride(options.override, limits);
  const effectiveRoots = overrideRoots ?? config.roots;
  const analysedSha = options.analysedSha ?? null;
  if (analysedSha !== null && !/^[0-9a-f]{40}$/.test(analysedSha)) {
    throw new Error("analysed SHA must be a 40-character lowercase hex commit id");
  }
  const roots: FixtureRootCount[] = [];
  let directories = 0;
  let files = 0;
  for (const rel of effectiveRoots) {
    const counted = await countRoot(root, rel, limits);
    directories += counted.directories;
    files += counted.count.files;
    if (directories > limits.maxDirectories || files > limits.maxFiles) {
      throw new Error("fixture scope count exceeds aggregate limits");
    }
    roots.push(counted.count);
  }
  const source = overrideRoots !== undefined ? ("per-run-override" as const) : config.source;
  return {
    source,
    schemaVersion: source === "none" ? null : 1,
    digest: digest(effectiveRoots),
    configDigest: config.source === "repo-config" ? digest(config.roots) : null,
    overrideDigest: overrideRoots !== undefined ? digest(overrideRoots) : null,
    analysedSha,
    roots,
    matchedRoots: roots.filter((item) => item.matched).length,
    excludedFiles: files,
    excludedManifests: roots.reduce((total, item) => total + item.manifests, 0),
    countingComplete: true,
    builtInPolicy: "default-v1",
  };
}
