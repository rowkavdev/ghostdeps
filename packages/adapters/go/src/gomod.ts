/**
 * Static go.mod parser (#52). go.mod is attacker data: it is tokenised as
 * text and never handed to the go command.
 *
 * Follows the go.mod reference (https://go.dev/ref/mod#go-mod-file): line
 * comments, single-line and parenthesised block directives, interpreted
 * ("...") and raw (`...`) strings. Unknown directives are skipped, and
 * malformed lines become errors without stopping the parse, so one bad
 * line never hides the rest of the file.
 */

export interface GoModuleVersion {
  path: string;
  /** Absent for version-less replace sides and local directory targets. */
  version?: string;
}

export interface GoModModule {
  path: string;
  line: number;
  /** Text of a `// Deprecated:` comment on the module directive, if any. */
  deprecated?: string;
}

export interface GoModRequire {
  path: string;
  version: string;
  /** Marked `// indirect`: not imported by this module's own packages. */
  indirect: boolean;
  line: number;
  /** The path appears on its line exactly as written (no backslash escapes). */
  verbatim: boolean;
}

export interface GoModReplace {
  old: GoModuleVersion;
  /** A module path + version, or a local directory (`local: true`, no version). */
  new: GoModuleVersion;
  /** True when the target is a filesystem path (starts with ./ ../ or /). */
  local: boolean;
  line: number;
}

export interface GoModExclude {
  path: string;
  version: string;
  line: number;
}

export interface GoModRetract {
  /** A single version, or [low, high] for an interval. */
  low: string;
  high: string;
  line: number;
}

export interface GoModTool {
  /** Package path run through `go tool`. */
  path: string;
  line: number;
}

export interface GoModParseError {
  line: number;
  message: string;
}

export interface GoModFile {
  module?: GoModModule;
  go?: string;
  toolchain?: string;
  require: GoModRequire[];
  replace: GoModReplace[];
  exclude: GoModExclude[];
  retract: GoModRetract[];
  tool: GoModTool[];
  errors: GoModParseError[];
}

interface Token {
  text: string;
  /** False for bare words, true for "..." / `...` strings (quotes removed). */
  quoted: boolean;
  /** A "..." string that used a backslash escape, so its text differs from the source. */
  escaped?: boolean;
}

interface Line {
  tokens: Token[];
  comment: string;
  line: number;
  /** A raw string that runs past the end of the line. */
  unterminated: boolean;
}

/** Split one physical line into tokens and a trailing // comment. */
function lexLine(text: string, line: number): Line {
  const tokens: Token[] = [];
  let comment = "";
  let unterminated = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      comment = text.slice(i + 2).trim();
      break;
    }
    if (c === "(" || c === ")") {
      tokens.push({ text: c, quoted: false });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      let escaped = false;
      while (j < text.length) {
        const d = text[j]!;
        if (d === "\\" && j + 1 < text.length) {
          value += text[j + 1];
          escaped = true;
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        value += d;
        j++;
      }
      if (!closed) unterminated = true;
      tokens.push({ text: value, quoted: true, ...(escaped ? { escaped } : {}) });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) {
        unterminated = true;
        tokens.push({ text: text.slice(i + 1), quoted: true });
        break;
      }
      tokens.push({ text: text.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !' \t\r()"`'.includes(text[j]!)) {
      if (text[j] === "/" && text[j + 1] === "/") break;
      j++;
    }
    tokens.push({ text: text.slice(i, j), quoted: false });
    i = j;
  }
  return { tokens, comment, line, unterminated };
}

const LOCAL_PATH = /^(\.{1,2}[\\/]|\.{1,2}$|\/|[A-Za-z]:[\\/])/;

/** `// indirect` alone or leading a comment ("indirect; reason"). */
function isIndirect(comment: string): boolean {
  return /^indirect(\s*;|\s*$)/.test(comment);
}

const isParen = (t: Token): boolean => !t.quoted && (t.text === "(" || t.text === ")");

/**
 * Largest go.mod parsed (#227). Real files are a few KB; a bigger one is
 * reported as an error instead of being tokenised. This is a backstop:
 * callers must still bound the read itself (RepositoryHandle's read
 * ceiling or readFileHead) before handing text to parseGoMod.
 */
export const MAX_GOMOD_BYTES = 1024 * 1024;

/**
 * Parse go.mod text. Never throws. Callers must apply the byte cap to the
 * read; text over MAX_GOMOD_BYTES is refused with an error.
 */
export function parseGoMod(text: string): GoModFile {
  const out: GoModFile = {
    require: [],
    replace: [],
    exclude: [],
    retract: [],
    tool: [],
    errors: [],
  };
  if (Buffer.byteLength(text, "utf8") > MAX_GOMOD_BYTES) {
    out.errors.push({
      line: 0,
      message: `go.mod is over the ${MAX_GOMOD_BYTES}-byte size cap and was not parsed`,
    });
    return out;
  }
  const error = (line: number, message: string): void => {
    out.errors.push({ line, message });
  };

  const lines = text.split("\n").map((raw, idx) => lexLine(raw, idx + 1));
  let block: { verb: string; line: number } | undefined;

  for (const l of lines) {
    if (l.unterminated) {
      error(l.line, "unterminated string");
      continue;
    }
    if (l.tokens.length === 0) continue;
    const first = l.tokens[0]!;

    if (block) {
      if (!first.quoted && first.text === ")") {
        if (l.tokens.length > 1) error(l.line, "unexpected tokens after )");
        block = undefined;
        continue;
      }
      // A paren inside a block (a nested `require (`, a stray `(`) is never
      // a module path or version: reject the line instead of reading it (#227).
      if (l.tokens.some(isParen)) {
        error(l.line, `unexpected parenthesis in ${block.verb} block`);
        continue;
      }
      directive(block.verb, l.tokens, l);
      continue;
    }

    if (first.quoted) {
      error(l.line, "expected a directive");
      continue;
    }
    const verb = first.text;
    const args = l.tokens.slice(1);
    if (args.length === 1 && !args[0]!.quoted && args[0]!.text === "(") {
      block = { verb, line: l.line };
      continue;
    }
    // `require ()` on one line is a legal empty block.
    if (
      args.length === 2 &&
      args[0]!.text === "(" &&
      args[1]!.text === ")" &&
      args.every(isParen)
    ) {
      continue;
    }
    if (args.some(isParen)) {
      error(l.line, "unexpected parenthesis");
      continue;
    }
    directive(verb, args, l);
  }
  if (block) error(block.line, `unclosed ${block.verb} block`);
  return out;

  function directive(verb: string, args: Token[], l: Line): void {
    const words = args.map((t) => t.text);
    switch (verb) {
      case "module": {
        if (words.length !== 1 || !words[0]) return error(l.line, "module takes one path");
        if (out.module) return error(l.line, "repeated module directive");
        const deprecated = /^Deprecated:\s*(.*)$/.exec(l.comment)?.[1];
        out.module = {
          path: words[0],
          line: l.line,
          ...(deprecated !== undefined ? { deprecated } : {}),
        };
        return;
      }
      case "go":
      case "toolchain": {
        if (words.length !== 1 || !words[0]) return error(l.line, `${verb} takes one version`);
        if (out[verb] !== undefined) return error(l.line, `repeated ${verb} directive`);
        out[verb] = words[0];
        return;
      }
      case "require": {
        const [path, version] = words;
        if (words.length !== 2 || !path || !version) {
          return error(l.line, "require takes a module path and version");
        }
        out.require.push({
          path,
          version,
          indirect: isIndirect(l.comment),
          line: l.line,
          verbatim: args[0]?.escaped !== true,
        });
        return;
      }
      case "exclude": {
        const [path, version] = words;
        if (words.length !== 2 || !path || !version) {
          return error(l.line, "exclude takes a module path and version");
        }
        out.exclude.push({ path, version, line: l.line });
        return;
      }
      case "replace": {
        // Only a bare => is the operator; a quoted "=>" is a (bad) path (#227).
        const arrow = args.findIndex((t) => !t.quoted && t.text === "=>");
        const lhs = arrow < 0 ? [] : words.slice(0, arrow);
        const rhs = arrow < 0 ? [] : words.slice(arrow + 1);
        if (lhs.length < 1 || lhs.length > 2 || rhs.length < 1 || rhs.length > 2) {
          return error(l.line, "replace takes: path [version] => path [version]");
        }
        const local = LOCAL_PATH.test(rhs[0]!);
        if (local && rhs.length === 2) {
          return error(l.line, "a local replacement directory takes no version");
        }
        if (!local && rhs.length === 1) {
          return error(l.line, "a module replacement needs a version");
        }
        out.replace.push({
          old: { path: lhs[0]!, ...(lhs[1] !== undefined ? { version: lhs[1] } : {}) },
          new: { path: rhs[0]!, ...(rhs[1] !== undefined ? { version: rhs[1] } : {}) },
          local,
          line: l.line,
        });
        return;
      }
      case "retract": {
        if (words.length === 1 && words[0]) {
          out.retract.push({ low: words[0], high: words[0], line: l.line });
          return;
        }
        // Interval form: retract [v1.0.0, v1.9.9]
        const joined = words.join(" ");
        const m = /^\[\s*([^,\s]+)\s*,\s*([^\]\s]+)\s*\]$/.exec(joined);
        if (!m) return error(l.line, "retract takes a version or [low, high]");
        out.retract.push({ low: m[1]!, high: m[2]!, line: l.line });
        return;
      }
      case "tool": {
        if (words.length !== 1 || !words[0]) return error(l.line, "tool takes one package path");
        out.tool.push({ path: words[0], line: l.line });
        return;
      }
      default:
        // godebug, ignore and future directives carry no dependency facts.
        return;
    }
  }
}
