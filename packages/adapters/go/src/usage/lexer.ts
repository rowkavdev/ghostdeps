/**
 * Minimal Go lexer for import extraction (#53). Hand-written on purpose:
 * the arch lead chose it over web-tree-sitter on 2026-09-24 (recorded in
 * #231; #63 has the tree-sitter findings). Go's import syntax is small and regular, and a
 * lexer needs no native build or WASM. It sits behind GoImportExtractor so
 * a tree-sitter backend can replace it later.
 *
 * It only needs to be right about token boundaries: comments, interpreted
 * and raw strings, and rune literals are consumed whole, so text inside
 * them is never mistaken for code.
 */

export type TokenKind = "ident" | "string" | "punct" | "other";

export interface GoToken {
  kind: TokenKind;
  /** For strings: the decoded value without quotes. */
  text: string;
  line: number;
}

const isIdentStart = (c: string) => /[\p{L}_]/u.test(c);
const isIdentPart = (c: string) => /[\p{L}\p{Nd}_]/u.test(c);

export function lexGo(src: string): GoToken[] {
  const out: GoToken[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      // Automatic semicolons matter for import blocks only as separators;
      // emit one so `import "a"\nfunc` splits cleanly.
      out.push({ kind: "punct", text: ";", line });
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      const start = line;
      let j = i + 1;
      let value = "";
      while (j < n && src[j] !== '"' && src[j] !== "\n") {
        if (src[j] === "\\" && j + 1 < n) {
          value += src[j + 1];
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      out.push({ kind: "string", text: value, line: start });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const start = line;
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\n") line++;
        j++;
      }
      out.push({ kind: "string", text: src.slice(i + 1, j), line: start });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'" && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out.push({ kind: "other", text: "'", line });
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j]!)) j++;
      out.push({ kind: "ident", text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if ("(){}[];,.=".includes(c)) {
      out.push({ kind: "punct", text: c, line });
      i++;
      continue;
    }
    out.push({ kind: "other", text: c, line });
    i++;
  }
  return out;
}
