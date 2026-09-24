/**
 * PR mode (#287, parity with js #101 and rust #249): imports of a
 * dependency on lines the pull request removed, reported as Usage with
 * `removedInPr: true`.
 *
 * Each changed .py/.pyw file's base version is rebuilt from the head file
 * and the diff, then scanned whole by the same statement scanner as head
 * usage, so names inside comments or strings never count. An import counts
 * when its line, or any line of its multi-line statement, was removed; it
 * is cited at its base-side line. When the diff lines do not fit together
 * (a capped or malformed diff) the file contributes nothing: fail closed,
 * never a guessed removal (ADR-0004). Diff text is data, parsed and never
 * evaluated, and already bounded by core (PR_SOURCE_CHANGE_LIMITS).
 */
import { MAX_FILE_READ_BYTES, hasExcludedSegment, reconstructBase } from "@ghostdeps/core";
import type { AdapterContext, Dependency, Usage } from "@ghostdeps/core";
import { candidateRoots, nearestRoot } from "../detect.js";
import { extractPythonImports, type PythonImport } from "./imports.js";

export interface RemovedImport {
  file: string;
  imp: PythonImport;
  /** Attributes accessed on the import's local name in the base file. */
  symbols: string[];
}

const isPythonSource = (path: string) => path.endsWith(".py") || path.endsWith(".pyw");
const cache = new WeakMap<AdapterContext, Promise<RemovedImport[]>>();
const rootsCache = new WeakMap<AdapterContext, Promise<readonly string[]>>();

/**
 * Candidate Python project roots at head, once per run: findUsage runs per
 * dependency, and listing the repository each time is wasted work.
 */
function headRoots(context: AdapterContext): Promise<readonly string[]> {
  let pending = rootsCache.get(context);
  if (pending === undefined) {
    pending = context.repository
      .listFiles()
      .then((files) => candidateRoots(files.filter((f) => !hasExcludedSegment(f))));
    rootsCache.set(context, pending);
    // Never cache a failed listing.
    pending.catch(() => rootsCache.delete(context));
  }
  return pending;
}

/** Every import on a removed line, across all changed Python files, once per run. */
export function removedPythonImports(context: AdapterContext): Promise<RemovedImport[]> {
  let pending = cache.get(context);
  if (pending === undefined) {
    pending = collect(context);
    cache.set(context, pending);
    // Never cache a failed or aborted collection.
    pending.catch(() => cache.delete(context));
  }
  return pending;
}

async function collect(context: AdapterContext): Promise<RemovedImport[]> {
  const out: RemovedImport[] = [];
  for (const change of context.pullRequestSourceChanges ?? []) {
    context.signal?.throwIfAborted();
    const file = change.path.replace(/^\.\//, "");
    if (!isPythonSource(file) || hasExcludedSegment(file) || change.removedLines.length === 0) {
      continue;
    }
    // A file deleted by the PR has no head: its base is the removed lines.
    let head: string[] = [];
    try {
      if (await context.repository.exists(file)) {
        const text = await context.repository.readFile(file);
        if (Buffer.byteLength(text, "utf8") > MAX_FILE_READ_BYTES) continue;
        head = text.split(/\r?\n/);
      }
    } catch {
      continue;
    }
    const base = reconstructBase(head, change);
    if (base === undefined) continue;
    const removed = new Set(change.removedLines.map((l) => l.line));
    const parsed = extractPythonImports(base.join("\n"));
    for (const imp of parsed.imports) {
      let touched = false;
      for (let n = imp.line; n <= imp.endLine && !touched; n++) touched = removed.has(n);
      if (!touched) continue;
      const symbols =
        imp.names.length > 0
          ? imp.names.filter((name) => name !== "*")
          : imp.local !== undefined
            ? [...(parsed.attributes.get(imp.local) ?? [])]
            : [];
      out.push({ file, imp, symbols: [...new Set(symbols)].sort() });
    }
  }
  return out;
}

/**
 * Removed-line usages of `dependency`: imports in files its project owns
 * (nearest Python project root at head), resolved with the project's head
 * resolver. One Usage per file and base line.
 */
export async function findRemovedPythonUsages(
  context: AdapterContext,
  dependency: Dependency,
  resolves: (module: string) => boolean,
): Promise<Usage[]> {
  if ((context.pullRequestSourceChanges ?? []).length === 0) return [];
  const removed = await removedPythonImports(context);
  if (removed.length === 0) return [];
  const roots = new Set(await headRoots(context));
  roots.add(dependency.project.path);
  const byLine = new Map<string, Usage>();
  for (const { file, imp, symbols } of removed) {
    if (nearestRoot(file, roots) !== dependency.project.path) continue;
    if (!resolves(imp.module)) continue;
    const key = `${file}:${imp.line}`;
    const existing = byLine.get(key);
    if (existing !== undefined) {
      for (const s of symbols) if (!existing.symbols.includes(s)) existing.symbols.push(s);
      existing.symbols.sort();
      continue;
    }
    byLine.set(key, {
      dependency: dependency.name,
      file,
      line: imp.line,
      form: imp.form,
      via: "import",
      symbols: [...symbols],
      ...(imp.typeOnly ? { typeOnly: true } : {}),
      removedInPr: true,
    });
  }
  return [...byLine.values()].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
}
