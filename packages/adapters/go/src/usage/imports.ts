/**
 * Import declarations and package-qualified selectors from one Go file.
 */
import { lexGo, type GoToken } from "./lexer.js";

export interface GoImport {
  path: string;
  /** Explicit name: an identifier, "_" (blank) or "." (dot). */
  alias?: string;
  line: number;
}

export interface GoFileImports {
  imports: GoImport[];
  /** Local package name -> selector names used as name.Selector. */
  selectors: Map<string, Set<string>>;
}

/** Backend seam: the lexer today, tree-sitter later if needed. */
export type GoImportExtractor = (source: string) => GoFileImports;

export const extractGoImports: GoImportExtractor = (source) => {
  const tokens = lexGo(source).filter((t, i, all) => !(t.text === ";" && all[i - 1]?.text === ";"));
  const imports: GoImport[] = [];
  let i = 0;
  const at = (k: number): GoToken | undefined => tokens[k];
  const skipSemis = () => {
    while (at(i)?.text === ";") i++;
  };

  skipSemis();
  if (at(i)?.text !== "package") return { imports, selectors: new Map() };
  i += 2;
  skipSemis();

  const spec = (): boolean => {
    let alias: string | undefined;
    const t = at(i);
    if (t && (t.kind === "ident" || t.text === ".") && at(i + 1)?.kind === "string") {
      alias = t.text;
      i++;
    }
    const s = at(i);
    if (s?.kind !== "string") return false;
    imports.push({ path: s.text, line: s.line, ...(alias !== undefined ? { alias } : {}) });
    i++;
    return true;
  };

  while (at(i)?.text === "import") {
    i++;
    if (at(i)?.text === "(") {
      i++;
      for (;;) {
        skipSemis();
        const t = at(i);
        if (!t || t.text === ")") break;
        if (!spec()) {
          i++;
          continue;
        }
      }
      i++;
    } else {
      spec();
    }
    skipSemis();
  }

  // name.Selector anywhere after the imports, unless it is itself a field
  // access (x.name.Selector).
  const selectors = new Map<string, Set<string>>();
  for (let k = i; k + 2 < tokens.length; k++) {
    const a = tokens[k]!;
    if (a.kind !== "ident" || tokens[k + 1]!.text !== "." || tokens[k + 2]!.kind !== "ident") {
      continue;
    }
    if (tokens[k - 1]?.text === ".") continue;
    let set = selectors.get(a.text);
    if (!set) selectors.set(a.text, (set = new Set()));
    set.add(tokens[k + 2]!.text);
  }
  return { imports, selectors };
};

/**
 * Best guess at the package name an unaliased import binds. Go takes it
 * from the package clause of the imported code, which is not available,
 * so common conventions apply: a /vN major suffix is skipped, gopkg.in's
 * ".vN" is dropped, and a "go-" prefix or "-go" suffix is removed.
 */
export function defaultPackageName(importPath: string): string {
  const parts = importPath.split("/");
  let last = parts[parts.length - 1] ?? importPath;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2]!;
  last = last.replace(/\.v\d+$/, "");
  last = last.replace(/^go-/, "").replace(/-go$/, "");
  return last.replace(/[^\p{L}\p{Nd}_]/gu, "_");
}
