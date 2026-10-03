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

const DOTTED =
  /^[\p{XID_Start}_][\p{XID_Continue}]*(?:\s*\.\s*[\p{XID_Start}_][\p{XID_Continue}]*)*$/u;
const IDENT = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
/** Clause headers that can carry a one-line body: `try: import x`. */
// `case` is a soft keyword, but a statement starting with `case` and a
// top-level colon is a match case (or a harmless annotated variable, whose
// remainder is still scanned). `match` itself cannot have a one-line body.
const HEADER =
  /^(?:try|else|finally|except|if|elif|with|def|class|for|while|async\s+(?:def|with|for)|case)\b/;

/** The clause colon is outside parentheses/brackets/braces, unlike slices and annotations. */
function clauseHeader(text: string): string | undefined {
  if (!HEADER.test(text)) return undefined;
  let depth = 0;
  let lambdas = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ":" && text[i + 1] !== "=" && depth === 0) {
      if (lambdas > 0) lambdas--;
      else return text.slice(0, i + 1);
    } else if (
      depth === 0 &&
      text.startsWith("lambda", i) &&
      !/[\p{XID_Continue}]/u.test(text[i - 1] ?? "") &&
      !/[\p{XID_Continue}]/u.test(text[i + 6] ?? "")
    )
      lambdas++;
  }
  return undefined;
}
/**
 * Names bound at module level to typing.TYPE_CHECKING (`from typing import
 * TYPE_CHECKING as TC`) and to the typing module (`import typing as t`).
 * A rebinding drops the name again, so a shadowed alias is never trusted.
 */
interface TypeCheckingNames {
  flags: Set<string>;
  modules: Set<string>;
}

const escapeRegExp = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a statement binds `name` to something else (assignment, import, def, loop, ...). */
function rebinds(text: string, name: string): boolean {
  const id = `(?<![\\p{XID_Continue}.])${escapeRegExp(name)}(?![\\p{XID_Continue}])`;
  return [
    // TC = x, TC: T = x, TC += x, (TC := x), a, TC = x
    new RegExp(`${id}\\s*(?:,[^=\\n]*)?(?:=(?!=)|:=|[-+*/%&|^@]=|//=|\\*\\*=|<<=|>>=)`, "u"),
    new RegExp(`^${id}\\s*:[^=\\n]*=`, "u"),
    // import x as TC, with y as TC, except E as TC
    new RegExp(`(?<![\\p{XID_Continue}])as\\s+${id}`, "u"),
    // from m import TC, import TC
    new RegExp(`^(?:from\\s+[^\\n]*?\\s+)?import\\b[^\\n]*${id}`, "u"),
    new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${id}`, "u"),
    new RegExp(`^(?:async\\s+)?for\\s+[^\\n]*?${id}[^\\n]*?\\s+in\\b`, "u"),
    new RegExp(`^(?:global|nonlocal|del)\\s[^\\n]*${id}`, "u"),
  ].some((pattern) => pattern.test(text));
}

/** Record bindings made by one statement; only module-level imports add names. */
function updateTypeCheckingNames(
  names: TypeCheckingNames,
  text: string,
  moduleLevel: boolean,
): void {
  for (const set of [names.flags, names.modules]) {
    for (const name of [...set]) if (rebinds(text, name)) set.delete(name);
  }
  if (!moduleLevel) return;
  const from = /^from\s+typing\s+import\s+(.+)$/s.exec(text);
  if (from) {
    for (const part of from[1]!.replace(/[()]/g, " ").split(",")) {
      const m = /^\s*TYPE_CHECKING\s+as\s+([\p{XID_Start}_][\p{XID_Continue}]*)\s*$/su.exec(part);
      if (m) names.flags.add(m[1]!.normalize("NFKC"));
    }
    return;
  }
  const plain = /^import\s+(.+)$/s.exec(text);
  if (plain) {
    for (const part of plain[1]!.split(",")) {
      const m = /^\s*typing\s+as\s+([\p{XID_Start}_][\p{XID_Continue}]*)\s*$/su.exec(part);
      if (m) names.modules.add(m[1]!.normalize("NFKC"));
    }
  }
}

/** Parentheses around the exact guard do not change its runtime value. */
function isTypeCheckingHeader(
  text: string,
  names: TypeCheckingNames,
  moduleScope: boolean,
): boolean {
  const match = /^if\s+(.+)\s*:\s*$/s.exec(text);
  if (!match) return false;
  let condition = match[1]!.trim();
  while (condition.startsWith("(") && condition.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < condition.length; i++) {
      if (condition[i] === "(") depth++;
      else if (condition[i] === ")") depth--;
      if (depth === 0 && i < condition.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps || depth !== 0) break;
    condition = condition.slice(1, -1).trim();
  }
  if (/^(?:typing\s*\.\s*)?TYPE_CHECKING$/.test(condition)) return true;
  // Aliases are only trusted at indent 0: inside a def, lambda or class a
  // parameter or a local binding anywhere in the scope can shadow the name.
  if (!moduleScope) return false;
  if (names.flags.has(condition.normalize("NFKC"))) return true;
  const attribute = /^([\p{XID_Start}_][\p{XID_Continue}]*)\s*\.\s*TYPE_CHECKING$/u.exec(condition);
  return attribute !== null && names.modules.has(attribute[1]!.normalize("NFKC"));
}
const DYNAMIC =
  /(?:\bimportlib\s*\.\s*)?\b(?:import_module|__import__)\s*\(\s*(?:name\s*=\s*)?__S(\d+)__(?=\s*[,)])/g;

const clean = (dotted: string) => dotted.replace(/\s+/g, "");

export const extractPythonImports: PythonImportExtractor = (source) => {
  const { statements, strings, byteStrings } = splitPythonStatements(source);
  const imports: PythonImport[] = [];
  const code: string[] = [];
  let typeCheckingIndent: number | undefined;
  let inlineSuite: { line: number; typeOnly: boolean } | undefined;
  const typeNames: TypeCheckingNames = { flags: new Set(), modules: new Set() };

  for (const stmt of statements) {
    if (typeCheckingIndent !== undefined && stmt.indent <= typeCheckingIndent) {
      typeCheckingIndent = undefined;
    }
    if (isTypeCheckingHeader(stmt.text, typeNames, stmt.indent === 0)) {
      // Keep the outermost guard: ending an inner block does not end it.
      typeCheckingIndent ??= stmt.indent;
      continue;
    }
    if (inlineSuite?.line !== stmt.line) inlineSuite = undefined;
    let typeOnly = typeCheckingIndent !== undefined || (inlineSuite?.typeOnly ?? false);
    let text = stmt.text;
    let conditional = stmt.indent > 0 || inlineSuite !== undefined;
    const header = clauseHeader(text);
    if (header && header.length < text.length) {
      if (isTypeCheckingHeader(header, typeNames, stmt.indent === 0)) typeOnly = true;
      text = text.slice(header.length).trimStart();
      conditional = true;
      inlineSuite = { line: stmt.endLine, typeOnly };
    }
    updateTypeCheckingNames(typeNames, text, !conditional);
    const base = { line: stmt.line, endLine: stmt.endLine, conditional, typeOnly };

    const plain = /^import\s+(.+)$/s.exec(text);
    if (plain) {
      for (const part of plain[1]!.split(",")) {
        const m = /^\s*(.+?)(?:\s+as\s+([\p{XID_Start}_][\p{XID_Continue}]*))?\s*$/su.exec(part);
        if (!m || !DOTTED.test(m[1]!.trim())) continue;
        const module = clean(m[1]!).normalize("NFKC");
        // `import a.b` binds `a`; `import a.b as c` binds `c`.
        const local = (m[2] ?? module.split(".")[0]!).normalize("NFKC");
        imports.push({ module, form: "static", names: [], local, ...base });
      }
      continue;
    }
    const from =
      /^from\s+(\.*)\s*([\p{XID_Start}_][\p{XID_Continue}.\s]*?)?\s+import\s+(.+)$/su.exec(text);
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
        .filter((name) => name === "*" || IDENT.test(name))
        .map((name) => name.normalize("NFKC"));
      imports.push({ module: clean(from[2]).normalize("NFKC"), form: "static", names, ...base });
      continue;
    }
    code.push(text);
    for (const m of text.matchAll(DYNAMIC)) {
      if (byteStrings.has(Number(m[1]))) continue;
      const literal = strings[Number(m[1])] ?? "";
      if (literal === "" || literal.startsWith(".") || /\s/u.test(literal) || !DOTTED.test(literal))
        continue;
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
      /(?<![\p{XID_Continue}.])([\p{XID_Start}_][\p{XID_Continue}]*)\s*\.\s*([\p{XID_Start}_][\p{XID_Continue}]*)/gu,
    )) {
      const local = m[1]!.normalize("NFKC");
      if (!locals.has(local)) continue;
      let set = attributes.get(local);
      if (!set) attributes.set(local, (set = new Set()));
      set.add(m[2]!.normalize("NFKC"));
    }
  }
  return { imports, attributes };
};
