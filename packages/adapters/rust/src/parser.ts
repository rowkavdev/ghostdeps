/**
 * Tree-sitter seam for the rust adapter (#50, decision input #63).
 *
 * The only file that knows about web-tree-sitter. Callers pass a visitor to
 * `withRustTree(text, visit)` and get back whatever it returns; the tree is
 * freed before this returns, so core can later lift this into a shared
 * helper (python/go) without touching call sites.
 *
 * Trees live in WASM memory and are NOT garbage-collected: every parsed
 * tree must be deleted or memory grows with each file (reviewed on #218).
 * The visitor must therefore return plain data, never nodes.
 *
 * Backend: web-tree-sitter (WASM) with the grammar's own .wasm, both
 * exact-pinned; no native build, same behaviour on every OS, and parsing
 * attacker-controlled source stays inside the WASM sandbox.
 */
import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";

export type SyntaxNode = Node;

const require = createRequire(import.meta.url);
let parserPromise: Promise<Parser> | undefined;
let live = 0;

async function load(): Promise<Parser> {
  await Parser.init();
  const language = await Language.load(require.resolve("tree-sitter-rust/tree-sitter-rust.wasm"));
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * Parse Rust source, run `visit` on the root node and free the tree.
 * Undefined when tree-sitter could not produce a tree. `visit` must not
 * keep or return nodes: they are invalid once this resolves.
 */
export async function withRustTree<T>(
  text: string,
  visit: (root: SyntaxNode) => T,
): Promise<T | undefined> {
  parserPromise ??= load();
  const parser = await parserPromise;
  const tree = parser.parse(text);
  if (tree === null) return undefined;
  live++;
  try {
    return visit(tree.rootNode);
  } finally {
    tree.delete();
    live--;
  }
}

/** Trees parsed but not yet freed. Test hook: always 0 between calls. */
export function liveTreeCount(): number {
  return live;
}
