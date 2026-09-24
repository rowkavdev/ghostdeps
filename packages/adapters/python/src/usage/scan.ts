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
 * for Python (same rule as Go and Rust).
 *
 * Build-system requirements ([build-system] requires, PEP 518) are used by
 * declaration: the build frontend installs and runs them, and the project
 * never imports them. Each one gets declaration-site usage evidence
 * (via "config", anchored on its line in pyproject.toml, the same family
 * as script/config references, #132), so no-imports notes never fire for
 * them (lead ruling on #268).
 *
 * PR mode (#287): imports on lines the pull request removed come from
 * removed.ts, marked removedInPr and resolved with this project's resolver.
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
import { findRemovedPythonUsages } from "./removed.js";

/**
 * .py files larger than this are skipped, not scanned (security model:
 * parser input limits). Same bound as the JS and Go adapters.
 */
export const MAX_PYTHON_SOURCE_BYTES = Math.min(1_000_000, MAX_FILE_READ_BYTES);

const isPythonSource = (path: string) => path.endsWith(".py") || path.endsWith(".pyw");

interface ProjectScan {
  files: { path: string; parsed: PythonFileImports }[];
  /** Build-system requirement name -> its declaration site. */
  buildDeclarations: Map<string, { file: string; line: number }>;
  /** Files not scanned: over MAX_PYTHON_SOURCE_BYTES or unreadable. */
  skipped: { path: string; reason: "too-large" | "unreadable" }[];
  resolver: ImportResolver;
}

// Keyed on the RepositoryHandle (the JS adapter keys on AdapterContext).
// Handles are created per analysis run, so a cached scan never outlives the
// repository snapshot it read.
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

  const buildDeclarations = new Map<string, { file: string; line: number }>();
  const texts = new Map<string, string | undefined>();
  for (const { dependency } of manifests.requirements) {
    if (dependency.kind !== "build") continue;
    if (!texts.has(dependency.declaredIn)) {
      texts.set(
        dependency.declaredIn,
        await repo.readFile(dependency.declaredIn).catch(() => undefined),
      );
    }
    const text = texts.get(dependency.declaredIn);
    buildDeclarations.set(dependency.name, {
      file: dependency.declaredIn,
      line: text === undefined ? 1 : buildRequirementLine(text, dependency.name),
    });
  }

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
  return { files, buildDeclarations, skipped, resolver };
}

/**
 * 1-based line of a requirement inside [build-system] of a pyproject.toml:
 * the line whose string starts with the name, else the `requires` line,
 * else the table header. Names compare PEP 503-normalised.
 */
export function buildRequirementLine(text: string, name: string): number {
  const lines = text.split(/\r?\n/);
  const want = normaliseName(name);
  const header = lines.findIndex((l) => /^\s*\[\s*build-system\s*\]/.test(l));
  if (header === -1) return 1;
  let requires = -1;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) break;
    if (requires === -1 && /^\s*requires\s*=/.test(line)) requires = i;
    for (const m of line.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
      if (normaliseName(m[1]!) === want) return i + 1;
    }
  }
  return (requires === -1 ? header : requires) + 1;
}

export async function findPythonUsage(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const scan = await scanProject(context, dependency.project);
  const target = normaliseName(dependency.name);
  const usages: Usage[] = [];
  const build = dependency.kind === "build" ? scan.buildDeclarations.get(target) : undefined;
  if (build !== undefined) {
    usages.push({
      dependency: dependency.name,
      file: build.file,
      line: build.line,
      form: "unknown",
      via: "config",
      symbols: [],
    });
  }
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
  const removed = await findRemovedPythonUsages(context, dependency, (module) => {
    const resolved = scan.resolver.resolve(module);
    return resolved.kind === "dependency" && resolved.distributions.includes(target);
  });
  return [...usages, ...removed];
}
