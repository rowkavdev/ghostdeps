/**
 * package-lock.json / npm-shrinkwrap.json (lockfileVersion 1, 2 and 3).
 * The lockfile is data: parsed with JSON.parse, never resolved against a
 * registry. Edges follow Node's node_modules lookup over the recorded tree.
 */
import type { Evidence } from "@ghostdeps/core";
import { own } from "./model.js";
import type { ParsedLockfile, ResolvedPackage } from "./model.js";

interface NpmEntry {
  version?: string;
  name?: string;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  requires?: Record<string, string> | boolean;
}

interface V1Entry {
  version?: string;
  requires?: Record<string, string>;
  dependencies?: Record<string, V1Entry>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function nameFromPath(path: string): string {
  const i = path.lastIndexOf("node_modules/");
  return i < 0 ? path : path.slice(i + "node_modules/".length);
}

function parentDir(path: string): string | undefined {
  // "a/node_modules/b" -> "a"; "node_modules/b" -> ""
  const i = path.lastIndexOf("/node_modules/");
  if (i >= 0) return path.slice(0, i);
  if (path.startsWith("node_modules/")) return "";
  return undefined;
}

/**
 * Parse an npm lockfile for the project at `projectDir` (relative to the
 * lockfile's directory, "" for the lockfile root).
 * `declared` is the manifest's direct dependency set used to report
 * lockfile/manifest mismatches.
 */
export function parseNpmLockfile(
  text: string,
  lockfile: string,
  projectDir: string,
  declared: { name: string; dev: boolean }[],
): ParsedLockfile {
  const evidence: Evidence[] = [];
  const doc: unknown = JSON.parse(text);
  if (!isObject(doc)) throw new Error("lockfile root is not an object");
  const version = doc.lockfileVersion;
  const packages = new Map<string, ResolvedPackage>();

  if (isObject(doc.packages)) {
    const entries = doc.packages as Record<string, unknown>;
    const entry = (key: string): NpmEntry | undefined => {
      const e = own(entries, key);
      return isObject(e) ? (e as NpmEntry) : undefined;
    };
    const lookup = (from: string, dep: string): string | undefined => {
      let dir: string | undefined = from;
      for (;;) {
        const candidate = dir ? `${dir}/node_modules/${dep}` : `node_modules/${dep}`;
        if (entry(candidate)) return follow(candidate);
        if (dir === undefined || dir === "") return undefined;
        const up = parentDir(dir);
        // Workspace dirs ("packages/a") fall back to the root node_modules.
        dir = up === undefined ? "" : up;
      }
    };
    const follow = (key: string, depth = 0): string => {
      const e = entry(key);
      if (e?.link && typeof e.resolved === "string" && depth < 8 && entry(e.resolved)) {
        return follow(e.resolved, depth + 1);
      }
      return key;
    };
    const depsOf = (e: NpmEntry, includeDev: boolean) => [
      ...Object.keys(isObject(e.dependencies) ? e.dependencies : {}),
      ...Object.keys(isObject(e.optionalDependencies) ? e.optionalDependencies : {}),
      ...Object.keys(isObject(e.peerDependencies) ? e.peerDependencies : {}),
      ...(includeDev ? Object.keys(isObject(e.devDependencies) ? e.devDependencies : {}) : []),
    ];
    for (const key of Object.keys(entries)) {
      const e = entry(key);
      if (!e || key === "" || e.link) continue;
      const deps: string[] = [];
      for (const d of new Set(depsOf(e, false))) {
        const id = lookup(key, d);
        if (id !== undefined) deps.push(id);
      }
      packages.set(key, {
        name: typeof e.name === "string" ? e.name : nameFromPath(key),
        version: typeof e.version === "string" ? e.version : "0.0.0",
        dependencies: deps,
      });
    }
    const direct = declared.map((d) => ({
      name: d.name,
      dev: d.dev,
      id: lookup(projectDir, d.name),
    }));
    const root = entry(projectDir);
    if (root) mismatches(root, declared, lockfile, evidence);
    return { packages, direct, evidence };
  }

  if (isObject(doc.dependencies)) {
    // lockfileVersion 1: nested tree; ids are the nesting path.
    const pending = new Map<string, { requires: string[]; scopes: string[] }>();
    const walk = (tree: Record<string, V1Entry>, prefix: string, scopes: string[]) => {
      for (const [name, e] of Object.entries(tree)) {
        if (!isObject(e)) continue;
        const id = `${prefix}node_modules/${name}`;
        const childScopes = [`${id}/`, ...scopes];
        packages.set(id, { name, version: String(e.version ?? "0.0.0"), dependencies: [] });
        pending.set(id, {
          requires: isObject(e.requires) ? Object.keys(e.requires) : [],
          scopes: childScopes,
        });
        if (isObject(e.dependencies))
          walk(e.dependencies as Record<string, V1Entry>, `${id}/`, childScopes);
      }
    };
    walk(doc.dependencies as Record<string, V1Entry>, "", [""]);
    for (const [id, { requires, scopes }] of pending) {
      const pkg = packages.get(id)!;
      for (const r of requires) {
        const hit = scopes.map((s) => `${s}node_modules/${r}`).find((c) => packages.has(c));
        if (hit) pkg.dependencies.push(hit);
      }
    }
    if (projectDir !== "") {
      evidence.push({
        kind: "lockfile-workspace-unsupported",
        statement: `${lockfile} is lockfileVersion 1, which does not record workspace members`,
        file: lockfile,
      });
    }
    const direct = declared.map((d) => ({
      name: d.name,
      dev: d.dev,
      id: packages.has(`node_modules/${d.name}`) ? `node_modules/${d.name}` : undefined,
    }));
    for (const d of direct) {
      if (!d.id) {
        evidence.push({
          kind: "lockfile-manifest-mismatch",
          statement: `${d.name} is declared in the manifest but missing from ${lockfile}`,
          file: lockfile,
        });
      }
    }
    return { packages, direct, evidence };
  }

  evidence.push({
    kind: "lockfile-unsupported",
    statement: `${lockfile} (lockfileVersion ${String(version)}) has neither "packages" nor "dependencies"`,
    file: lockfile,
  });
  return { packages, direct: declared.map((d) => ({ ...d, id: undefined })), evidence };
}

function mismatches(
  root: NpmEntry,
  declared: { name: string; dev: boolean }[],
  lockfile: string,
  evidence: Evidence[],
): void {
  const locked = new Set([
    ...Object.keys(isObject(root.dependencies) ? root.dependencies : {}),
    ...Object.keys(isObject(root.devDependencies) ? root.devDependencies : {}),
    ...Object.keys(isObject(root.optionalDependencies) ? root.optionalDependencies : {}),
  ]);
  const want = new Set(declared.map((d) => d.name));
  for (const n of want) {
    if (!locked.has(n)) {
      evidence.push({
        kind: "lockfile-manifest-mismatch",
        statement: `${n} is declared in the manifest but not in ${lockfile}; the lockfile is stale`,
        file: lockfile,
      });
    }
  }
  for (const n of locked) {
    if (!want.has(n)) {
      evidence.push({
        kind: "lockfile-manifest-mismatch",
        statement: `${lockfile} lists ${n} as a direct dependency but the manifest does not; the lockfile is stale`,
        file: lockfile,
      });
    }
  }
}
