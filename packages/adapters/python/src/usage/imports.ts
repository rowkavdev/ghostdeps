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
  text = text.normalize("NFKC");
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
/** Top-level arguments of the call whose "(" is at `open`, or undefined if it never closes. */
function callArguments(text: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args.filter((arg, k) => arg !== "" || k < args.length - 1);
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/**
 * The relative-import level a `__import__` call passes: a number when it is a
 * plain integer literal, undefined when absent or not known statically.
 */
function importLevel(args: string[]): number | undefined {
  let value: string | undefined;
  let positional = 0;
  let starred = false;
  for (const arg of args) {
    const keyword = /^([\p{XID_Start}_][\p{XID_Continue}]*)\s*=(?!=)\s*(.*)$/su.exec(arg);
    if (keyword) {
      if (keyword[1] === "level") value = keyword[2]!;
    } else if (arg.startsWith("*")) {
      starred = true;
    } else {
      if (positional === 4 && !starred) value = arg;
      positional++;
    }
  }
  if (value === undefined) return undefined;
  let literal = value.trim();
  // Parentheses and a unary plus do not change the value. Only literals are read.
  for (;;) {
    if (/^\(.*\)$/s.test(literal)) literal = literal.slice(1, -1).trim();
    else if (literal.startsWith("+")) literal = literal.slice(1).trim();
    else break;
  }
  if (literal === "True") return 1;
  if (literal === "False") return 0;
  if (!/^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*)$/.test(literal)) return undefined;
  return Number(literal.replace(/_/g, ""));
}
const DYNAMIC =
  /(?<![\p{XID_Continue}.])(?<!\.\s*)(?:importlib\s*\.\s*import_module|(?:(?:importlib|builtins|__builtins__)\s*\.\s*)?__import__|import_module)\s*\(\s*(?:name\s*=\s*)?__S(\d+)__(?=\s*[,)])/gu;

/** Whether a lambda in the statement takes `name` as a parameter. */
function bindsAsLambdaParameter(text: string, name: string): boolean {
  const id = new RegExp(
    `(?<![\\p{XID_Continue}.])${escapeRegExp(name)}(?![\\p{XID_Continue}])`,
    "u",
  );
  for (const m of text.normalize("NFKC").matchAll(/(?<![\p{XID_Continue}])lambda\b([^:]*):/gu)) {
    if (id.test(m[1]!)) return true;
  }
  return false;
}

/**
 * Whether a comprehension or generator clause (`for il in items`) binds `name`.
 * Such a target is local to the comprehension, but dropping the alias for the
 * whole scope is the safe side: a missed credit beats a wrong one.
 */
function bindsInComprehension(text: string, name: string): boolean {
  const id = new RegExp(
    `(?<![\\p{XID_Continue}.])${escapeRegExp(name)}(?![\\p{XID_Continue}])`,
    "u",
  );
  const clause = /(?<![\p{XID_Continue}])for\s+(.*?)\s+in\b/gsu;
  for (const m of text.normalize("NFKC").matchAll(clause)) {
    if (id.test(m[1]!)) return true;
  }
  return false;
}

const CONFLICT = "<conflict>";
const NEVER = /(?!)/gu;
const IDENT_SRC = String.raw`[\p{XID_Start}_][\p{XID_Continue}]*`;

interface ImportlibAliases {
  modules: RegExp;
  functions: RegExp;
  targets: Map<string, string>;
}

/**
 * Scope of every statement: 0 is the module; each def or class block opens a
 * new scope. `parent` and `kind` describe the scope tree.
 */
function statementScopes(
  statements: readonly { text: string; indent: number; line: number; endLine: number }[],
): {
  scopeOf: number[];
  parent: number[];
  kind: ("module" | "function" | "class")[];
} {
  const parent = [-1];
  const kind: ("module" | "function" | "class")[] = ["module"];
  const stack: { indent: number; id: number; endLine: number }[] = [];
  const scopeOf: number[] = [];
  for (const stmt of statements) {
    // A `;` continuation on the physical line of a one-line def/class suite
    // (`def f(): pass; import importlib as il`) stays inside that suite.
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const sameLine = stmt.indent === top.indent && stmt.line === top.endLine;
      if (top.indent >= stmt.indent && !sameLine) stack.pop();
      else break;
    }
    const current = stack.length > 0 ? stack[stack.length - 1]!.id : 0;
    scopeOf.push(current);
    const header = /^(?:async\s+)?(def|class)\b/u.exec(stmt.text.normalize("NFKC"));
    if (header) {
      parent.push(current);
      kind.push(header[1] === "class" ? "class" : "function");
      stack.push({ indent: stmt.indent, id: parent.length - 1, endLine: stmt.endLine });
    }
  }
  return { scopeOf, parent, kind };
}

/**
 * Names bound to `importlib` or to its `import_module` / `__import__` by an
 * import alias (`import importlib as il`, `from importlib import import_module
 * as im`). An alias is only visible in the scope that imports it and in the
 * functions nested inside that scope (a class body does not leak into its
 * methods). A name that is also bound by another statement in that scope, or
 * in anything nested in it, is dropped: it may no longer point at importlib,
 * and a missed credit beats a wrong one.
 */
function importlibAliases(
  statements: readonly { text: string; indent: number; line: number; endLine: number }[],
): (index: number) => ImportlibAliases {
  const texts = statements.map((stmt) => stmt.text);
  const { scopeOf, parent, kind } = statementScopes(statements);
  const moduleAlias = new RegExp(String.raw`^\s*importlib\s+as\s+(${IDENT_SRC})\s*$`, "u");
  const functionAlias = new RegExp(
    String.raw`^\s*(import_module|__import__)\s+as\s+(${IDENT_SRC})\s*$`,
    "u",
  );
  // Statement index -> the alias definitions it makes, as [name, import part].
  const defs = new Map<number, { name: string; part: string }[]>();
  const statementParts = (raw: string): { head: string; parts: string[] } | undefined => {
    const text = raw.trim();
    const plain = /^import\s+(.+)$/s.exec(text);
    if (plain) return { head: "import ", parts: plain[1]!.split(",") };
    const from = /^from\s+importlib\s+import\s+(.+)$/s.exec(text);
    if (from)
      return { head: "from importlib import ", parts: from[1]!.replace(/[()]/g, " ").split(",") };
    return undefined;
  };
  // Scope id -> alias name -> "module" or the imported function name.
  const bound = new Map<number, Map<string, string>>();
  texts.forEach((raw, index) => {
    const parsed = statementParts(raw);
    if (!parsed) return;
    for (const part of parsed.parts) {
      const isFrom = parsed.head !== "import ";
      const m = (isFrom ? functionAlias : moduleAlias).exec(part);
      if (!m) continue;
      const name = (isFrom ? m[2]! : m[1]!).normalize("NFKC");
      const scope = scopeOf[index]!;
      const names = bound.get(scope) ?? new Map<string, string>();
      const what = isFrom ? m[1]! : "module";
      // Two imports binding one name to different importlib targets: which one a
      // call reaches depends on order, so the name is not trusted in this scope.
      const earlier = names.get(name);
      names.set(name, earlier !== undefined && earlier !== what ? CONFLICT : what);
      bound.set(scope, names);
      const list = defs.get(index) ?? [];
      list.push({ name, part });
      defs.set(index, list);
    }
  });
  const inside = (scope: number, of: number): boolean => {
    for (let s = scope; s >= 0; s = parent[s]!) if (s === of) return true;
    return false;
  };
  // Identifier -> statements that mention it. A statement can only rebind a
  // name it contains, so each alias checks just those statements instead of
  // rescanning the whole file once per alias (quadratic on many aliases).
  const mentions = new Map<string, number[]>();
  const identifier = /[\p{XID_Start}_][\p{XID_Continue}]*/gu;
  texts.forEach((raw, index) => {
    const seenHere = new Set<string>();
    for (const form of new Set([raw, raw.normalize("NFKC")])) {
      for (const m of form.matchAll(identifier)) seenHere.add(m[0]);
    }
    for (const word of seenHere) {
      const list = mentions.get(word);
      if (list) list.push(index);
      else mentions.set(word, [index]);
    }
  });
  for (const [scope, names] of bound) {
    for (const name of [...names.keys()]) {
      const dropped = (mentions.get(name) ?? []).some((index) => {
        const raw = texts[index]!;
        if (!inside(scopeOf[index]!, scope)) return false;
        const own = defs.get(index)?.filter((d) => d.name === name) ?? [];
        const parsed = statementParts(raw);
        if (own.length > 0 && parsed) {
          const ownParts = new Set(own.map((d) => d.part));
          return parsed.parts.some(
            (part) => !ownParts.has(part) && rebinds(parsed.head + part.trim(), name),
          );
        }
        return (
          rebinds(raw.trim(), name) ||
          bindsAsLambdaParameter(raw, name) ||
          bindsInComprehension(raw, name)
        );
      });
      if (dropped) names.set(name, CONFLICT);
    }
  }
  const lead = String.raw`(?<![\p{XID_Continue}.])(?<!\.\s*)`;
  const tail = String.raw`\s*\(\s*(?:name\s*=\s*)?__S(\d+)__(?=\s*[,)])`;
  const alt = (names: Iterable<string>) =>
    [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const cache = new Map<number, ImportlibAliases>();
  return (index) => {
    const own = scopeOf[index]!;
    const cached = cache.get(own);
    if (cached) return cached;
    const modules = new Set<string>();
    const targets = new Map<string, string>();
    const seen = new Set<string>();
    for (let s = own; s >= 0; s = parent[s]!) {
      // A class body is visible to its own statements only, not to nested defs.
      if (s !== own && kind[s] === "class") continue;
      for (const [name, what] of bound.get(s) ?? []) {
        // The nearest binding of a name wins; outer ones are shadowed.
        if (seen.has(name)) continue;
        seen.add(name);
        if (what === CONFLICT) continue;
        if (what === "module") modules.add(name);
        else targets.set(name, what);
      }
    }
    const result: ImportlibAliases = {
      modules:
        modules.size === 0
          ? NEVER
          : new RegExp(`${lead}(${alt(modules)})\\s*\\.\\s*import_module${tail}`, "gu"),
      functions:
        targets.size === 0 ? NEVER : new RegExp(`${lead}(${alt(targets.keys())})${tail}`, "gu"),
      targets,
    };
    cache.set(own, result);
    return result;
  };
}

const clean = (dotted: string) => dotted.replace(/\s+/g, "");

export const extractPythonImports: PythonImportExtractor = (source) => {
  const { statements, strings, byteStrings } = splitPythonStatements(source);
  const imports: PythonImport[] = [];
  const code: string[] = [];
  let typeCheckingIndent: number | undefined;
  let inlineSuite: { line: number; typeOnly: boolean } | undefined;
  const typeNames: TypeCheckingNames = { flags: new Set(), modules: new Set() };
  const aliasesAt = importlibAliases(statements);

  for (const [statementIndex, stmt] of statements.entries()) {
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
    const aliases = aliasesAt(statementIndex);
    const calls: { index: number; start: number; dunder: boolean }[] = [];
    for (const m of text.matchAll(DYNAMIC)) {
      const callee = m[0].slice(0, m[0].indexOf("(")).trim();
      calls.push({
        index: Number(m[1]),
        start: m.index + m[0].indexOf("("),
        dunder: /__import__$/.test(callee),
      });
    }
    for (const m of text.matchAll(aliases.modules)) {
      calls.push({ index: Number(m[2]), start: m.index + m[0].indexOf("("), dunder: false });
    }
    for (const m of text.matchAll(aliases.functions)) {
      const target = aliases.targets.get(m[1]!.normalize("NFKC"));
      calls.push({
        index: Number(m[2]),
        start: m.index + m[0].indexOf("("),
        dunder: target === "__import__",
      });
    }
    for (const call of calls) {
      if (byteStrings.has(call.index)) continue;
      const literal = strings[call.index] ?? "";
      if (literal === "" || literal.startsWith(".") || /\s/u.test(literal) || !DOTTED.test(literal))
        continue;
      // __import__(name, globals, locals, fromlist, level): a positive level is
      // package-relative, never an external dependency. An unknown level keeps
      // the credit, as before.
      if (call.dunder) {
        const args = callArguments(text, call.start);
        const level = args && importLevel(args);
        if (level !== undefined && level > 0) continue;
      }
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
