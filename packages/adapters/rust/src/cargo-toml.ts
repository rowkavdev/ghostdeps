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
 * Match a workspace member glob (Cargo uses the `glob` crate: `*`, `?`,
 * `[abc]` / `[a-z]` / `[!..]` classes, `**`) against a directory relative
 * to the workspace root. Anything unsupported (braces, unterminated
 * classes) fails closed (no match) rather than matching too much.
 */
export function matchMemberGlob(pattern: string, dir: string): boolean {
  const pat = normalisePath(pattern);
  if (pat === undefined) return false;
  const pSegs = pat === "." ? [] : pat.split("/");
  const dSegs = dir === "." ? [] : dir.split("/");
  const escape = (c: string) => c.replace(/[.+^$()|\\[\]{}*?-]/g, "\\$&");
  const segmentRegex = (seg: string): RegExp | undefined => {
    if (/[{}]/.test(seg)) return undefined;
    let body = "";
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i]!;
      if (c === "*") body += "[^/]*";
      else if (c === "?") body += "[^/]";
      else if (c === "]") return undefined;
      else if (c === "[") {
        // glob-crate class: optional leading `!`, then chars or a-z ranges;
        // a `]` right after the opener is a literal member.
        let j = i + 1;
        const negate = seg[j] === "!";
        if (negate) j++;
        let cls = "";
        let first = true;
        for (; j < seg.length && (first || seg[j] !== "]"); j++, first = false) {
          if (seg[j + 1] === "-" && j + 2 < seg.length && seg[j + 2] !== "]") {
            if (seg[j]! > seg[j + 2]!) return undefined;
            cls += `${escape(seg[j]!)}-${escape(seg[j + 2]!)}`;
            j += 2;
          } else {
            cls += escape(seg[j]!);
          }
        }
        if (j >= seg.length || cls === "") return undefined; // unterminated
        body += negate ? `[^/${cls}]` : `[${cls}]`;
        i = j;
      } else body += escape(c);
    }
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
    if (isExcluded(workspace, rel)) return undefined;
    if (stringArray(workspace.members).some((m) => matchMemberGlob(m, rel))) return candidate;
    // Not a listed member: it can still join as a path dependency of a
    // member (resolveWorkspaces); otherwise Cargo would error. We stop at
    // the nearest workspace either way.
    return undefined;
  }
  return undefined;
}

function isExcluded(workspace: TomlTable, rel: string): boolean {
  return stringArray(workspace.exclude).some((e) => {
    const ex = normalisePath(e);
    return ex !== undefined && (ex === rel || rel.startsWith(`${ex}/`));
  });
}

/**
 * The nearest ancestor workspace of a crate that does not exclude it,
 * regardless of `members`. Undefined for crates that name their workspace
 * explicitly (`package.workspace`) or are workspace roots themselves.
 */
function nearestWorkspace(
  crate: CargoManifest,
  manifestsByRoot: ReadonlyMap<string, CargoManifest>,
): CargoManifest | undefined {
  if (workspaceTable(crate) !== undefined) return undefined;
  const pkg = crate.document?.package;
  if (isTable(pkg) && pkg.workspace !== undefined) return undefined;
  let dir = crate.root;
  while (dir !== ".") {
    dir = dirOf(dir);
    const candidate = manifestsByRoot.get(dir);
    const workspace = candidate === undefined ? undefined : workspaceTable(candidate);
    if (candidate === undefined || workspace === undefined) continue;
    const rel = relativeTo(candidate.root, crate.root);
    return rel === undefined || isExcluded(workspace, rel) ? undefined : candidate;
  }
  return undefined;
}

const DEPENDENCY_TABLES = [
  "dependencies",
  "dev-dependencies",
  "dev_dependencies",
  "build-dependencies",
  "build_dependencies",
];

/** Repo-relative directories of a manifest's `path` dependencies (all tables, incl. target-specific). */
export function pathDependencyDirs(manifest: CargoManifest): string[] {
  const document = manifest.document;
  if (document === undefined) return [];
  const tables: unknown[] = DEPENDENCY_TABLES.map((t) => document[t]);
  if (isTable(document.target)) {
    for (const spec of Object.values(document.target)) {
      if (isTable(spec)) for (const t of DEPENDENCY_TABLES) tables.push(spec[t]);
    }
  }
  const out: string[] = [];
  for (const table of tables) {
    if (!isTable(table)) continue;
    for (const entry of Object.values(table)) {
      if (!isTable(entry) || typeof entry.path !== "string") continue;
      const dir = normalisePath(joinPath(manifest.root, entry.path));
      if (dir !== undefined) out.push(dir);
    }
  }
  return out;
}

/**
 * Workspace root for every crate manifest, keyed by crate root. Listed
 * members come from findWorkspaceRoot; then, as Cargo does, every path
 * dependency of a member (transitively) that sits under the same
 * workspace and is not excluded becomes a member too (#226).
 */
export function resolveWorkspaces(
  manifests: readonly CargoManifest[],
  manifestsByRoot: ReadonlyMap<string, CargoManifest>,
): Map<string, CargoManifest> {
  const resolved = new Map<string, CargoManifest>();
  const queue: CargoManifest[] = [];
  for (const manifest of manifests) {
    if (!hasPackage(manifest)) continue;
    const ws = findWorkspaceRoot(manifest, manifestsByRoot);
    if (ws === undefined) continue;
    resolved.set(manifest.root, ws);
    queue.push(manifest);
  }
  while (queue.length > 0) {
    const member = queue.shift()!;
    const ws = resolved.get(member.root)!;
    for (const dir of pathDependencyDirs(member)) {
      if (resolved.has(dir)) continue;
      const target = manifestsByRoot.get(dir);
      if (target === undefined || !hasPackage(target)) continue;
      if (nearestWorkspace(target, manifestsByRoot) !== ws) continue;
      resolved.set(dir, ws);
      queue.push(target);
    }
  }
  return resolved;
}
