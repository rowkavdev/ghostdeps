/**
 * Python logical-statement splitter for import scanning (#261). Not a full
 * tokenizer: it only needs to find statement boundaries, blank out comments
 * and string literals, and keep literal contents for importlib calls.
 *
 * - `#` comments are dropped.
 * - String literals (any prefix; single, double and triple quoted) become an
 *   identifier placeholder `__S<n>__`; `strings[n]` holds the raw content.
 *   Docstrings and strings that merely contain "import x" never match.
 * - Newlines inside brackets or after a backslash continue the statement;
 *   `;` and newlines outside brackets end it.
 */

export interface PythonStatement {
  /** Code with comments removed and strings replaced by placeholders. */
  text: string;
  /** 1-based line where the statement starts. */
  line: number;
  /** Column of the first code character on the starting physical line. */
  indent: number;
}

export interface LexedPython {
  statements: PythonStatement[];
  strings: string[];
}

const STRING_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;

export function splitPythonStatements(source: string): LexedPython {
  const statements: PythonStatement[] = [];
  const strings: string[] = [];
  let text = "";
  let startLine = 1;
  let indent = 0;
  let line = 1;
  let depth = 0;
  let atLineStart = true;
  let column = 0;
  const n = source.length;

  const flush = () => {
    const trimmed = text.trim();
    if (trimmed !== "") statements.push({ text: trimmed, line: startLine, indent });
    text = "";
  };

  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (c === "\n") {
      line++;
      i++;
      column = 0;
      if (depth === 0) {
        flush();
        atLineStart = true;
      } else {
        text += " ";
      }
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (atLineStart && (c === " " || c === "\t")) {
      column += c === "\t" ? 8 - (column % 8) : 1;
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (atLineStart) {
      atLineStart = false;
      if (text.trim() === "") {
        startLine = line;
        indent = column;
      }
    }
    if (
      c === "\\" &&
      (source[i + 1] === "\n" || (source[i + 1] === "\r" && source[i + 2] === "\n"))
    ) {
      i += source[i + 1] === "\r" ? 3 : 2;
      line++;
      text += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      // A string prefix is the identifier run just before the quote.
      const prefixMatch = /[A-Za-z]{1,2}$/.exec(text);
      if (prefixMatch && STRING_PREFIX.test(prefixMatch[0])) {
        const before = text.slice(0, -prefixMatch[0].length);
        if (!/[A-Za-z0-9_]$/.test(before)) text = before;
      }
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      i += quote.length;
      let content = "";
      while (i < n) {
        if (source[i] === "\\" && i + 1 < n) {
          if (source[i + 1] === "\n") line++;
          content += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (source.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        if (source[i] === "\n") {
          line++;
          // An unterminated single-quoted string ends at the newline.
          if (!triple) break;
        }
        content += source[i];
        i++;
      }
      text += ` __S${strings.length}__ `;
      strings.push(content);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    else if (c === ";" && depth === 0) {
      const keepIndent = indent;
      flush();
      startLine = line;
      indent = keepIndent;
      i++;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return { statements, strings };
}
