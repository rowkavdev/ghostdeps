/**
 * Cargo.lock -> DependencyGraph (issue #50). Lockfile only (ADR 0004): no
 * lockfile, an oversized one or one that does not parse gives an
 * incomplete graph, never resolution.
 *
 * Cargo.lock does not record dependency kinds, so `dev` is derived: a
 * package is dev when it is reachable only through the crate's direct
 * dev-dependencies (build-dependencies count as non-dev: they run at build
 * time).
 */
import { parse } from "smol-toml";
import {
  MAX_LOCKFILE_BYTES,
  type AdapterContext,
  type DependencyGraph,
  type Evidence,
  type GraphNode,
  type ProjectRef,
} from "@ghostdeps/core";
import { isTable, stringArray } from "./cargo-toml.js";
import type { Crate } from "./discover.js";
import { discoverCrates } from "./discover.js";
import { parseCargoManifest } from "./manifest.js";
import { compareStrings } from "./paths.js";

export interface LockedPackage {
  name: string;
  version: string;
  /** Absent for workspace members and path dependencies. */
  source?: string;
  /** Raw dependency references: "name", "name version" or "name version (source)". */
  dependencies: string[];
}

export interface ParsedCargoLock {
  version?: number;
  packages: LockedPackage[];
}

/** Parse Cargo.lock text. Throws on invalid TOML; callers turn that into evidence. */
export function parseCargoLock(text: string): ParsedCargoLock {
  const document = parse(text) as Record<string, unknown>;
  const packages: LockedPackage[] = [];
  const raw = Array.isArray(document.package) ? document.package : [];
  for (const entry of raw) {
    if (!isTable(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") {
      continue;
    }
    const locked: LockedPackage = {
      name: entry.name,
      version: entry.version,
      dependencies: stringArray(entry.dependencies),
    };
    if (typeof entry.source === "string") locked.source = entry.source;
    packages.push(locked);
  }
  const result: ParsedCargoLock = { packages };
  if (typeof document.version === "number") result.version = document.version;
  return result;
}

const key = (p: LockedPackage): string => `${p.name}@${p.version}${p.source ? ` ${p.source}` : ""}`;

/** Resolve one dependency reference to a locked package. Ambiguous references resolve to undefined. */
function resolveReference(
  ref: string,
  byName: ReadonlyMap<string, LockedPackage[]>,
): LockedPackage | undefined {
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+\((.+)\))?$/.exec(ref.trim());
  if (!match) return undefined;
  const [, name, version, source] = match;
  const candidates = (byName.get(name!) ?? []).filter(
    (p) =>
      (version === undefined || p.version === version) &&
      (source === undefined || p.source === source),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface CrateGraphResult {
  graph: DependencyGraph;
  evidence: Evidence[];
}

/** Build one crate's graph from a parsed lockfile. `devOnlyDirect` names direct deps declared only as dev. */
export function crateGraph(
  project: ProjectRef,
  crateName: string,
  lock: ParsedCargoLock,
  devOnlyDirect: ReadonlySet<string>,
  lockPath: string,
  declared: ReadonlySet<string> = new Set(),
): CrateGraphResult {
  const evidence: Evidence[] = [];
  const byName = new Map<string, LockedPackage[]>();
  for (const p of lock.packages) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name)!.push(p);
  }
  // The crate itself: a sourceless (local) package with its name.
  const roots = (byName.get(crateName) ?? []).filter((p) => p.source === undefined);
  if (roots.length !== 1) {
    evidence.push({
      kind: "lockfile-missing-root",
      statement: `${lockPath} has no single entry for crate ${crateName}; graph is incomplete`,
      file: lockPath,
    });
    return { graph: { project, nodes: [], transitiveClosure: {}, incomplete: true }, evidence };
  }
  const root = roots[0]!;
  let unresolved = 0;
  const edges = new Map<string, LockedPackage[]>();
  const edgesOf = (p: LockedPackage): LockedPackage[] => {
    const k = key(p);
    let out = edges.get(k);
    if (out === undefined) {
      out = [];
      for (const ref of p.dependencies) {
        const target = resolveReference(ref, byName);
        if (target === undefined) unresolved++;
        else out.push(target);
      }
      edges.set(k, out);
    }
    return out;
  };

  const closureOf = (start: LockedPackage): Map<string, LockedPackage> => {
    const seen = new Map<string, LockedPackage>();
    const stack = [start];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const k = key(next);
      if (seen.has(k)) continue;
      seen.set(k, next);
      stack.push(...edgesOf(next));
    }
    return seen;
  };

  const direct = edgesOf(root);
  const transitiveClosure: Record<string, string[]> = {};
  const nonDev = new Set<string>();
  const all = new Map<string, LockedPackage>();
  for (const dep of direct) {
    const closure = closureOf(dep);
    transitiveClosure[dep.name] = [...new Set([...closure.values()].map((p) => p.name))]
      .filter((n) => n !== dep.name)
      .sort(compareStrings);
    for (const [k, p] of closure) {
      all.set(k, p);
      if (!devOnlyDirect.has(dep.name)) nonDev.add(k);
    }
  }
  const nodes: GraphNode[] = [...all.entries()]
    .map(([k, p]) => ({
      name: p.name,
      version: p.version,
      dependencies: [...new Set(edgesOf(p).map((d) => d.name))].sort(compareStrings),
      dev: !nonDev.has(k),
    }))
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.version, b.version));
  // A lockfile behind Cargo.toml can silently miss a declared dependency:
  // every declared (package) name must be a direct edge of the crate.
  const locked = new Set(direct.map((d) => d.name));
  const missing = [...declared].filter((name) => !locked.has(name)).sort(compareStrings);
  if (missing.length > 0) {
    evidence.push({
      kind: "lockfile-stale",
      statement: `${lockPath} does not lock ${missing.join(", ")} declared by ${crateName}; graph is incomplete`,
      file: lockPath,
    });
  }
  if (unresolved > 0) {
    evidence.push({
      kind: "lockfile-unresolved-reference",
      statement: `${unresolved} dependency reference${unresolved === 1 ? "" : "s"} in ${lockPath} could not be matched to a single package; graph is incomplete`,
      file: lockPath,
    });
  }
  return {
    graph: { project, nodes, transitiveClosure, incomplete: unresolved > 0 || missing.length > 0 },
    evidence,
  };
}

function declaredNames(crate: Crate): { devOnly: Set<string>; all: Set<string> } {
  const deps = parseCargoManifest(crate.manifest, crate.project, crate.workspaceRoot).dependencies;
  const nonDev = new Set(deps.filter((d) => d.kind !== "dev").map((d) => d.name));
  return {
    devOnly: new Set(
      deps.filter((d) => d.kind === "dev" && !nonDev.has(d.name)).map((d) => d.name),
    ),
    all: new Set(deps.map((d) => d.name)),
  };
}

function crateName(crate: Crate): string | undefined {
  const pkg = crate.manifest.document?.package;
  return isTable(pkg) && typeof pkg.name === "string" ? pkg.name : undefined;
}

/**
 * Parsed lockfiles per analysis run (#246): detect() and
 * buildDependencyGraph() both need them, and the engine passes the same
 * AdapterContext to every stage of one run, so each Cargo.lock is read and
 * parsed once. Keyed weakly, so nothing outlives the run.
 */
const lockCaches = new WeakMap<AdapterContext, Map<string, ParsedCargoLock | Evidence>>();

function lockCache(context: AdapterContext): Map<string, ParsedCargoLock | Evidence> {
  let cache = lockCaches.get(context);
  if (cache === undefined) {
    cache = new Map();
    lockCaches.set(context, cache);
  }
  return cache;
}

export interface LockAnalysis {
  graphs: DependencyGraph[];
  /** Why graphs are incomplete: missing, oversized, malformed, stale or ambiguous lockfiles. */
  evidence: Evidence[];
}

/** Graphs plus the evidence behind every incomplete one. */
export async function analyseCargoLocks(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<LockAnalysis> {
  const { crates } = await discoverCrates(context);
  const locks = lockCache(context);
  const graphs: DependencyGraph[] = [];
  const evidence: Evidence[] = [];
  const reported = new Set<string>();
  const once = (e: Evidence) => {
    const k = `${e.kind}\0${e.statement}`;
    if (!reported.has(k)) {
      reported.add(k);
      evidence.push(e);
    }
  };
  for (const project of projects) {
    context.signal?.throwIfAborted();
    const crate = crates.find((c) => c.project.path === project.path);
    const name = crate === undefined ? undefined : crateName(crate);
    const incomplete: DependencyGraph = {
      project,
      nodes: [],
      transitiveClosure: {},
      incomplete: true,
    };
    if (crate === undefined || name === undefined) {
      graphs.push(incomplete);
      continue;
    }
    if (crate.lockfile === undefined) {
      once({
        kind: "lockfile-missing",
        statement: `no Cargo.lock governs ${crate.manifest.path}; graph is incomplete`,
        file: crate.manifest.path,
      });
      graphs.push(incomplete);
      continue;
    }
    const lockPath = crate.lockfile;
    if (!locks.has(lockPath)) {
      let result: ParsedCargoLock | Evidence;
      try {
        const text = await context.repository.readFile(lockPath);
        result =
          Buffer.byteLength(text, "utf8") > MAX_LOCKFILE_BYTES
            ? {
                kind: "lockfile-oversized",
                statement: `${lockPath} exceeds ${MAX_LOCKFILE_BYTES} bytes and was not parsed`,
                file: lockPath,
              }
            : parseCargoLock(text);
      } catch {
        result = {
          kind: "lockfile-malformed",
          statement: `${lockPath} could not be read as TOML; graph is incomplete`,
          file: lockPath,
        };
      }
      locks.set(lockPath, result);
    }
    const lock = locks.get(lockPath)!;
    if (!("packages" in lock)) {
      once(lock);
      graphs.push(incomplete);
      continue;
    }
    const names = declaredNames(crate);
    const result = crateGraph(project, name, lock, names.devOnly, lockPath, names.all);
    result.evidence.forEach(once);
    graphs.push(result.graph);
  }
  return { graphs, evidence };
}

/** EcosystemAdapter.buildDependencyGraph: one graph per requested project. */
export async function buildDependencyGraph(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<DependencyGraph[]> {
  return (await analyseCargoLocks(context, projects)).graphs;
}
