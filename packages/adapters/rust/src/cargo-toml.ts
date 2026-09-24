/**
 * Cargo.toml reading and workspace resolution (issue #49). Manifests are
 * untrusted input (security-model rule 3): TOML errors and wrong-typed
 * fields become evidence, never exceptions. Nothing is built or executed;
 * build.rs is data like any other file.
 */
import { parse } from "smol-toml";
import type { Evidence, RepositoryHandle } from "@ghostdeps/core";
import { dirOf, joinPath, normalisePath } from "./paths.js";

export const RUST_ECOSYSTEM = "rust";
export const MANIFEST = "Cargo.toml";
export const LOCKFILE = "Cargo.lock";

export type TomlTable = Record<string, unknown>;

export function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface CargoManifest {
  /** Repo-relative path of the Cargo.toml. */
  path: string;
  /** Directory holding it ("." for the repository root). */
  root: string;
  /** Parsed document, or undefined when unreadable/malformed. */
  document: TomlTable | undefined;
  /** Why it could not be used, when document is undefined. */
  error?: Evidence;
}

export async function readManifest(
  repository: RepositoryHandle,
  path: string,
): Promise<CargoManifest> {
  const root = dirOf(path);
  let text: string;
  try {
    text = await repository.readFile(path);
  } catch {
    return {
      path,
      root,
      document: undefined,
      error: { kind: "manifest-unreadable", statement: `${path} could not be read`, file: path },
    };
  }
  try {
    const document = parse(text) as TomlTable;
    return { path, root, document };
  } catch (error) {
    const line =
      typeof error === "object" && error !== null && "line" in error
        ? Number((error as { line: unknown }).line)
        : undefined;
    return {
      path,
      root,
      document: undefined,
      error: {
        kind: "manifest-malformed",
        statement: `${path} is not valid TOML; degrading confidence instead of failing`,
        file: path,
        ...(line !== undefined && Number.isInteger(line) && line > 0 ? { line } : {}),
      },
    };
  }
}

/** A [package] section makes a manifest a crate; [workspace] makes it a workspace root. */
export function hasPackage(manifest: CargoManifest): boolean {
  return isTable(manifest.document?.package);
}

export function workspaceTable(manifest: CargoManifest): TomlTable | undefined {
  const workspace = manifest.document?.workspace;
  return isTable(workspace) ? workspace : undefined;
}

/**
 * Match a workspace member glob (Cargo uses glob syntax: `*`, `?`, `[..]`,
 * `**`) against a directory relative to the workspace root. Character
 * classes are treated literally-safe: anything unsupported fails closed
 * (no match) rather than matching too much.
 */
export function matchMemberGlob(pattern: string, dir: string): boolean {
  const pat = normalisePath(pattern);
  if (pat === undefined) return false;
  const pSegs = pat === "." ? [] : pat.split("/");
  const dSegs = dir === "." ? [] : dir.split("/");
  const segmentRegex = (seg: string): RegExp | undefined => {
    if (/[[\]{}]/.test(seg)) return undefined;
    const body = seg
      .split("")
      .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^$()|\\]/g, "\\$&")))
      .join("");
    return new RegExp(`^${body}$`);
  };
  const walk = (pi: number, di: number): boolean => {
    if (pi === pSegs.length) return di === dSegs.length;
    const seg = pSegs[pi]!;
    if (seg === "**") {
      for (let k = di; k <= dSegs.length; k++) if (walk(pi + 1, k)) return true;
      return false;
    }
    if (di === dSegs.length) return false;
    const re = segmentRegex(seg);
    if (re === undefined) return false;
    return re.test(dSegs[di]!) && walk(pi + 1, di + 1);
  };
  return walk(0, 0);
}

/** Directory of `dir` relative to workspace root `root`, or undefined if outside it. */
function relativeTo(root: string, dir: string): string | undefined {
  if (root === ".") return dir;
  if (dir === root) return ".";
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : undefined;
}

/**
 * The workspace a crate belongs to: an explicit `package.workspace` path
 * wins; otherwise the nearest ancestor manifest with [workspace] whose
 * members include this crate and whose `exclude` does not. The root
 * manifest of a workspace with [package] is its own member.
 */
export function findWorkspaceRoot(
  crate: CargoManifest,
  manifestsByRoot: ReadonlyMap<string, CargoManifest>,
): CargoManifest | undefined {
  if (workspaceTable(crate) !== undefined) return crate;
  const pkg = crate.document?.package;
  if (isTable(pkg) && typeof pkg.workspace === "string") {
    const target = normalisePath(joinPath(crate.root, pkg.workspace));
    const found = target === undefined ? undefined : manifestsByRoot.get(target);
    return found !== undefined && workspaceTable(found) !== undefined ? found : undefined;
  }
  let dir = crate.root;
  while (dir !== ".") {
    dir = dirOf(dir);
    const candidate = manifestsByRoot.get(dir);
    const workspace = candidate === undefined ? undefined : workspaceTable(candidate);
    if (candidate === undefined || workspace === undefined) continue;
    const rel = relativeTo(candidate.root, crate.root);
    if (rel === undefined) continue;
    const excluded = stringArray(workspace.exclude).some(
      (e) => normalisePath(e) === rel || rel.startsWith(`${normalisePath(e)}/`),
    );
    if (excluded) return undefined;
    if (stringArray(workspace.members).some((m) => matchMemberGlob(m, rel))) return candidate;
    // Cargo errors when a crate sits under a workspace without being a
    // member; we stop at the nearest workspace either way.
    return undefined;
  }
  return undefined;
}
