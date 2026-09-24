import type {
  Dependency,
  DependencyGraph,
  DependencyImpact,
  Finding,
  GraphCompleteness,
} from "../types/index.js";

/**
 * Work budget for impact (#59): the summed closure lengths the engine will
 * walk in one run. A project whose closures don't fit gets `null` counts
 * and `limited: true`, plus one run note.
 */
export const MAX_IMPACT_CLOSURE_ENTRIES = 2_000_000;

/** Case and separator-insensitive name, only for the node-presence check. */
const looseName = (name: string): string =>
  typeof name === "string" ? name.toLowerCase().replace(/[-_.]+/g, "-") : "";

const projectKey = (ecosystem: string, path: string): string => `${ecosystem}\0${path}`;

/**
 * Per direct dependency, how much of the lockfile graph it brings in (#59).
 * Lockfile graphs only (ADR 0004): no graph means unknown (`null`), a
 * partial graph gives a lower-bound `transitive` and no `exclusive`.
 * Projects are processed in a stable order so the budget cut is
 * deterministic.
 */
export function computeImpact(
  graphs: readonly DependencyGraph[],
  dependencies: readonly Dependency[],
  budget: number = MAX_IMPACT_CLOSURE_ENTRIES,
): { impact: DependencyImpact[]; limitedProjects: number; limitedDependencies: number } {
  const graphsByProject = new Map<string, DependencyGraph[]>();
  for (const graph of graphs) {
    const key = projectKey(graph.project.ecosystem, graph.project.path);
    const list = graphsByProject.get(key);
    if (list) list.push(graph);
    else graphsByProject.set(key, [graph]);
  }
  const depsByProject = new Map<string, Dependency[]>();
  for (const dep of dependencies) {
    const key = projectKey(dep.project.ecosystem, dep.project.path);
    const list = depsByProject.get(key);
    if (list) list.push(dep);
    else depsByProject.set(key, [dep]);
  }

  const impact: DependencyImpact[] = [];
  let used = 0;
  let limitedProjects = 0;
  let limitedDependencies = 0;
  for (const key of [...depsByProject.keys()].sort()) {
    const deps = depsByProject.get(key)!;
    const projectGraphs = graphsByProject.get(key) ?? [];
    const usable = projectGraphs.filter((g) => !(g.incomplete && g.nodes.length === 0));
    const completeness: GraphCompleteness =
      usable.length === 0
        ? "none"
        : projectGraphs.some((g) => g.incomplete)
          ? "partial"
          : "complete";
    // One row per name per project, even when it is declared in several
    // sections (e.g. dependencies and devDependencies).
    const unique = [...new Map(deps.map((d) => [d.name, d] as const)).values()];
    const names = unique.map((d) => d.name);
    const base = (dep: Dependency) => ({
      ecosystem: dep.project.ecosystem,
      project: dep.project.path,
      name: dep.name,
      graph: completeness,
    });

    if (completeness === "none") {
      for (const dep of unique) impact.push({ ...base(dep), transitive: null, exclusive: null });
      continue;
    }

    // Budget check before walking anything for this project.
    let size = 0;
    for (const graph of usable) {
      for (const name of names) {
        const closure = Object.hasOwn(graph.transitiveClosure, name)
          ? graph.transitiveClosure[name]
          : undefined;
        if (Array.isArray(closure)) size += closure.length;
      }
    }
    if (used + size > budget) {
      limitedProjects++;
      limitedDependencies += unique.length;
      for (const dep of unique) {
        impact.push({ ...base(dep), transitive: null, exclusive: null, limited: true });
      }
      continue;
    }
    used += size;

    const closures = new Map<string, Set<string> | undefined>();
    for (const name of names) {
      let set: Set<string> | undefined;
      for (const graph of usable) {
        const closure = Object.hasOwn(graph.transitiveClosure, name)
          ? graph.transitiveClosure[name]
          : undefined;
        if (!Array.isArray(closure)) continue;
        set ??= new Set();
        for (const member of closure)
          if (typeof member === "string" && member !== name) set.add(member);
      }
      closures.set(name, set);
    }
    // Exclusivity needs the closure of every direct dependency that is in
    // the installed tree: one missing entry (e.g. PyYAML declared, pyyaml in
    // the lockfile) would make shared packages look exclusive, so the whole
    // project gets `exclusive: null`. A direct dependency that is not a
    // graph node at all (e.g. a Python build backend, never locked) installs
    // nothing here and doesn't block it. Nodes are matched by a loose name
    // (case and runs of - _ . folded) so a spelling mismatch still counts.
    const nodeNames = new Set(usable.flatMap((g) => g.nodes.map((n) => looseName(n.name))));
    const allClosures = [...closures.entries()].every(
      ([name, set]) => set !== undefined || !nodeNames.has(looseName(name)),
    );
    const direct = new Set(names);
    const reach = new Map<string, number>();
    for (const set of closures.values()) {
      for (const member of set ?? []) reach.set(member, (reach.get(member) ?? 0) + 1);
    }
    for (const dep of unique) {
      const set = closures.get(dep.name);
      if (set === undefined) {
        impact.push({ ...base(dep), transitive: null, exclusive: null });
        continue;
      }
      let exclusive: number | null = null;
      if (completeness === "complete" && allClosures) {
        exclusive = 0;
        for (const member of set) if (reach.get(member) === 1 && !direct.has(member)) exclusive++;
      }
      impact.push({ ...base(dep), transitive: set.size, exclusive });
    }
  }
  return { impact, limitedProjects, limitedDependencies };
}

/**
 * The one run note when the impact budget ran out (#59). Marked
 * `adapterNote` so findingGroup reads it as "note": visible, non-capping,
 * the check stays success. No coverage was lost; an optional analytics
 * block hit its budget (lead ruling on #59).
 */
export function impactLimitedNote(limitedProjects: number, limitedDependencies: number): Finding {
  return {
    kind: "info",
    rule: "impact-limited",
    summary: `transitive impact not computed for ${limitedDependencies} dependenc${limitedDependencies === 1 ? "y" : "ies"} in ${limitedProjects} project(s): work limit reached`,
    recommendation: "For information; no verdict is affected.",
    evidence: [
      {
        kind: "impact-limited",
        statement: `impact work budget of ${MAX_IMPACT_CLOSURE_ENTRIES} closure entries reached; those entries have limited: true and null counts`,
      },
    ],
    confidence: "high",
    adapterNote: true,
    limitations: [],
    affectedFiles: [],
  };
}
