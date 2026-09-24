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
  type Usage,
} from "@ghostdeps/core";
import { isTable, readManifest } from "./cargo-toml.js";
import { isManifestPath } from "./discover.js";
import { withRustTree, type SyntaxNode } from "./parser.js";
import { dirOf } from "./paths.js";

const PATH_ROOT_EXCLUDED = new Set(["crate", "self", "super", "Self", "std", "core", "alloc"]);

/** Every crate-root identifier referenced in a file, with 1-based line and the next segment. */
export interface CrateReference {
  crate: string;
  line: number;
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
      return current.type === "identifier" ? { root: current, ...(next ? { next } : {}) } : {};
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

/** Collect crate-root references from a parsed file. */
export function collectReferences(root: SyntaxNode): CrateReference[] {
  const refs: CrateReference[] = [];
  const push = (node: SyntaxNode, symbol?: string) => {
    if (PATH_ROOT_EXCLUDED.has(node.text)) return;
    refs.push({
      crate: node.text,
      line: node.startPosition.row + 1,
      ...(symbol ? { symbol } : {}),
    });
  };
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "use_declaration": {
        const argument = node.childForFieldName("argument");
        const roots: SyntaxNode[] = [];
        if (argument !== null) useTreeRoots(argument, roots);
        for (const r of roots) push(r);
        continue; // nothing further inside a use tree
      }
      case "extern_crate_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) push(name);
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
        const children = node.children.filter((c): c is SyntaxNode => c !== null);
        for (let i = 0; i < children.length - 1; i++) {
          const c = children[i]!;
          const prev = i > 0 ? children[i - 1] : undefined;
          if (c.type === "identifier" && children[i + 1]!.type === "::" && prev?.type !== "::") {
            const after = children[i + 2];
            push(c, after?.type === "identifier" ? after.text : undefined);
          }
        }
        break;
      }
      default:
        break;
    }
    for (const child of node.children) if (child !== null) stack.push(child);
  }
  return refs;
}

/** The manifest key(s) a dependency is declared under, normalised to the Rust crate name. */
async function crateNames(context: AdapterContext, dependency: Dependency): Promise<Set<string>> {
  const names = new Set<string>();
  const manifest = await readManifest(context.repository, dependency.declaredIn);
  const doc = manifest.document;
  const tables: unknown[] = [];
  if (doc !== undefined) {
    tables.push(doc.dependencies, doc["dev-dependencies"], doc["build-dependencies"]);
    if (isTable(doc.target)) {
      for (const spec of Object.values(doc.target)) {
        if (isTable(spec)) {
          tables.push(spec.dependencies, spec["dev-dependencies"], spec["build-dependencies"]);
        }
      }
    }
  }
  for (const table of tables) {
    if (!isTable(table)) continue;
    for (const [key, value] of Object.entries(table)) {
      const pkg = isTable(value) && typeof value.package === "string" ? value.package : key;
      if (pkg === dependency.name) names.add(key.replace(/-/g, "_"));
    }
  }
  // Unreadable manifest: fall back to the package name.
  if (names.size === 0) names.add(dependency.name.replace(/-/g, "_"));
  return names;
}

/** .rs files owned by a crate root: under it and not under a nested crate. */
function ownedSources(files: string[], root: string): string[] {
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

const cache = new WeakMap<AdapterContext, Map<string, Promise<CrateReference[] | undefined>>>();

async function referencesIn(
  context: AdapterContext,
  file: string,
): Promise<CrateReference[] | undefined> {
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
      return withRustTree(text, collectReferences);
    })();
    perContext.set(file, pending);
  }
  return pending;
}

export async function findUsage(context: AdapterContext, dependency: Dependency): Promise<Usage[]> {
  const names = await crateNames(context, dependency);
  const files = await context.repository.listFiles();
  const usages: Usage[] = [];
  const seen = new Set<string>();
  for (const file of ownedSources(files, dependency.project.path)) {
    context.signal?.throwIfAborted();
    const refs = await referencesIn(context, file);
    if (refs === undefined) continue;
    for (const ref of refs) {
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
