/**
 * Import extraction for one Python file (#261). Backend seam: this
 * statement scanner today; a tree-sitter-python extractor can replace it
 * behind PythonImportExtractor without touching scan.ts (per-adapter seam
 * ruling). Relative imports (`from . import x`) are first-party and never
 * reported.
 */
import { splitPythonStatements } from "./lexer.js";

export interface PythonImport {
  /** Absolute dotted module path as written, e.g. "google.protobuf.message". */
  module: string;
  line: number;
  /** Last line of the import statement (multi-line `from m import (...)`). */
  endLine: number;
  /** "static" for import statements, "dynamic" for importlib/__import__ literals. */
  form: "static" | "dynamic";
  /** Names imported with `from m import a, b` ("*" for star imports). */
  names: string[];
  /** Local binding of `import m` / `import m.sub as alias`, when there is one. */
  local?: string;
  /** Inside an indented block (try/except fallbacks, functions, platform checks). */
  conditional: boolean;
  /** Inside an `if TYPE_CHECKING:` block. */
  typeOnly: boolean;
}

export interface PythonFileImports {
  imports: PythonImport[];
  /** Local name -> attributes accessed as name.attr outside import statements. */
  attributes: Map<string, Set<string>>;
}

export type PythonImportExtractor = (source: string) => PythonFileImports;

const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Clause headers that can carry a one-line body: `try: import x`. */
const HEADER =
  /^(?:try|else|finally|except\b[^:]*|if\b[^:]*|elif\b[^:]*|with\b[^:]*|def\b[^:]*|class\b[^:]*)\s*:\s*/;
const TYPE_CHECKING_IF = /^if\s+(?:typing\s*\.\s*)?TYPE_CHECKING\s*:\s*$/;
const DYNAMIC = /(?:\bimportlib\s*\.\s*)?\b(?:import_module|__import__)\s*\(\s*__S(\d+)__/g;

const clean = (dotted: string) => dotted.replace(/\s+/g, "");

export const extractPythonImports: PythonImportExtractor = (source) => {
  const { statements, strings } = splitPythonStatements(source);
  const imports: PythonImport[] = [];
  const code: string[] = [];
  let typeCheckingIndent: number | undefined;

  for (const stmt of statements) {
    if (typeCheckingIndent !== undefined && stmt.indent <= typeCheckingIndent) {
      typeCheckingIndent = undefined;
    }
    if (TYPE_CHECKING_IF.test(stmt.text)) {
      typeCheckingIndent = stmt.indent;
      continue;
    }
    const typeOnly = typeCheckingIndent !== undefined;
    let text = stmt.text;
    let conditional = stmt.indent > 0;
    const header = HEADER.exec(text);
    if (header && header[0].length < text.length) {
      text = text.slice(header[0].length);
      conditional = true;
    }
    const base = { line: stmt.line, endLine: stmt.endLine, conditional, typeOnly };

    const plain = /^import\s+(.+)$/s.exec(text);
    if (plain) {
      for (const part of plain[1]!.split(",")) {
        const m = /^\s*(.+?)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*$/s.exec(part);
        if (!m || !DOTTED.test(m[1]!.trim())) continue;
        const module = clean(m[1]!);
        // `import a.b` binds `a`; `import a.b as c` binds `c`.
        const local = m[2] ?? module.split(".")[0]!;
        imports.push({ module, form: "static", names: [], local, ...base });
      }
      continue;
    }
    const from = /^from\s+(\.*)\s*([A-Za-z_][A-Za-z0-9_.\s]*?)?\s+import\s+(.+)$/s.exec(text);
    if (from) {
      if (from[1] !== "" || from[2] === undefined || !DOTTED.test(from[2].trim())) continue;
      const names = from[3]!
        .replace(/[()]/g, " ")
        .split(",")
        .map((part) =>
          part
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim(),
        )
        .filter((name) => name === "*" || IDENT.test(name));
      imports.push({ module: clean(from[2]), form: "static", names, ...base });
      continue;
    }
    code.push(text);
    for (const m of text.matchAll(DYNAMIC)) {
      const literal = strings[Number(m[1])]?.trim() ?? "";
      if (literal === "" || literal.startsWith(".") || !DOTTED.test(literal)) continue;
      imports.push({ module: literal, form: "dynamic", names: [], ...base });
    }
  }

  const locals = new Set(
    imports.map((imp) => imp.local).filter((l): l is string => l !== undefined),
  );
  const attributes = new Map<string, Set<string>>();
  if (locals.size > 0) {
    const body = code.join("\n");
    for (const m of body.matchAll(
      /(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      if (!locals.has(m[1]!)) continue;
      let set = attributes.get(m[1]!);
      if (!set) attributes.set(m[1]!, (set = new Set()));
      set.add(m[2]!);
    }
  }
  return { imports, attributes };
};
