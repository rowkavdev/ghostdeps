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

/** Parent directory in the "." / "a/b" form; undefined for ".". */
function parentDir(path: string): string | undefined {
  if (path === ".") return undefined;
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Relate projects by path. A project's parent is the nearest enclosing
 * project root of any ecosystem (deepest strict ancestor path); ties at
 * that path go to the lowest ecosystem name. Duplicate projects (same
 * ecosystem and path) collapse to one node. Sorted by path, then ecosystem.
 * O(n x path depth): each project walks up its own ancestor directories.
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
  // Lowest ecosystem name at each path: nodes are sorted, so the first wins.
  const firstAt = new Map<string, string>();
  for (const node of nodes) if (!firstAt.has(node.path)) firstAt.set(node.path, node.ecosystem);

  return nodes.map((node) => {
    const out: ProjectNode = { id: projectId(node), path: node.path, ecosystem: node.ecosystem };
    for (let dir = parentDir(node.path); dir !== undefined; dir = parentDir(dir)) {
      const ecosystem = firstAt.get(dir);
      if (ecosystem !== undefined) {
        out.parent = projectId({ ecosystem, path: dir });
        break;
      }
    }
    return out;
  });
}
