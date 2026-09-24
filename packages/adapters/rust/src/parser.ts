/**
 * Tree-sitter seam for the rust adapter (#50, decision input #63).
 *
 * The only file that knows about web-tree-sitter. Everything else calls
 * `parseRust(text)` and walks the returned node type, so core can later lift
 * this into a shared helper (python/go) without touching call sites.
 * Backend: web-tree-sitter (WASM) with the grammar's own .wasm, both
 * exact-pinned; no native build, same behaviour on every OS, and parsing
 * attacker-controlled source stays inside the WASM sandbox.
 */
import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";

export type SyntaxNode = Node;

const require = createRequire(import.meta.url);
let parserPromise: Promise<Parser> | undefined;

async function load(): Promise<Parser> {
  await Parser.init();
  const language = await Language.load(require.resolve("tree-sitter-rust/tree-sitter-rust.wasm"));
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** Parse Rust source. Undefined when tree-sitter could not produce a tree. */
export async function parseRust(text: string): Promise<SyntaxNode | undefined> {
  parserPromise ??= load();
  const parser = await parserPromise;
  const tree = parser.parse(text);
  return tree?.rootNode ?? undefined;
}
