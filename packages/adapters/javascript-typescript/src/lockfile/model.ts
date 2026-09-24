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
  /** GraphNode.registryOrigin (#174 step 3); set only from explicit evidence (see origin.ts). */
  registryOrigin?: string;
}

/** What a lockfile parser produces for one project. */
export interface ParsedLockfile {
  packages: Map<string, ResolvedPackage>;
  /** Direct dependencies of the project: name -> resolved package id (undefined when missing from the lockfile). */
  direct: { name: string; id: string | undefined; dev: boolean }[];
  evidence: Evidence[];
}

/**
 * A lockfile parsed once per analysis run and shared by every importer
 * (workspace project) that uses it. Deep-frozen by the loader cache, so
 * per-importer extraction must treat it as read-only.
 */
export interface LoadedLockfile {
  readonly doc: unknown;
}

/** Graph plus the evidence gathered while building it (mismatches, unsupported versions). */
export interface LockfileGraphResult {
  graph: DependencyGraph;
  evidence: Evidence[];
  /** Lockfile the graph came from, repository-relative; undefined when none was found. */
  lockfile?: string;
}

/**
 * Upper bound on node visits across all closure walks for one graph. Real
 * lockfiles stay far below it (closures are memoised per resolved package);
 * adversarial shapes (thousands of direct deps into a long chain) hit it and
 * produce an incomplete graph with evidence instead of pinning a worker.
 */
export const MAX_CLOSURE_VISITS = 5_000_000;

/** Own-property read on untrusted parsed data; never falls through to Object.prototype. */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Define an own enumerable property, safe for keys like "__proto__". */
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

class BudgetExceeded extends Error {}

export function assembleGraph(
  project: ProjectRef,
  parsed: ParsedLockfile,
  maxVisits = MAX_CLOSURE_VISITS,
): { graph: DependencyGraph; evidence: Evidence[] } {
  let visits = 0;
  // Closure per resolved start id, memoised so repeated direct deps cost nothing.
  const memo = new Map<string, Set<string>>();
  const closure = (start: string): Set<string> => {
    const cached = memo.get(start);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      if (++visits > maxVisits) throw new BudgetExceeded();
      seen.add(id);
      for (const next of parsed.packages.get(id)?.dependencies ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    memo.set(start, seen);
    return seen;
  };

  const reachableProd = new Set<string>();
  const reachableAll = new Set<string>();
  const transitiveClosure: Record<string, string[]> = {};
  try {
    for (const d of parsed.direct) {
      if (!d.id || !parsed.packages.has(d.id)) {
        setOwn(transitiveClosure, d.name, []);
        continue;
      }
      const ids = closure(d.id);
      const names = new Set<string>();
      for (const id of ids) {
        reachableAll.add(id);
        if (!d.dev) reachableProd.add(id);
        if (id !== d.id) names.add(parsed.packages.get(id)!.name);
        if (++visits > maxVisits) throw new BudgetExceeded();
      }
      names.delete(d.name);
      setOwn(transitiveClosure, d.name, [...names].sort());
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    return {
      graph: { project, nodes: [], transitiveClosure: {}, incomplete: true },
      evidence: [
        {
          kind: "graph-budget-exceeded",
          statement: `dependency graph exceeded ${maxVisits} node visits; transitive graph not computed`,
        },
      ],
    };
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
      ...(pkg.registryOrigin === undefined ? {} : { registryOrigin: pkg.registryOrigin }),
    });
  }
  return { graph: { project, nodes, transitiveClosure, incomplete: false }, evidence: [] };
}

export function emptyGraph(project: ProjectRef): DependencyGraph {
  return { project, nodes: [], transitiveClosure: {}, incomplete: true };
}
