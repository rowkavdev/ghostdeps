/**
 * findUsage for Python (#261): which source files import a declared
 * distribution. Imports are resolved through the #46 mapping
 * (ImportResolver): stdlib, first-party, committed top_level.txt metadata,
 * the known-names table, then the PEP 503 name rule. Unresolved imports are
 * never attributed to anything.
 *
 * Semantics pinned for M2: this reports Usage evidence only. The adapter
 * does not declare "referenceAnalysis" and returns the plain-array form, so
 * "no usages" stays ambiguous and policy never reaches an "unused" verdict
 * for Python (same rule as Go and Rust). Build-system requirements are
 * never unused-eligible either way.
 *
 * PR-mode removed-line evidence (removedInPr) is not produced yet; it waits
 * on the shared base-reconstruction helper (#259).
 */
import { MAX_FILE_READ_BYTES, hasExcludedSegment } from "@ghostdeps/core";
import type {
  AdapterContext,
  Dependency,
  ProjectRef,
  RepositoryHandle,
  Usage,
} from "@ghostdeps/core";
import { candidateRoots, nearestRoot } from "../detect.js";
import { ImportResolver, firstPartyModules, readTopLevelMetadata } from "../import-map.js";
import { parseManifests } from "../manifest.js";
import { normaliseName } from "../pep508.js";
import { extractPythonImports, type PythonFileImports } from "./imports.js";

/**
 * .py files larger than this are skipped, not scanned (security model:
 * parser input limits). Same bound as the JS and Go adapters.
 */
export const MAX_PYTHON_SOURCE_BYTES = Math.min(1_000_000, MAX_FILE_READ_BYTES);

const isPythonSource = (path: string) => path.endsWith(".py") || path.endsWith(".pyw");

interface ProjectScan {
  files: { path: string; parsed: PythonFileImports }[];
  /** Files not scanned: over MAX_PYTHON_SOURCE_BYTES or unreadable. */
  skipped: { path: string; reason: "too-large" | "unreadable" }[];
  resolver: ImportResolver;
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
    // Never cache a failed or aborted scan: the next call starts fresh.
    scan.catch(() => perRepo.delete(project.path));
  }
  return scan;
}

async function doScan(context: AdapterContext, project: ProjectRef): Promise<ProjectScan> {
  const repo = context.repository;
  const all = (await repo.listFiles()).filter((file) => !hasExcludedSegment(file));
  const roots = new Set(candidateRoots(all));
  roots.add(project.path);
  const owned = all.filter((file) => nearestRoot(file, roots) === project.path);

  const manifests = await parseManifests(repo, project);
  const resolver = new ImportResolver({
    declared: manifests.requirements.map((r) => r.dependency.name),
    firstParty: firstPartyModules(project.path, owned),
    topLevel: await readTopLevelMetadata(repo, project.path, owned),
  });

  const files: ProjectScan["files"] = [];
  const skipped: ProjectScan["skipped"] = [];
  for (const file of owned) {
    // Throw rather than break: a partial scan must never be cached as complete.
    context.signal?.throwIfAborted();
    if (!isPythonSource(file)) continue;
    let text: string;
    try {
      text = await repo.readFile(file);
    } catch {
      // TODO(#121): surface skipped files as incompleteness once the #205
      // adapter note channel lands; today they are only recorded here.
      skipped.push({ path: file, reason: "unreadable" });
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_PYTHON_SOURCE_BYTES) {
      skipped.push({ path: file, reason: "too-large" });
      continue;
    }
    files.push({ path: file, parsed: extractPythonImports(text) });
  }
  return { files, skipped, resolver };
}

export async function findPythonUsage(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const scan = await scanProject(context, dependency.project);
  const target = normaliseName(dependency.name);
  const usages: Usage[] = [];
  for (const { path, parsed } of scan.files) {
    for (const imp of parsed.imports) {
      const resolved = scan.resolver.resolve(imp.module);
      if (resolved.kind !== "dependency" || !resolved.distributions.includes(target)) continue;
      const symbols =
        imp.names.length > 0
          ? imp.names.filter((name) => name !== "*")
          : imp.local !== undefined
            ? [...(parsed.attributes.get(imp.local) ?? [])]
            : [];
      usages.push({
        dependency: dependency.name,
        file: path,
        line: imp.line,
        form: imp.form,
        via: "import",
        symbols: [...new Set(symbols)].sort(),
        ...(imp.typeOnly ? { typeOnly: true } : {}),
      });
    }
  }
  return usages;
}
