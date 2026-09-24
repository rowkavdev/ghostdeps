/**
 * go.mod to the shared Dependency model and graph (#52).
 *
 * - Direct dependencies are the requires without `// indirect`.
 * - `replace` never renames a dependency (imports keep the required path);
 *   the target is recorded as a specifier: a local directory is "file",
 *   another module is "registry" with the target in `detail`.
 * - `exclude` only removes versions from selection, so it drops nothing.
 * - The graph holds every required module (plus vendor/modules.txt entries)
 *   as a node with no edges, and is always incomplete: edges come from
 *   `go mod graph`, which is never run.
 */
import type {
  Dependency,
  DependencyGraph,
  GraphNode,
  ProjectRef,
  RepositoryHandle,
} from "@ghostdeps/core";
import { parseGoMod, type GoModFile, type GoModReplace, type GoModRequire } from "./gomod.js";
import { joinPath } from "./detect.js";

export async function readGoMod(
  repository: RepositoryHandle,
  project: ProjectRef,
): Promise<GoModFile | undefined> {
  try {
    return parseGoMod(await repository.readFile(joinPath(project.path, "go.mod")));
  } catch {
    return undefined;
  }
}

/** The replace that applies to a require: an exact-version match wins over a version-less one. */
export function replacementFor(mod: GoModFile, req: GoModRequire): GoModReplace | undefined {
  const matches = mod.replace.filter((r) => r.old.path === req.path);
  return (
    matches.find((r) => r.old.version === req.version) ??
    matches.find((r) => r.old.version === undefined)
  );
}

export function directDependencies(mod: GoModFile, project: ProjectRef): Dependency[] {
  const declaredIn = joinPath(project.path, "go.mod");
  return mod.require
    .filter((r) => !r.indirect)
    .map((r) => {
      const rep = replacementFor(mod, r);
      const specifier: Dependency["specifier"] = rep
        ? rep.local
          ? { type: "file", detail: rep.new.path }
          : { type: "registry", detail: `${rep.new.path} ${rep.new.version ?? ""}`.trim() }
        : undefined;
      return {
        name: r.path,
        constraint: r.version,
        kind: "runtime" as const,
        project,
        declaredIn,
        ...(specifier ? { specifier } : {}),
      };
    });
}

/** Module lines of vendor/modules.txt: "# path version [=> replacement]". */
export function parseVendorModules(text: string): { path: string; version: string }[] {
  const out: { path: string; version: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^# (\S+) (\S+)/.exec(line.trim());
    if (m && m[1] !== "=>") out.push({ path: m[1]!, version: m[2]! });
  }
  return out;
}

export async function moduleGraph(
  repository: RepositoryHandle,
  project: ProjectRef,
  mod: GoModFile,
): Promise<DependencyGraph> {
  const nodes = new Map<string, GraphNode>();
  for (const r of mod.require) {
    nodes.set(r.path, { name: r.path, version: r.version, dependencies: [], dev: false });
  }
  try {
    const vendor = await repository.readFile(joinPath(project.path, "vendor/modules.txt"));
    for (const v of parseVendorModules(vendor)) {
      if (!nodes.has(v.path)) {
        nodes.set(v.path, { name: v.path, version: v.version, dependencies: [], dev: false });
      }
    }
  } catch {
    // No vendor directory: go.mod alone.
  }
  return {
    project,
    nodes: [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    transitiveClosure: {},
    incomplete: true,
  };
}
