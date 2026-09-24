/**
 * Repository-wide dependency graph (#55). Merges every project's lockfile
 * graph into one package index keyed by ecosystem + name + version, and
 * records which projects reach each package. Runs after the policy, on data
 * the policy already saw in full: the emission cap trims the output only,
 * so it never changes a verdict.
 */
import { MAX_EMITTED_GRAPH_NODES } from "../limits.js";
import type {
  Dependency,
  DependencyGraph,
  SurfaceEntry,
  UnifiedGraph,
  UnifiedGraphNode,
} from "../types/index.js";
import { projectId } from "./project-tree.js";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Accumulator {
  ecosystem: string;
  name: string;
  version: string;
  dependencies: Set<string>;
  dev: boolean;
  projects: Set<string>;
  directIn: Set<string>;
}

/** Build the unified graph and, when the output was capped, one info note. */
export function buildUnifiedGraph(
  graphs: readonly DependencyGraph[],
  dependencies: readonly Dependency[],
  surface: readonly SurfaceEntry[],
  maxNodes: number = MAX_EMITTED_GRAPH_NODES,
): UnifiedGraph {
  // Direct declarations by project id, matched to graph nodes by name.
  const declared = new Map<string, Set<string>>();
  for (const dep of dependencies) {
    const id = projectId(dep.project);
    if (!declared.has(id)) declared.set(id, new Set());
    declared.get(id)!.add(dep.name);
  }

  const all = new Map<string, Accumulator>();
  for (const graph of graphs) {
    const ecosystem = graph.project.ecosystem;
    const owner = projectId(graph.project);
    const direct = declared.get(owner);
    for (const node of graph.nodes) {
      const id = `${ecosystem}:${node.name}@${node.version}`;
      let acc = all.get(id);
      if (acc === undefined) {
        acc = {
          ecosystem,
          name: node.name,
          version: node.version,
          dependencies: new Set(),
          dev: true,
          projects: new Set(),
          directIn: new Set(),
        };
        all.set(id, acc);
      }
      for (const d of node.dependencies) acc.dependencies.add(d);
      acc.dev &&= node.dev;
      acc.projects.add(owner);
      if (direct?.has(node.name)) acc.directIn.add(owner);
    }
  }

  // Emission priority: directly declared packages first, then the rest,
  // each in id order, so a capped graph keeps what users look at first.
  const ids = [...all.keys()].sort((a, b) => {
    const da = all.get(a)!.directIn.size > 0 ? 0 : 1;
    const db = all.get(b)!.directIn.size > 0 ? 0 : 1;
    return da - db || compare(a, b);
  });
  const limit = Math.max(0, Math.floor(maxNodes));
  const kept = ids.slice(0, limit).sort(compare);
  const truncated = kept.length < ids.length;

  const nodes: UnifiedGraphNode[] = kept.map((id) => {
    const acc = all.get(id)!;
    return {
      id,
      ecosystem: acc.ecosystem,
      name: acc.name,
      version: acc.version,
      dependencies: [...acc.dependencies].sort(compare),
      dev: acc.dev,
      projects: [...acc.projects].sort(compare),
      directIn: [...acc.directIn].sort(compare),
    };
  });

  const total = new Map<string, number>();
  const emitted = new Map<string, number>();
  for (const acc of all.values()) total.set(acc.ecosystem, (total.get(acc.ecosystem) ?? 0) + 1);
  for (const node of nodes) emitted.set(node.ecosystem, (emitted.get(node.ecosystem) ?? 0) + 1);
  const ecosystems = surface
    .map((entry) => ({
      ecosystem: entry.ecosystem,
      graphs: entry.graphs ?? "none",
      nodes: total.get(entry.ecosystem) ?? 0,
      emitted: emitted.get(entry.ecosystem) ?? 0,
    }))
    .sort((a, b) => compare(a.ecosystem, b.ecosystem));

  // No Finding when capped: a note would be a run note and would mark a
  // completed analysis as incomplete (#197). graph.truncated and the
  // per-ecosystem nodes/emitted counts carry the cap instead.
  return { nodes, ecosystems, truncated };
}
