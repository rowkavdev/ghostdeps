/**
 * Repository-level usage analysis for JS/TS: which files import which
 * packages, with file/line evidence. Reads files through the read-only
 * RepositoryHandle only; never executes or resolves anything.
 */
import {
  EXCLUDED_FILE_SUFFIXES,
  MAX_FILE_READ_BYTES,
  hasExcludedSegment,
  reconstructBase,
} from "@ghostdeps/core";
import type {
  AdapterContext,
  Dependency,
  Evidence,
  RepositoryHandle,
  SourceLineChanges,
  Usage,
} from "@ghostdeps/core";
import { AliasResolver } from "./aliases.js";
import { extractScriptBlocks, isEmbeddedScriptFile } from "./embedded.js";
import { scanSource, scriptKindFor } from "./scan.js";
import type { FileScanResult } from "./scan.js";

/**
 * Source files larger than this are skipped and reported, not parsed
 * (security-model: parser input limits). Deliberately stricter than core's
 * read cap: a full TypeScript AST costs far more per byte than reading, and
 * 1 MB covers any hand-written module. Never above core's read cap.
 */
export const MAX_SOURCE_BYTES = Math.min(1_000_000, MAX_FILE_READ_BYTES);

/** Unresolved dynamic-import limitations recorded individually per file; the rest are summarised. */
export const MAX_UNRESOLVED_PER_FILE = 20;

/** Files outside every project recorded individually per scan; the rest are counted in one summary. */
export const MAX_OUTSIDE_PROJECT_RECORDS = 20;

export interface RepositoryScan {
  /** Parsed files keyed by repository-relative path. */
  files: Map<string, FileScanResult>;
  /** Project root ("." or a workspace dir) that owns each scanned file. Files outside every root have no entry. */
  owner: Map<string, string>;
  /** Evidence that weakens completeness: unresolvable dynamic imports, skipped files, parse errors. */
  limitations: Evidence[];
  /** The same limitations grouped by owning project root. */
  byProject: Map<string, Evidence[]>;
  /** Bounded limitations that apply to every project (files outside all projects). */
  shared: Evidence[];
  /** Every project root ("." or a workspace dir) found by package.json. */
  roots: Set<string>;
  /** tsconfig/jsconfig alias resolver for the repository (#29). */
  aliases: AliasResolver;
  /** First stylesheet per preprocessor extension, per owning project (listed, never read). */
  styles: Map<string, Map<string, string>>;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/**
 * The RepositoryHandle already applies the scanner's exclusions (#73). This
 * applies core's shared lists (limits.ts, #106) again so handles that list more (test
 * handles, custom callers) never pull vendored or generated code into usage.
 */
function isSkipped(path: string): boolean {
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
  return hasExcludedSegment(path);
}

/**
 * Clear packageName on references a tsconfig/jsconfig alias resolves to a
 * repository file (#29), so "@app/db" or "utils/log" never counts as usage
 * of an npm package with that name. Only package-shaped specifiers are
 * checked: relative and invalid ones already carry no package.
 */
async function applyAliases(
  aliases: AliasResolver,
  file: string,
  result: FileScanResult,
): Promise<void> {
  if (!result.references.some((r) => r.packageName !== undefined)) return;
  const configFile = aliases.nearestConfig(dirname(file));
  if (configFile === undefined) return;
  const config = await aliases.configFor(configFile);
  if (config === undefined) return;
  for (const ref of result.references) {
    if (ref.packageName === undefined || ref.specifier === undefined) continue;
    if (aliases.isInternal(ref.specifier, config)) {
      delete ref.packageName;
      ref.aliased = true;
    }
  }
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

/**
 * Scan every JS/TS source file in `repository`. Not memoised: adapter code
 * paths (findUsage, usageLimitations) go through scanForContext.
 */
export function scanRepository(repository: RepositoryHandle): Promise<RepositoryScan> {
  return doScan(repository);
}

/**
 * Scan the script blocks of an HTML page or single-file component
 * (.vue/.svelte/.astro) as one file, with lines mapped back to the file.
 * Style blocks and templates are not read.
 */
function scanEmbedded(file: string, text: string, limitations: Evidence[]): FileScanResult {
  const { blocks, dropped } = extractScriptBlocks(file, text);
  const result: FileScanResult = { file, references: [], parseErrors: false };
  for (const block of blocks) {
    const part = scanSource(file, block.code, block.kind);
    for (const ref of part.references) {
      ref.line += block.line - 1;
      result.references.push(ref);
    }
    if (part.parseErrors) result.parseErrors = true;
  }
  if (dropped > 0) {
    limitations.push({
      kind: "script-blocks-unscanned",
      statement: `${dropped} more script blocks in ${file} were not scanned`,
      file,
    });
  }
  return result;
}

/**
 * Preprocessors that bundlers (vite, webpack loaders, parcel) load for a
 * stylesheet by its extension, never by an import of the package (#172,
 * vite: .sss -> sugarss).
 */
const PREPROCESSORS: Record<string, readonly string[]> = {
  ".sss": ["sugarss"],
  ".scss": ["sass", "sass-embedded", "node-sass"],
  ".sass": ["sass", "sass-embedded", "node-sass"],
  ".less": ["less"],
  ".styl": ["stylus"],
  ".stylus": ["stylus"],
};

function preprocessorExtension(file: string): string | undefined {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = file.slice(dot).toLowerCase();
  return Object.hasOwn(PREPROCESSORS, ext) ? ext : undefined;
}

async function doScan(repository: RepositoryHandle): Promise<RepositoryScan> {
  const all = (await repository.listFiles()).map((f) => f.replace(/^\.\//, ""));
  const roots = new Set<string>();
  for (const f of all) {
    if (isSkipped(f)) continue;
    if (f === "package.json") roots.add(".");
    else if (f.endsWith("/package.json")) roots.add(dirname(f));
  }

  const aliases = new AliasResolver(
    repository,
    all.filter((f) => !isSkipped(f)),
  );
  const scan: RepositoryScan = {
    files: new Map(),
    owner: new Map(),
    limitations: [],
    byProject: new Map(),
    shared: [],
    roots,
    aliases,
    styles: new Map(),
  };
  let outside = 0;
  for (const file of all) {
    const style = preprocessorExtension(file);
    if (style && !isSkipped(file)) {
      const owner = owningRoot(file, roots);
      if (owner !== undefined) {
        const byExt = scan.styles.get(owner) ?? new Map<string, string>();
        if (!byExt.has(style)) byExt.set(style, file);
        scan.styles.set(owner, byExt);
      }
      continue;
    }
    const embedded = isEmbeddedScriptFile(file);
    if (isSkipped(file) || !(embedded || scriptKindFor(file))) continue;
    const root = owningRoot(file, roots);
    if (root === undefined) {
      // No package.json above it: no project declares its imports, so it is
      // attributed to nobody rather than guessed into the root. Bounded: a
      // large unowned area must not flood every project's evidence.
      outside += 1;
      if (outside <= MAX_OUTSIDE_PROJECT_RECORDS) {
        scan.shared.push({
          kind: "file-outside-project",
          statement: `${file} is not inside any package.json project and was not attributed`,
          file,
        });
      }
      continue;
    }
    const limitations = scan.byProject.get(root) ?? [];
    scan.byProject.set(root, limitations);
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      limitations.push({ kind: "file-unreadable", statement: `could not read ${file}`, file });
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
      limitations.push({
        kind: "file-too-large",
        statement: `${file} exceeds ${MAX_SOURCE_BYTES} bytes and was not scanned`,
        file,
      });
      continue;
    }
    const result = embedded ? scanEmbedded(file, text, limitations) : scanSource(file, text);
    await applyAliases(aliases, file, result);
    scan.files.set(file, result);
    scan.owner.set(file, root);
    if (result.parseErrors) {
      limitations.push({
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
        limitations.push({
          kind: "dynamic-import-unresolved",
          statement:
            `${ref.form === "unknown" ? "non-literal" : ""} import/require target in ${file}:${ref.line} cannot be resolved statically`.trim(),
          file,
          line: ref.line,
        });
      }
    }
    if (unresolved > MAX_UNRESOLVED_PER_FILE) {
      limitations.push({
        kind: "dynamic-import-unresolved-summary",
        statement: `${unresolved - MAX_UNRESOLVED_PER_FILE} more unresolvable import/require targets in ${file} were not listed individually`,
        file,
      });
    }
  }
  // Config problems (unreadable, malformed, cyclic extends) go to the project owning the config.
  for (const e of aliases.limitations) {
    const root = e.file === undefined ? undefined : owningRoot(e.file, roots);
    if (root === undefined) scan.shared.push(e);
    else {
      const list = scan.byProject.get(root) ?? [];
      list.push(e);
      scan.byProject.set(root, list);
    }
  }
  if (outside > MAX_OUTSIDE_PROJECT_RECORDS) {
    scan.shared.push({
      kind: "file-outside-project-summary",
      statement: `${outside} source files are outside every package.json project and were not attributed; ${MAX_OUTSIDE_PROJECT_RECORDS} are listed individually`,
    });
  }
  scan.limitations = [...[...scan.byProject.values()].flat(), ...scan.shared];
  return scan;
}

type IndexEntry = { file: string; ref: FileScanResult["references"][number] };

/** References grouped by package name, built once per scan. */
const indexes = new WeakMap<RepositoryScan, Map<string, IndexEntry[]>>();

function indexFor(scan: RepositoryScan): Map<string, IndexEntry[]> {
  let index = indexes.get(scan);
  if (!index) {
    index = new Map();
    for (const [file, result] of scan.files) {
      for (const ref of result.references) {
        if (ref.packageName === undefined) continue;
        const list = index.get(ref.packageName);
        if (list) list.push({ file, ref });
        else index.set(ref.packageName, [{ file, ref }]);
      }
    }
    indexes.set(scan, index);
  }
  return index;
}

const DECLARATION_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Names each project root declares, read once per analysis context. Unreadable manifests declare nothing. */
const declaredCaches = new WeakMap<AdapterContext, Promise<Map<string, Set<string>>>>();

function declaredFor(
  context: AdapterContext,
  scan: RepositoryScan,
): Promise<Map<string, Set<string>>> {
  let pending = declaredCaches.get(context);
  if (!pending) {
    pending = (async () => {
      const out = new Map<string, Set<string>>();
      for (const root of scan.roots) {
        const names = new Set<string>();
        out.set(root, names);
        try {
          const doc: unknown = JSON.parse(
            await context.repository.readFile(
              root === "." ? "package.json" : `${root}/package.json`,
            ),
          );
          if (typeof doc !== "object" || doc === null) continue;
          for (const field of DECLARATION_FIELDS) {
            const map = Object.hasOwn(doc, field)
              ? (doc as Record<string, unknown>)[field]
              : undefined;
            if (typeof map === "object" && map !== null && !Array.isArray(map)) {
              for (const name of Object.keys(map)) names.add(name);
            }
          }
        } catch {
          // Unreadable or malformed: declares nothing, so ancestors stay credited (safe direction).
        }
      }
      return out;
    })();
    declaredCaches.set(context, pending);
  }
  return pending;
}

function normaliseProject(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

function isWithin(owner: string, project: string): boolean {
  return project === "." || owner === project || owner.startsWith(`${project}/`);
}

/**
 * Whether a reference in a file owned by `owner` resolves to `name` as
 * declared by `project`. Node and pnpm resolve a bare specifier by walking up
 * node_modules, so a nested project that does not declare `name` itself
 * falls through to the nearest ancestor project that does.
 */
function resolvesTo(
  owner: string,
  project: string,
  name: string,
  declared: Map<string, Set<string>>,
): boolean {
  if (owner === project) return true;
  // Only a real project (one with a package.json) is resolved from nested projects.
  if (!declared.has(project) || !isWithin(owner, project)) return false;
  for (let dir = owner; dir !== project; dir = dirname(dir)) {
    if (declared.get(dir)?.has(name)) return false;
    if (dir === ".") return false;
  }
  return true;
}

/** `@types/foo` -> `foo`, `@types/scope__pkg` -> `@scope/pkg`; undefined for other names. */
function typesTarget(name: string): string | undefined {
  if (!name.startsWith("@types/")) return undefined;
  const bare = name.slice("@types/".length);
  if (!bare) return undefined;
  const i = bare.indexOf("__");
  return i > 0 ? `@${bare.slice(0, i)}/${bare.slice(i + 2)}` : bare;
}

/**
 * Usages of `dependency` from files its declaring project resolves: the
 * project's own files, plus files of nested projects that do not declare the
 * name themselves. `@types/foo` is also used wherever `foo` is referenced,
 * declared or not (e.g. `pnpapi`, provided at runtime by Yarn PnP).
 */
export async function findUsage(context: AdapterContext, dependency: Dependency): Promise<Usage[]> {
  const scan = await scanForContext(context);
  const index = indexFor(scan);
  const project = normaliseProject(dependency.project.path);
  const declared = await declaredFor(context, scan);
  const typed = typesTarget(dependency.name);
  const usages: Usage[] = [];
  for (const target of typed ? [dependency.name, typed] : [dependency.name]) {
    for (const { file, ref } of index.get(target) ?? []) {
      const owner = scan.owner.get(file);
      if (owner === undefined || !resolvesTo(owner, project, dependency.name, declared)) continue;
      const usage: Usage = {
        dependency: dependency.name,
        file,
        line: ref.line,
        form: ref.form,
        symbols: [...new Set(ref.symbols)],
      };
      // Only `import type` / `export type` / `typeof import()` - erased at runtime.
      // A types package is always type-only usage.
      if (ref.typeOnly || target !== dependency.name) usage.typeOnly = true;
      // Named in string text (generated code, resolved paths), not imported.
      if (ref.stringReference) {
        usage.via = "convention";
        usage.symbols = ["string-reference"];
      }
      usages.push(usage);
    }
  }
  return usages.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Nested projects named in one propagated-gap summary; the rest are counted. */
export const MAX_NAMED_GAP_PROJECTS = 10;

/**
 * Limitations relevant to one project: its own (unresolved dynamic imports,
 * skipped or broken files), the bounded shared set for files outside every
 * project, and one summary for nested projects with usage gaps (unresolved
 * imports and unscanned, unreadable or unparsed files, whose requires can
 * fall through to this project's declarations). The summary counts each
 * limitation by kind, so it never calls a skipped file an import gap.
 *
 * Propagation is never capped (#185): any gap in any nested project keeps
 * this project incomplete. Only the reporting is bounded - one summary per
 * ancestor naming at most MAX_NAMED_GAP_PROJECTS projects - instead of one
 * note per gap per nested project.
 */
export async function usageLimitations(
  context: AdapterContext,
  projectPath: string,
): Promise<Evidence[]> {
  const scan = await scanForContext(context);
  const project = normaliseProject(projectPath);
  const out: Evidence[] = [];
  const nested: { root: string; gaps: number }[] = [];
  const byKind = new Map<string, number>();
  for (const [root, list] of scan.byProject) {
    if (list.length === 0) continue;
    if (root === project) {
      out.push(...list);
    } else if (scan.roots.has(project) && isWithin(root, project)) {
      // Upward only: a nested project's gaps reach its ancestors, never siblings or descendants.
      nested.push({ root, gaps: list.length });
      for (const item of list) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    }
  }
  if (nested.length > 0) {
    nested.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    const to = project === "." ? "the root project" : project;
    const named = nested.slice(0, MAX_NAMED_GAP_PROJECTS).map((n) => `${n.root} (${n.gaps})`);
    const more = nested.length - named.length;
    const gaps = nested.reduce((sum, n) => sum + n.gaps, 0);
    const kinds = [...byKind]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([kind, n]) => `${n} ${kind}`)
      .join(", ");
    out.push({
      kind: "nested-project-import-gaps",
      statement:
        `usage gaps in ${nested.length} nested project${nested.length === 1 ? "" : "s"} ` +
        `(${named.join(", ")}${more > 0 ? `, + ${more} more` : ""}; ` +
        `${gaps} limitation${gaps === 1 ? "" : "s"} in total: ${kinds}) ` +
        `can fall through to ${to}`,
      file: `${nested[0]!.root}/package.json`,
    });
  }
  return [...out, ...scan.shared];
}

/** Forms that name a package statically: `import`/`export ... from` and literal `require()`. */
const STATIC_FORMS = new Set<Usage["form"]>(["static", "require"]);

/** Removed-line references by package, parsed once per analysis context. */
const removedCaches = new WeakMap<AdapterContext, Promise<Map<string, IndexEntry[]>>>();

/**
 * Removed-line references (#101, #168, #189). The base version of each
 * changed JS/TS file is rebuilt and parsed whole, so only real
 * import/require statements count: import-like text inside a comment or a
 * template literal never becomes evidence. A statement counts when any of
 * its lines was removed, and is cited at its first line. The diff text is
 * data only: parsed, never evaluated, and already capped by core.
 */
function removedReferences(
  context: AdapterContext,
  changes: readonly SourceLineChanges[],
  scan: RepositoryScan,
): Promise<Map<string, IndexEntry[]>> {
  let pending = removedCaches.get(context);
  if (!pending) {
    pending = (async () => {
      const index = new Map<string, IndexEntry[]>();
      for (const change of changes) {
        const file = change.path.replace(/^\.\//, "");
        if (isSkipped(file) || !scriptKindFor(file) || change.removedLines.length === 0) continue;
        let head: string[] = [];
        try {
          if (await context.repository.exists(file)) {
            const text = await context.repository.readFile(file);
            if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) continue;
            head = text.split(/\r?\n/);
          }
        } catch {
          continue;
        }
        const base = reconstructBase(head, change);
        if (base === undefined) continue;
        const removedLines = new Set(change.removedLines.map((l) => l.line));
        const result = scanSource(file, base.join("\n"));
        await applyAliases(scan.aliases, file, result);
        for (const ref of result.references) {
          if (ref.packageName === undefined || ref.specifier === undefined) continue;
          if (!STATIC_FORMS.has(ref.form) || ref.stringReference) continue;
          let touched = false;
          for (let n = ref.line; n <= (ref.endLine ?? ref.line) && !touched; n++) {
            touched = removedLines.has(n);
          }
          if (!touched) continue;
          const list = index.get(ref.packageName);
          if (list) list.push({ file, ref });
          else index.set(ref.packageName, [{ file, ref }]);
        }
      }
      return index;
    })();
    removedCaches.set(context, pending);
  }
  return pending;
}

/**
 * PR mode only: usages of `dependency` on lines the pull request removed,
 * each marked `removedInPr: true`. Ownership follows the same rules as
 * findUsage (nearest declaring project, falling through to ancestors), using
 * the file's path, which may no longer exist at head.
 */
export async function findRemovedUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const changes = context.pullRequestSourceChanges;
  if (!changes || changes.length === 0) return [];
  const scan = await scanForContext(context);
  const index = await removedReferences(context, changes, scan);
  const entries = index.get(dependency.name);
  if (!entries) return [];
  const project = normaliseProject(dependency.project.path);
  const declared = await declaredFor(context, scan);
  const usages: Usage[] = [];
  for (const { file, ref } of entries) {
    const owner = owningRoot(file, scan.roots);
    if (owner === undefined || !resolvesTo(owner, project, dependency.name, declared)) continue;
    const usage: Usage = {
      dependency: dependency.name,
      file,
      line: ref.line,
      form: ref.form,
      symbols: [...new Set(ref.symbols)],
      removedInPr: true,
    };
    if (ref.typeOnly) usage.typeOnly = true;
    usages.push(usage);
  }
  return usages.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * via="convention" usage for a stylesheet preprocessor when its project (or a
 * nested project that falls through to it) has stylesheets with the matching
 * extension. The files are only listed, never read.
 */
export async function findPreprocessorUsages(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Usage[]> {
  const extensions = Object.keys(PREPROCESSORS).filter((ext) =>
    PREPROCESSORS[ext]!.includes(dependency.name),
  );
  if (extensions.length === 0) return [];
  const scan = await scanForContext(context);
  const project = normaliseProject(dependency.project.path);
  const declared = await declaredFor(context, scan);
  const usages: Usage[] = [];
  for (const [owner, byExt] of scan.styles) {
    if (!resolvesTo(owner, project, dependency.name, declared)) continue;
    for (const ext of extensions) {
      const file = byExt.get(ext);
      if (file === undefined) continue;
      usages.push({
        dependency: dependency.name,
        file,
        line: 1,
        form: "unknown",
        via: "convention",
        symbols: [`${ext} stylesheets`],
      });
    }
  }
  return usages.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Core cuts adapter notes at 300 characters (#205); the base-note statement stays under it. */
const MAX_NOTE_CHARS = 300;

/**
 * One run-level note (#205, lead ruling on #275) when tsconfig/jsconfig
 * `extends` names node_modules bases that were not read (ADR 0004; reading
 * them is #276). Never a limitation: an unknown alias can only make an
 * internal import look like package usage, so it adds usage evidence and
 * never removes it. Names as many packages as fit.
 */
export async function tsconfigBaseNotes(context: AdapterContext): Promise<{ statement: string }[]> {
  const scan = await scanForContext(context);
  const bases = [...scan.aliases.packageBases].sort();
  if (bases.length === 0) return [];
  const text = (shown: number): string => {
    const names = bases.slice(0, shown).join(", ");
    const more = bases.length - shown;
    const list = shown === 0 ? `${bases.length}` : `${names}${more > 0 ? `, + ${more} more` : ""}`;
    return (
      `tsconfig bases from node_modules were not read (${list}); aliases they define are unknown. ` +
      "This can only add usage evidence, never remove it, so no dependency is reported unused because of it. " +
      "Set baseUrl/paths in your own tsconfig so GhostDeps can see them."
    );
  };
  for (let shown = Math.min(bases.length, 5); shown >= 0; shown--) {
    const statement = text(shown);
    if (statement.length <= MAX_NOTE_CHARS) return [{ statement }];
  }
  return [{ statement: text(0) }];
}
