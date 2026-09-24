/**
 * Repository-wide project tree (#55). Adapters discover their own projects
 * (ADR 0002, monorepo-native); core relates them across ecosystems by path
 * so a polyglot monorepo reads as one tree. Pure and deterministic: the
 * same project set gives the same tree in any input order.
 */
import type { ProjectNode, ProjectRef } from "../types/index.js";

/** Normalise an adapter path to the "." / "a/b" form (no "./", no trailing "/"). */
function normalisePath(path: string): string {
  const trimmed = path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

/** Deterministic project id: "<ecosystem>:<path>". */
export function projectId(project: Pick<ProjectRef, "ecosystem" | "path">): string {
  return `${project.ecosystem}:${normalisePath(project.path)}`;
}

/** True when `ancestor` is a strict ancestor directory of `path`. */
function isStrictAncestor(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  if (ancestor === ".") return true;
  return path.startsWith(`${ancestor}/`);
}

const depth = (path: string): number => (path === "." ? 0 : path.split("/").length);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Relate projects by path. A project's parent is the nearest enclosing
 * project root of any ecosystem (deepest strict ancestor path); ties at
 * that path go to the lowest ecosystem name. Duplicate projects (same
 * ecosystem and path) collapse to one node. Sorted by path, then ecosystem.
 */
export function buildProjectTree(projects: readonly ProjectRef[]): ProjectNode[] {
  const unique = new Map<string, { path: string; ecosystem: string }>();
  for (const project of projects) {
    const path = normalisePath(project.path);
    unique.set(projectId({ ecosystem: project.ecosystem, path }), {
      path,
      ecosystem: project.ecosystem,
    });
  }
  const nodes = [...unique.values()].sort(
    (a, b) => compare(a.path, b.path) || compare(a.ecosystem, b.ecosystem),
  );
  return nodes.map((node) => {
    let best: { path: string; ecosystem: string } | undefined;
    for (const candidate of nodes) {
      if (!isStrictAncestor(candidate.path, node.path)) continue;
      if (
        best === undefined ||
        depth(candidate.path) > depth(best.path) ||
        (depth(candidate.path) === depth(best.path) &&
          compare(candidate.ecosystem, best.ecosystem) < 0)
      ) {
        best = candidate;
      }
    }
    const out: ProjectNode = { id: projectId(node), path: node.path, ecosystem: node.ecosystem };
    if (best !== undefined) out.parent = projectId(best);
    return out;
  });
}
