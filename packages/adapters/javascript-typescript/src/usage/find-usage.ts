/**
 * Repository-level usage analysis for JS/TS: which files import which
 * packages, with file/line evidence. Reads files through the read-only
 * RepositoryHandle only; never executes or resolves anything.
 */
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

/** Directories never scanned even if the handle lists them. */
const SKIP_SEGMENTS = new Set(["node_modules", ".git", "bower_components", "jspm_packages"]);

export interface RepositoryScan {
  /** Parsed files keyed by repository-relative path. */
  files: Map<string, FileScanResult>;
  /** Project root ("." or a workspace dir) that owns each scanned file. */
  owner: Map<string, string>;
  /** Evidence that weakens completeness: unresolvable dynamic imports, skipped files, parse errors. */
  limitations: Evidence[];
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

function isSkipped(path: string): boolean {
  return path.split("/").some((seg) => SKIP_SEGMENTS.has(seg));
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

const cache = new WeakMap<RepositoryHandle, Promise<RepositoryScan>>();

/** Scan every JS/TS source file once per repository handle (memoised). */
export function scanRepository(repository: RepositoryHandle): Promise<RepositoryScan> {
  let pending = cache.get(repository);
  if (!pending) {
    pending = doScan(repository);
    cache.set(repository, pending);
  }
  return pending;
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
    const root = owningRoot(file, roots) ?? ".";
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
    for (const ref of result.references) {
      if (ref.specifier === undefined) {
        scan.limitations.push({
          kind: "dynamic-import-unresolved",
          statement:
            `${ref.form === "unknown" ? "non-literal" : ""} import/require target in ${file}:${ref.line} cannot be resolved statically`.trim(),
          file,
          line: ref.line,
        });
      }
    }
  }
  return scan;
}

/**
 * Usages of `dependency` inside its declaring project. Files belonging to a
 * nested workspace package are attributed to that package, not the root.
 */
export async function findUsage(context: AdapterContext, dependency: Dependency): Promise<Usage[]> {
  const scan = await scanRepository(context.repository);
  const project = dependency.project.path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const usages: Usage[] = [];
  for (const [file, result] of scan.files) {
    if (scan.owner.get(file) !== project) continue;
    for (const ref of result.references) {
      if (ref.packageName !== dependency.name) continue;
      usages.push({
        dependency: dependency.name,
        file,
        line: ref.line,
        form: ref.form,
        symbols: [...new Set(ref.symbols)],
      });
    }
  }
  return usages.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Limitations relevant to one project (unresolved dynamic imports, skipped or broken files). */
export async function usageLimitations(
  context: AdapterContext,
  projectPath: string,
): Promise<Evidence[]> {
  const scan = await scanRepository(context.repository);
  const project = projectPath.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return scan.limitations.filter((e) => !e.file || (scan.owner.get(e.file) ?? project) === project);
}
