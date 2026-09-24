/**
 * Lockfile-agnostic graph assembly. Parsers turn a lockfile into resolved
 * package instances plus the project's direct edges; this module computes
 * the shared DependencyGraph (closure per direct dependency, dev/prod split).
 */
import type { DependencyGraph, Evidence, GraphNode, ProjectRef } from "@ghostdeps/core";

/** One resolved package instance, keyed by a parser-specific unique id. */
export interface ResolvedPackage {
  name: string;
  version: string;
  /** Ids of the packages this one depends on (already resolved by the parser). */
  dependencies: string[];
}

/** What a lockfile parser produces for one project. */
export interface ParsedLockfile {
  packages: Map<string, ResolvedPackage>;
  /** Direct dependencies of the project: name -> resolved package id (undefined when missing from the lockfile). */
  direct: { name: string; id: string | undefined; dev: boolean }[];
  evidence: Evidence[];
}

/** Graph plus the evidence gathered while building it (mismatches, unsupported versions). */
export interface LockfileGraphResult {
  graph: DependencyGraph;
  evidence: Evidence[];
  /** Lockfile the graph came from, repository-relative; undefined when none was found. */
  lockfile?: string;
}

/** Iterative DFS closure; safe on cyclic graphs. */
function closure(start: string, packages: Map<string, ResolvedPackage>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of packages.get(id)?.dependencies ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

export function assembleGraph(project: ProjectRef, parsed: ParsedLockfile): DependencyGraph {
  const reachableProd = new Set<string>();
  const reachableAll = new Set<string>();
  const transitiveClosure: Record<string, string[]> = {};
  for (const d of parsed.direct) {
    if (!d.id || !parsed.packages.has(d.id)) {
      transitiveClosure[d.name] = [];
      continue;
    }
    const ids = closure(d.id, parsed.packages);
    for (const id of ids) {
      reachableAll.add(id);
      if (!d.dev) reachableProd.add(id);
    }
    ids.delete(d.id);
    const names = new Set<string>();
    for (const id of ids) names.add(parsed.packages.get(id)!.name);
    names.delete(d.name);
    transitiveClosure[d.name] = [...names].sort();
  }
  const nodes: GraphNode[] = [];
  for (const id of [...reachableAll].sort()) {
    const pkg = parsed.packages.get(id)!;
    const deps = new Set(pkg.dependencies.map((dep) => parsed.packages.get(dep)?.name ?? dep));
    nodes.push({
      name: pkg.name,
      version: pkg.version,
      dependencies: [...deps].sort(),
      dev: !reachableProd.has(id),
    });
  }
  return { project, nodes, transitiveClosure, incomplete: false };
}

export function emptyGraph(project: ProjectRef): DependencyGraph {
  return { project, nodes: [], transitiveClosure: {}, incomplete: true };
}
