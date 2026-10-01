/**
 * Rust usage scanning (#50). For one dependency, find every place its
 * crate name is referenced in the crate's own .rs files:
 *
 * - `use` trees (including `use ::name`, grouped `use {a::X, b}`, `as`)
 * - `extern crate name`
 * - qualified paths in code and types (`name::f()`, `name::T`)
 * - macro paths (`name::m!`) and paths inside macro arguments and
 *   attributes (`#[derive(name::X)]`, `format!("{}", name::f())`)
 *
 * The crate name is the manifest key (so renames count) with `-` -> `_`.
 * Results are facts with file/line; the adapter does not declare
 * referenceAnalysis, so "no usages" is never read as "unused" (#121).
 * Source is text: nothing is compiled, expanded or executed.
 */
import {
  MAX_FILE_READ_BYTES,
  hasExcludedSegment,
  type AdapterContext,
  type Dependency,
  type Evidence,
  type Usage,
} from "@ghostdeps/core";
import { isTable, readManifest } from "./cargo-toml.js";
import { discoverCrates, isManifestPath, type Discovery } from "./discover.js";
import { withRustTree, type SyntaxNode } from "./parser.js";
import { dirOf } from "./paths.js";
import { findRemovedUsages } from "./removed.js";

const PATH_ROOT_EXCLUDED = new Set(["crate", "self", "super", "Self", "std", "core", "alloc"]);

/** Every crate-root identifier referenced in a file, with 1-based line and the next segment. */
export interface CrateReference {
  crate: string;
  line: number;
  /**
   * Line span of the enclosing `use` / `extern crate` statement when it
   * covers more than one line, so PR mode can tell a removed multi-line
   * use tree apart from an untouched one (#249).
   */
  statement?: { start: number; end: number };
  symbol?: string;
}

function leftmost(node: SyntaxNode): { root?: SyntaxNode; next?: string } {
  // scoped_identifier / scoped_type_identifier: path is the left part.
  let current: SyntaxNode = node;
  let next: string | undefined;
  for (;;) {
    const path = current.childForFieldName("path");
    const name = current.childForFieldName("name");
    if (path === null) {
      // A leading :: path has a scoped node with no path field and its
      // actual root identifier in name; keep the following segment.
      const root =
        current.type === "identifier"
          ? current
          : current.type === "scoped_identifier" && name?.type === "identifier"
            ? name
            : undefined;
      return root ? { root, ...(next ? { next } : {}) } : {};
    }
    if (name !== null) next = name.text;
    current = path;
  }
}

function useTreeRoots(node: SyntaxNode, out: SyntaxNode[]): void {
  switch (node.type) {
    case "identifier":
      out.push(node);
      return;
    case "scoped_identifier":
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      if (path === null) {
        // `use ::name::..` or `use ::{..}`: the root is in the name/list.
        const inner = node.childForFieldName("name") ?? node.childForFieldName("list");
        if (inner !== null) useTreeRoots(inner, out);
        return;
      }
      const { root } = path.type === "identifier" ? { root: path } : leftmost(path);
      if (root !== undefined) out.push(root);
      return;
    }
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      if (path !== null) useTreeRoots(path, out);
      return;
    }
    case "use_wildcard":
    case "use_list":
      for (const child of node.namedChildren) if (child !== null) useTreeRoots(child, out);
      return;
    default:
      return;
  }
}

function tokenTreeRoots(node: SyntaxNode): { root: SyntaxNode; symbol?: string }[] {
  const roots: { root: SyntaxNode; symbol?: string }[] = [];
  const children = node.children.filter((c): c is SyntaxNode => c !== null);
  for (let i = 0; i < children.length - 1; i++) {
    const c = children[i]!;
    const prev = children[i - 1];
    const beforeColon = children[i - 2];
    const absoluteRoot =
      prev?.type === "::" &&
      !["identifier", "crate", "self", "super", ">", "metavariable"].includes(
        beforeColon?.type ?? "",
      );
    if (
      c.type === "identifier" &&
      children[i + 1]!.type === "::" &&
      (prev?.type !== "::" || absoluteRoot)
    ) {
      const after = children[i + 2];
      roots.push({ root: c, ...(after?.type === "identifier" ? { symbol: after.text } : {}) });
    }
  }
  return roots;
}

/** Collect crate-root references from a parsed file. */
export function collectReferences(root: SyntaxNode): CrateReference[] {
  const refs: CrateReference[] = [];
  const push = (node: SyntaxNode, symbol?: string, statement?: SyntaxNode) => {
    const name = node.text.replace(/^r#/, "");
    if (PATH_ROOT_EXCLUDED.has(name)) return;
    const ref: CrateReference = { crate: name, line: node.startPosition.row + 1 };
    if (symbol) ref.symbol = symbol;
    if (statement !== undefined && statement.endPosition.row > statement.startPosition.row) {
      ref.statement = {
        start: statement.startPosition.row + 1,
        end: statement.endPosition.row + 1,
      };
    }
    refs.push(ref);
  };
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "use_declaration": {
        const argument = node.childForFieldName("argument");
        const roots: SyntaxNode[] = [];
        if (argument !== null) useTreeRoots(argument, roots);
        for (const r of roots) push(r, undefined, node);
        continue; // nothing further inside a use tree
      }
      case "extern_crate_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) push(name, undefined, node);
        continue;
      }
      case "scoped_identifier":
      case "scoped_type_identifier": {
        const { root: r, next } = leftmost(node);
        if (r !== undefined) push(r, next);
        break;
      }
      case "token_tree": {
        // Macro arguments and attribute bodies are unparsed tokens:
        // `ident :: ...` where the ident is not itself after `::`.
        for (const { root, symbol } of tokenTreeRoots(node)) push(root, symbol);
        break;
      }
      default:
        break;
    }
    for (const child of node.children) if (child !== null) stack.push(child);
  }
  return refs;
}

// The same AdapterContext spans one scan. Cache the promise so concurrent
// inherited-dependency lookups share discovery; nothing survives the run.
const workspaceDiscoveries = new WeakMap<AdapterContext, Promise<Discovery>>();

function workspaceDiscovery(context: AdapterContext): Promise<Discovery> {
  let discovery = workspaceDiscoveries.get(context);
  if (discovery === undefined) {
    discovery = discoverCrates(context);
    workspaceDiscoveries.set(context, discovery);
  }
  return discovery;
}

async function inheritedDependencyTable(
  context: AdapterContext,
  manifestPath: string,
  tables: unknown[],
): Promise<Record<string, unknown> | undefined> {
  // Workspace aliases live in the root, not in the member's inherited entry.
  // Only discover the workspace when one of this member's entries inherits.
  const needsWorkspace = tables.some(
    (table) =>
      isTable(table) &&
      Object.values(table).some((entry) => isTable(entry) && entry.workspace === true),
  );
  let inherited: Record<string, unknown> | undefined;
  if (needsWorkspace) {
    const { crates } = await workspaceDiscovery(context);
    const workspace = crates.find((item) => item.manifest.path === manifestPath)?.workspaceRoot
      ?.document?.workspace;
    if (isTable(workspace) && isTable(workspace.dependencies)) inherited = workspace.dependencies;
  }
  return inherited;
}

/** The manifest key(s) a dependency is declared under, normalised to the Rust crate name. */
export async function crateNames(
  context: AdapterContext,
  dependency: Dependency,
): Promise<Set<string>> {
  const names = new Set<string>();
  const manifest = await readManifest(context.repository, dependency.declaredIn);
  const doc = manifest.document;
  const tables: unknown[] = [];
  if (doc !== undefined) {
    tables.push(
      doc.dependencies,
      doc["dev-dependencies"],
      doc.dev_dependencies,
      doc["build-dependencies"],
      doc.build_dependencies,
    );
    if (isTable(doc.target)) {
      for (const spec of Object.values(doc.target)) {
        if (isTable(spec)) {
          tables.push(
            spec.dependencies,
            spec["dev-dependencies"],
            spec.dev_dependencies,
            spec["build-dependencies"],
            spec.build_dependencies,
          );
        }
      }
    }
  }
  const inherited = await inheritedDependencyTable(context, dependency.declaredIn, tables);
  for (const table of tables) {
    if (!isTable(table)) continue;
    for (const [key, value] of Object.entries(table)) {
      const resolved = isTable(value) && value.workspace === true ? inherited?.[key] : value;
      const pkg =
        isTable(resolved) && typeof resolved.package === "string" ? resolved.package : key;
      if (pkg === dependency.name) names.add(key.replace(/-/g, "_"));
    }
  }
  // Unreadable manifest: fall back to the package name.
  if (names.size === 0) names.add(dependency.name.replace(/-/g, "_"));
  return names;
}

/** .rs files owned by a crate root: under it and not under a nested crate. */
export function ownedSources(files: string[], root: string): string[] {
  const nested = files
    .filter(isManifestPath)
    .map(dirOf)
    .filter((d) => d !== root && (root === "." || d.startsWith(`${root}/`)));
  return files.filter((f) => {
    if (!f.endsWith(".rs") || hasExcludedSegment(f)) return false;
    if (root !== "." && !f.startsWith(`${root}/`)) return false;
    return !nested.some((d) => (d === "." ? true : f.startsWith(`${d}/`)));
  });
}

/** One scanned .rs file: its crate references, and whether tree-sitter hit syntax errors. */
interface FileScan {
  refs: CrateReference[];
  /** True when the parse tree has errors; refs may be missing (#291). */
  parseError: boolean;
}

const cache = new WeakMap<AdapterContext, Map<string, Promise<FileScan | undefined>>>();

async function scanFile(context: AdapterContext, file: string): Promise<FileScan | undefined> {
  let perContext = cache.get(context);
  if (perContext === undefined) {
    perContext = new Map();
    cache.set(context, perContext);
  }
  let pending = perContext.get(file);
  if (pending === undefined) {
    pending = (async () => {
      let text: string;
      try {
        text = await context.repository.readFile(file);
      } catch {
        return undefined;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_READ_BYTES) return undefined;
      return withRustTree(text, (root) => ({
        refs: collectReferences(root),
        parseError: root.hasError,
      }));
    })();
    perContext.set(file, pending);
  }
  return pending;
}

/**
 * Parse-error limitations for one crate (#291), one per owned .rs file with
 * syntax errors, in the same shape as the js adapter's `parse-error`
 * limitations. Surfaced today as a run note (adapter notes()); kept
 * per project so it can gate referenceAnalysisComplete if the adapter
 * ever declares referenceAnalysis. Scans are cached, so this reuses the
 * work findUsage already did.
 */
export async function parseErrorLimitations(
  context: AdapterContext,
  projectPath: string,
): Promise<Evidence[]> {
  const files = await context.repository.listFiles();
  const out: Evidence[] = [];
  for (const file of ownedSources(files, projectPath)) {
    context.signal?.throwIfAborted();
    const scan = await scanFile(context, file);
    if (scan?.parseError) {
      out.push({
        kind: "parse-error",
        statement: `${file} has syntax errors; usages found may be incomplete`,
        file,
      });
    }
  }
  return out;
}

/** Head usages plus, in PR mode, usages on lines the pull request removed (#249). */
export async function findUsage(context: AdapterContext, dependency: Dependency): Promise<Usage[]> {
  const [head, removed] = await Promise.all([
    findHeadUsage(context, dependency),
    findRemovedUsages(context, dependency),
  ]);
  return [...head, ...removed];
}

async function findHeadUsage(context: AdapterContext, dependency: Dependency): Promise<Usage[]> {
  const names = await crateNames(context, dependency);
  const files = await context.repository.listFiles();
  const usages: Usage[] = [];
  const seen = new Set<string>();
  for (const file of ownedSources(files, dependency.project.path)) {
    context.signal?.throwIfAborted();
    const scan = await scanFile(context, file);
    if (scan === undefined) continue;
    for (const ref of scan.refs) {
      if (!names.has(ref.crate)) continue;
      const k = `${file}:${ref.line}:${ref.symbol ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      usages.push({
        dependency: dependency.name,
        file,
        line: ref.line,
        form: "static",
        symbols: ref.symbol ? [ref.symbol] : [],
      });
    }
  }
  return usages;
}
