/**
 * Repository-level usage analysis for JS/TS: which files import which
 * packages, with file/line evidence. Reads files through the read-only
 * RepositoryHandle only; never executes or resolves anything.
 */
import { DEFAULT_EXCLUDED_DIRECTORIES, DEFAULT_EXCLUDED_FILE_SUFFIXES } from "@ghostdeps/core";
import type {
  AdapterContext,
  Dependency,
  Evidence,
  RepositoryHandle,
  Usage,
} from "@ghostdeps/core";
import { scanSource, scriptKindFor } from "./scan.js";
import type { FileScanResult } from "./scan.js";

/** Files larger than this are skipped and reported, not parsed (security-model: parser input limits). */
export const MAX_SOURCE_BYTES = 1_000_000;

/** Unresolved dynamic-import limitations recorded individually per file; the rest are summarised. */
export const MAX_UNRESOLVED_PER_FILE = 20;

export interface RepositoryScan {
  /** Parsed files keyed by repository-relative path. */
  files: Map<string, FileScanResult>;
  /** Project root ("." or a workspace dir) that owns each scanned file. Files outside every root have no entry. */
  owner: Map<string, string>;
  /** Evidence that weakens completeness: unresolvable dynamic imports, skipped files, parse errors. */
  limitations: Evidence[];
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/**
 * The RepositoryHandle already applies the scanner's exclusions (#73). This
 * applies the same core lists again so handles that list more (test
 * handles, custom callers) never pull vendored or generated code into usage.
 */
function isSkipped(path: string): boolean {
  if (DEFAULT_EXCLUDED_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
  return path.split("/").some((seg) => DEFAULT_EXCLUDED_DIRECTORIES.has(seg));
}

/** Deepest directory containing a package.json that is an ancestor of `file`. */
function owningRoot(file: string, roots: Set<string>): string | undefined {
  let dir = dirname(file);
  for (;;) {
    if (roots.has(dir)) return dir;
    if (dir === ".") return undefined;
    dir = dirname(dir);
  }
}

/**
 * Memoised per AdapterContext: one analysis job builds one context, so a
 * long-lived handle reused across jobs is rescanned each job and never serves
 * stale results. Entries die with the context.
 */
const cache = new WeakMap<AdapterContext, Promise<RepositoryScan>>();

/** Scan every JS/TS source file once per analysis context. */
export function scanForContext(context: AdapterContext): Promise<RepositoryScan> {
  let pending = cache.get(context);
  if (!pending) {
    pending = scanRepository(context.repository);
    cache.set(context, pending);
  }
  return pending;
}

/** Scan every JS/TS source file in `repository`. Not memoised. */
export function scanRepository(repository: RepositoryHandle): Promise<RepositoryScan> {
  return doScan(repository);
}

async function doScan(repository: RepositoryHandle): Promise<RepositoryScan> {
  const all = (await repository.listFiles()).map((f) => f.replace(/^\.\//, ""));
  const roots = new Set<string>();
  for (const f of all) {
    if (isSkipped(f)) continue;
    if (f === "package.json") roots.add(".");
    else if (f.endsWith("/package.json")) roots.add(dirname(f));
  }
  const scan: RepositoryScan = { files: new Map(), owner: new Map(), limitations: [] };
  for (const file of all) {
    if (isSkipped(file) || !scriptKindFor(file)) continue;
    const root = owningRoot(file, roots);
    if (root === undefined) {
      // No package.json above it: no project declares its imports, so it is
      // attributed to nobody rather than guessed into the root.
      scan.limitations.push({
        kind: "file-outside-project",
        statement: `${file} is not inside any package.json project and was not attributed`,
        file,
      });
      continue;
    }
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      scan.limitations.push({ kind: "file-unreadable", statement: `could not read ${file}`, file });
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
      scan.limitations.push({
        kind: "file-too-large",
        statement: `${file} exceeds ${MAX_SOURCE_BYTES} bytes and was not scanned`,
        file,
      });
      continue;
    }
    const result = scanSource(file, text);
    scan.files.set(file, result);
    scan.owner.set(file, root);
    if (result.parseErrors) {
      scan.limitations.push({
        kind: "parse-error",
        statement: `${file} has syntax errors; imports found may be incomplete`,
        file,
      });
    }
    let unresolved = 0;
    for (const ref of result.references) {
      if (ref.specifier === undefined) {
        unresolved += 1;
        if (unresolved > MAX_UNRESOLVED_PER_FILE) continue;
        scan.limitations.push({
          kind: "dynamic-import-unresolved",
          statement:
            `${ref.form === "unknown" ? "non-literal" : ""} import/require target in ${file}:${ref.line} cannot be resolved statically`.trim(),
          file,
          line: ref.line,
        });
      }
    }
    if (unresolved > MAX_UNRESOLVED_PER_FILE) {
      scan.limitations.push({
        kind: "dynamic-import-unresolved-summary",
        statement: `${unresolved - MAX_UNRESOLVED_PER_FILE} more unresolvable import/require targets in ${file} were not listed individually`,
        file,
      });
    }
  }
  return scan;
}

/**
 * Usages of `dependency` inside its declaring project. Files belonging to a
 * nested workspace package are attributed to that package, not the root.
 */
export async function findUsage(context: AdapterContext, dependency: Dependency): Promise<Usage[]> {
  const scan = await scanForContext(context);
  const project = dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const usages: Usage[] = [];
  for (const [file, result] of scan.files) {
    if (scan.owner.get(file) !== project) continue;
    for (const ref of result.references) {
      if (ref.packageName !== dependency.name) continue;
      const usage: Usage = {
        dependency: dependency.name,
        file,
        line: ref.line,
        form: ref.form,
        symbols: [...new Set(ref.symbols)],
      };
      // Only `import type` / `export type` / `typeof import()` - erased at runtime.
      if (ref.typeOnly) usage.typeOnly = true;
      usages.push(usage);
    }
  }
  return usages.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * Limitations relevant to one project (unresolved dynamic imports, skipped
 * or broken files). Files with no owner (skipped before attribution, or
 * outside every project) weaken every project's completeness, so they are
 * reported to all of them.
 */
export async function usageLimitations(
  context: AdapterContext,
  projectPath: string,
): Promise<Evidence[]> {
  const scan = await scanForContext(context);
  const project = projectPath.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return scan.limitations.filter((e) => !e.file || (scan.owner.get(e.file) ?? project) === project);
}
