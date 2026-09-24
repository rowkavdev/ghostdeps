/**
 * Declaration lines for Python manifests (#280). Core keeps an adapter's
 * declaredLine only if that manifest line names the dependency (#198): as a
 * whole token, or for python as a name-like token that is the same package
 * under PEP 503 (#286, #307). A line is offered only when the written text
 * passes the same check, so "PyYAML>=6" and "typing_extensions" now get
 * their lines for "pyyaml" / "typing-extensions".
 */

/**
 * Lines longer than this get no declaredLine. Every declaration on one
 * line would otherwise rescan that line (quadratic on a hostile one-line
 * manifest); real declaration lines are short.
 */
export const MAX_DECLARATION_LINE_CHARS = 4096;

const BEFORE_NAME = /[A-Za-z0-9._/@-]/;
const AFTER_NAME = /[A-Za-z0-9._/-]/;

/** PEP 503 normalised name: lowercase, runs of `-`, `_` and `.` become one `-`. */
export const pep503 = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Name-like tokens, as core splits a line for the PEP 503 check (#307). */
const NAME_TOKENS = /[A-Za-z0-9._-]+/g;

/**
 * Mirrors core's verifyDeclaredLines test for python. First the exact
 * token test: `name` appears with no name character right before it
 * (letters, digits, . _ / @ -) or right after it (the same minus @); done
 * with indexOf, not a RegExp built per dependency, because it runs once per
 * declaration on untrusted manifests. Failing that, some name-like token on
 * the line is `name` under PEP 503 (#286): `PyYAML` for "pyyaml",
 * `typing_extensions` for "typing-extensions", but never `pyyaml-include`
 * for "pyyaml".
 */
export function lineNamesDependency(lineText: string, name: string): boolean {
  if (name.length === 0 || lineText.length > MAX_DECLARATION_LINE_CHARS) return false;
  for (let at = lineText.indexOf(name); at !== -1; at = lineText.indexOf(name, at + 1)) {
    const before = at === 0 ? "" : lineText[at - 1]!;
    const after = lineText[at + name.length] ?? "";
    if (!BEFORE_NAME.test(before) && !AFTER_NAME.test(after)) return true;
  }
  const wanted = pep503(name);
  for (const token of lineText.match(NAME_TOKENS) ?? []) {
    if (pep503(token) === wanted) return true;
  }
  return false;
}

/** Leading distribution-name token of a PEP 508 string, as written. */
const LEADING_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;
const slot = (...parts: string[]): string => parts.join("\0");

const unquote = (part: string): string => part.trim().replace(/^(["'])(.*)\1$/, "$2");
const sectionOf = (header: string): string => header.split(".").map(unquote).join(".");

/**
 * A line index over pyproject.toml text: which table and top-level key each
 * string literal and key sits under. Deliberately small: it handles the
 * shapes dependency tables use (arrays of strings, `name = ...` keys). Multi-line strings are skipped; anything it
 * cannot place simply gets no line, never a wrong one that core would keep,
 * because every returned line is also name-checked.
 */
export class PyprojectLines {
  /** section, key, leading name -> first line (each lookup is O(1)). */
  private readonly strings = new Map<string, number>();
  /** section, key -> first line. */
  private readonly keys = new Map<string, number>();
  private readonly lines: string[];

  constructor(text: string) {
    this.lines = text.split(/\r?\n/);
    let section = "";
    let key: string | undefined;
    let depth = 0;
    let inMultiline: string | undefined;
    this.lines.forEach((raw, index) => {
      const line = index + 1;
      if (inMultiline !== undefined) {
        if (raw.includes(inMultiline)) inMultiline = undefined;
        return;
      }
      if (depth === 0) {
        const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(raw);
        if (header) {
          section = sectionOf(header[1]!);
          key = undefined;
          return;
        }
        const assign = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=/.exec(raw);
        if (assign) {
          key = unquote(assign[1]!);
          const at = slot(section, key);
          if (!this.keys.has(at)) this.keys.set(at, line);
        }
      }
      // Walk the line: string literals and bracket depth, comments ignored.
      for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i]!;
        if (ch === "#") break;
        if (ch === '"' || ch === "'") {
          const triple = raw.startsWith(ch.repeat(3), i);
          if (triple) {
            const close = raw.indexOf(ch.repeat(3), i + 3);
            if (close === -1) {
              inMultiline = ch.repeat(3);
              break;
            }
            i = close + 2;
            continue;
          }
          let j = i + 1;
          let value = "";
          while (j < raw.length && raw[j] !== ch) {
            if (ch === '"' && raw[j] === "\\" && j + 1 < raw.length) {
              value += raw[j + 1];
              j += 2;
              continue;
            }
            value += raw[j];
            j += 1;
          }
          const name = depth > 0 && key !== undefined ? LEADING_NAME.exec(value)?.[1] : undefined;
          if (name !== undefined) {
            const at = slot(section, key!, name);
            if (!this.strings.has(at)) this.strings.set(at, line);
          }
          i = j;
          continue;
        }
        if (ch === "[" || ch === "{") depth += 1;
        else if ((ch === "]" || ch === "}") && depth > 0) depth -= 1;
      }
    });
  }

  private checked(line: number | undefined, name: string): number | undefined {
    if (line === undefined) return undefined;
    return lineNamesDependency(this.lines[line - 1] ?? "", name) ? line : undefined;
  }

  /** Line of a PEP 508 string for `rawName` in `section`'s array `key`. */
  pep508(section: string, key: string, rawName: string, name: string): number | undefined {
    return this.checked(this.strings.get(slot(section, key, rawName)), name);
  }

  /**
   * Line of a `rawName = ...` key in `section`. A `[section.rawName]`
   * sub-table header is not offered: core's token test rejects a name
   * that follows ".".
   */
  tableKey(section: string, rawName: string, name: string): number | undefined {
    return this.checked(this.keys.get(slot(section, rawName)), name);
  }
}
