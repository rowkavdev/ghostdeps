/**
 * PR mode (#249, parity with js #101/#168/#186): uses of a dependency on
 * lines the pull request removed, reported as Usage with `removedInPr: true`.
 *
 * Each changed .rs file's base version is rebuilt from the head file and
 * the diff, then parsed whole with the same tree-sitter seam and reference
 * collector as head usage, so crate names inside comments or strings never
 * count. A reference counts when its line, or any line of its multi-line
 * use statement, was removed; it is cited at its base-side line. Diff text is data: parsed, never
 * evaluated, and already bounded by core (PR_SOURCE_CHANGE_LIMITS).
 */
import {
  MAX_FILE_READ_BYTES,
  hasExcludedSegment,
  type AdapterContext,
  type Dependency,
  type SourceLineChanges,
  type Usage,
} from "@ghostdeps/core";
import { isManifestPath } from "./discover.js";
import { withRustTree } from "./parser.js";
import { compareStrings, dirOf } from "./paths.js";
import { collectReferences, crateNames, type CrateReference } from "./usage.js";

/**
 * The file as it was at the PR's base, rebuilt from head and the diff:
 * removed lines go back at their base line numbers, added lines come out,
 * everything else is shared. Undefined when the lines do not fit together
 * (a capped or malformed diff), so the caller records nothing rather than
 * guessing. Same algorithm as the js adapter's reconstructBase; a shared
 * helper can replace both.
 */
export function reconstructBase(
  head: readonly string[],
  change: SourceLineChanges,
): string[] | undefined {
  const removed = new Map<number, string>();
  for (const l of change.removedLines) removed.set(l.line, l.text);
  const added = new Set(change.addedLines.map((l) => l.line));
  for (const n of added) if (n > head.length) return undefined;
  const lastRemoved = Math.max(0, ...removed.keys());
  const base: string[] = [];
  let h = 0;
  for (let n = 1; ; n++) {
    if (removed.has(n)) {
      base.push(removed.get(n)!);
      continue;
    }
    while (h < head.length && added.has(h + 1)) h++;
    if (h >= head.length) return n > lastRemoved ? base : undefined;
    base.push(head[h]!);
    h++;
  }
}

interface RemovedReference {
  file: string;
  ref: CrateReference;
}

const removedCaches = new WeakMap<AdapterContext, Promise<RemovedReference[]>>();

/** Every crate reference on a removed line, across all changed .rs files, once per run. */
function removedReferences(
  context: AdapterContext,
  changes: readonly SourceLineChanges[],
): Promise<RemovedReference[]> {
  let pending = removedCaches.get(context);
  if (pending === undefined) {
    pending = (async () => {
      const out: RemovedReference[] = [];
      for (const change of changes) {
        const file = change.path.replace(/^\.\//, "");
        if (!file.endsWith(".rs") || hasExcludedSegment(file) || change.removedLines.length === 0) {
          continue;
        }
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
        const removedLines = new Set(change.removedLines.map((l) => l.line));
        const refs = await withRustTree(base.join("\n"), collectReferences);
        for (const ref of refs ?? []) {
          const { start, end } = ref.statement ?? { start: ref.line, end: ref.line };
          let touched = false;
          for (let n = start; n <= end && !touched; n++) touched = removedLines.has(n);
          if (touched) out.push({ file, ref });
        }
      }
      return out;
    })();
    removedCaches.set(context, pending);
  }
  return pending;
}

/** The crate root owning a path: the deepest directory with a Cargo.toml at head. */
function owningRoot(file: string, roots: ReadonlySet<string>): string | undefined {
  let dir = dirOf(file);
  for (;;) {
    if (roots.has(dir)) return dir;
    if (dir === ".") return undefined;
    dir = dirOf(dir);
  }
}

export async function findRemovedUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const changes = context.pullRequestSourceChanges;
  if (changes === undefined || changes.length === 0) return [];
  const refs = await removedReferences(context, changes);
  if (refs.length === 0) return [];
  const names = await crateNames(context, dependency);
  const roots = new Set((await context.repository.listFiles()).filter(isManifestPath).map(dirOf));
  const byLine = new Map<string, Usage>();
  for (const { file, ref } of refs) {
    if (!names.has(ref.crate)) continue;
    if (owningRoot(file, roots) !== dependency.project.path) continue;
    const k = `${file}:${ref.line}`;
    let usage = byLine.get(k);
    if (usage === undefined) {
      usage = {
        dependency: dependency.name,
        file,
        line: ref.line,
        form: "static",
        symbols: [],
        removedInPr: true,
      };
      byLine.set(k, usage);
    }
    if (ref.symbol !== undefined && !usage.symbols.includes(ref.symbol)) {
      usage.symbols.push(ref.symbol);
    }
  }
  return [...byLine.values()].sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line);
}
