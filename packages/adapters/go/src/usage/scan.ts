/**
 * findUsage for Go (#53): which source files import packages of a module.
 *
 * - An import belongs to the required module with the longest matching
 *   path (github.com/a/b/sub/pkg -> github.com/a/b/sub over github.com/a/b).
 * - A file belongs to the nearest enclosing go.mod; files of other modules,
 *   vendor/, testdata/ and "."/"_" directories are skipped.
 * - `tool` directives reference their module from go.mod (via "config").
 * - Blank and dot imports count as usage with no symbols.
 */
import type {
  AdapterContext,
  Dependency,
  ProjectRef,
  RepositoryHandle,
  Usage,
} from "@ghostdeps/core";
import { dirOf, isIgnoredGoPath, joinPath } from "../detect.js";
import { readGoMod } from "../manifest.js";
import { defaultPackageName, extractGoImports, type GoFileImports } from "./imports.js";

/** Longest module path that owns `importPath`, among `modules`. */
export function owningModule(importPath: string, modules: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const m of modules) {
    if ((importPath === m || importPath.startsWith(`${m}/`)) && (!best || m.length > best.length)) {
      best = m;
    }
  }
  return best;
}

interface ProjectScan {
  files: { path: string; parsed: GoFileImports }[];
  modules: Set<string>;
  tools: { path: string; line: number }[];
}

const cache = new WeakMap<RepositoryHandle, Map<string, Promise<ProjectScan>>>();

async function scanProject(context: AdapterContext, project: ProjectRef): Promise<ProjectScan> {
  const repo = context.repository;
  let perRepo = cache.get(repo);
  if (!perRepo) cache.set(repo, (perRepo = new Map()));
  let scan = perRepo.get(project.path);
  if (!scan) {
    scan = doScan(context, project);
    perRepo.set(project.path, scan);
  }
  return scan;
}

async function doScan(context: AdapterContext, project: ProjectRef): Promise<ProjectScan> {
  const repo = context.repository;
  const all = await repo.listFiles();
  const moduleDirs = all
    .filter((f) => (f === "go.mod" || f.endsWith("/go.mod")) && !isIgnoredGoPath(f))
    .map(dirOf);
  const nearest = (file: string): string | undefined => {
    let best: string | undefined;
    for (const d of moduleDirs) {
      const inside = d === "." || file.startsWith(`${d}/`);
      if (inside && (best === undefined || d.length > best.length || best === ".")) best = d;
    }
    return best;
  };

  const mod = await readGoMod(repo, project);
  const modules = new Set((mod?.require ?? []).map((r) => r.path));
  const files: ProjectScan["files"] = [];
  for (const f of all) {
    if (context.signal?.aborted) break;
    if (!f.endsWith(".go") || isIgnoredGoPath(f) || nearest(f) !== project.path) continue;
    let text: string;
    try {
      text = await repo.readFile(f);
    } catch {
      continue;
    }
    files.push({ path: f, parsed: extractGoImports(text) });
  }
  return { files, modules, tools: mod?.tool ?? [] };
}

export async function findGoUsage(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const scan = await scanProject(context, dependency.project);
  const modules = new Set(scan.modules).add(dependency.name);
  const usages: Usage[] = [];

  for (const { path, parsed } of scan.files) {
    for (const imp of parsed.imports) {
      if (owningModule(imp.path, modules) !== dependency.name) continue;
      const blankOrDot = imp.alias === "_" || imp.alias === ".";
      const local = imp.alias ?? defaultPackageName(imp.path);
      const symbols = blankOrDot ? [] : [...(parsed.selectors.get(local) ?? [])].sort();
      usages.push({
        dependency: dependency.name,
        file: path,
        line: imp.line,
        form: "static",
        via: "import",
        symbols,
      });
    }
  }

  const goMod = joinPath(dependency.project.path, "go.mod");
  for (const tool of scan.tools) {
    if (owningModule(tool.path, modules) !== dependency.name) continue;
    const name = tool.path.split("/").pop() ?? tool.path;
    usages.push({
      dependency: dependency.name,
      file: goMod,
      line: tool.line,
      form: "unknown",
      via: "config",
      symbols: [name],
    });
  }

  // PR mode (#101): import paths on removed lines of Go files.
  for (const change of context.pullRequestSourceChanges ?? []) {
    if (!change.path.endsWith(".go") || isIgnoredGoPath(change.path)) continue;
    for (const removed of change.removedLines) {
      for (const m of removed.text.matchAll(/"([^"\s\\]+)"|`([^`\s]+)`/g)) {
        const value = m[1] ?? m[2]!;
        if (owningModule(value, modules) !== dependency.name) continue;
        usages.push({
          dependency: dependency.name,
          file: change.path,
          line: removed.line,
          form: "static",
          via: "import",
          symbols: [],
          removedInPr: true,
        });
        break;
      }
    }
  }
  return usages;
}
