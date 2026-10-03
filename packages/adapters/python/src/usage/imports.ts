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

/** Text left of the last depth-0 assignment operator (all chained targets), or "". */
function assignmentTargets(text: string): string {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "=" && depth === 0 && text[i + 1] !== "=") {
      const prev = text[i - 1] ?? "";
      if ("=!:".includes(prev) && prev !== "") {
        if (prev !== ":") continue;
      }
      if ((prev === "<" || prev === ">") && text[i - 2] !== prev) continue;
      last = i;
    }
  }
  return last < 0 ? "" : text.slice(0, last);
}

/** Whether a statement may bind `name` to something else; errs towards yes. */
function rebinds(text: string, name: string): boolean {
  const id = `(?<![\\p{XID_Continue}.])${escapeRegExp(name)}(?![\\p{XID_Continue}])`;
  const mentions = (part: string) => new RegExp(id, "u").test(part);
  // x = y, (a, TC) = v, [TC] = v, *TC, a = v, TC: T = v, TC += v, type TC = v
  if (mentions(assignmentTargets(text))) return true;
  // (TC := v)
  if (new RegExp(`${id}\\s*:=`, "u").test(text)) return true;
  // import x as TC, with y as TC / as (a, TC), except E as TC, case _ as TC
  const as = /(?<![\p{XID_Continue}])as\b/u.exec(text);
  if (as && mentions(text.slice(as.index))) return true;
  // from m import TC, import TC
  if (/^(?:from\s+[^\n]*?\s+)?import\b/u.test(text) && mentions(text)) return true;
  // from m import *
  if (/^from\s+[^\n]*?\s+import\s+\*/u.test(text)) return true;
  // def TC, class TC, for ... TC ... in, async variants
  if (/^(?:async\s+)?(?:def|class)\s/u.test(text) && mentions(text)) return true;
  const loop = /^(?:async\s+)?for\s+(.*?)\s+in\b/su.exec(text);
  if (loop && mentions(loop[1]!)) return true;
  // match capture patterns
  if (/^case\b/u.test(text) && mentions(text)) return true;
  // global/nonlocal/del
  return /^(?:global|nonlocal|del)\s/u.test(text) && mentions(text);
}

/** Record bindings made by one statement; only module-level imports add names. */
function updateTypeCheckingNames(
  names: TypeCheckingNames,
  fullText: string,
  text: string,
  moduleLevel: boolean,
): void {
  // The full statement still carries a one-line header (`for TC in x: pass`).
  for (const set of [names.flags, names.modules]) {
    for (const name of [...set]) {
      if (rebinds(fullText, name) || rebinds(text, name)) set.delete(name);
    }
  }
  if (!moduleLevel) return;
  // Clauses bind in source order, so the last binding of a name wins.
  const bind = (name: string, flag: boolean, module: boolean) => {
    const bound = name.normalize("NFKC");
    names.flags.delete(bound);
    names.modules.delete(bound);
    if (flag) names.flags.add(bound);
    if (module) names.modules.add(bound);
  };
  const ident = "[\\p{XID_Start}_][\\p{XID_Continue}]*";
  const from = /^from\s+typing\s+import\s+(.+)$/s.exec(text);
  if (from) {
    for (const part of from[1]!.replace(/[()]/g, " ").split(",")) {
      const m = new RegExp(`^\\s*(${ident})(?:\\s+as\\s+(${ident}))?\\s*$`, "su").exec(part);
      if (m) bind(m[2] ?? m[1]!, m[1] === "TYPE_CHECKING", false);
    }
    return;
  }
  const plain = /^import\s+(.+)$/s.exec(text);
  if (plain) {
    for (const part of plain[1]!.split(",")) {
      const m = new RegExp(
        `^\\s*(${ident}(?:\\s*\\.\\s*${ident})*)(?:\\s+as\\s+(${ident}))?\\s*$`,
        "su",
      ).exec(part);
      if (!m) continue;
      if (m[2]) bind(m[2], false, m[1] === "typing");
      else bind(m[1]!.split(".")[0]!.trim(), false, m[1] === "typing");
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
    updateTypeCheckingNames(typeNames, stmt.text, text, !conditional);
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
