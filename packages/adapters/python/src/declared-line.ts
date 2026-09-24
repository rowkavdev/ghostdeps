/**
 * Declaration lines for Python manifests (#280). Core keeps an adapter's
 * declaredLine only if that manifest line contains the dependency name as a
 * whole token (#198), so a line is offered only when the written text passes
 * the same check: "PyYAML" or "typing_extensions" as written do not contain
 * the normalised names "pyyaml" / "typing-extensions", and get no line.
 */

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mirrors core's verifyDeclaredLines token test. */
export function lineNamesDependency(lineText: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9._/@-])${escape(name)}([^A-Za-z0-9._/-]|$)`).test(lineText);
}

interface StringAt {
  section: string;
  key: string | undefined;
  value: string;
  line: number;
}

interface KeyAt {
  section: string;
  key: string;
  line: number;
}

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
  private readonly strings: StringAt[] = [];
  private readonly keys: KeyAt[] = [];
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
          this.keys.push({ section, key, line });
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
          if (depth > 0) this.strings.push({ section, key, value, line });
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
    const head = new RegExp(`^\\s*${escape(rawName)}(?![A-Za-z0-9._-])`);
    const hit = this.strings.find(
      (s) => s.section === section && s.key === key && head.test(s.value),
    );
    return this.checked(hit?.line, name);
  }

  /**
   * Line of a `rawName = ...` key in `section`. A `[section.rawName]`
   * sub-table header is not offered: core's token test rejects a name
   * that follows ".".
   */
  tableKey(section: string, rawName: string, name: string): number | undefined {
    const hit = this.keys.find((k) => k.section === section && k.key === rawName);
    return this.checked(hit?.line, name);
  }
}
