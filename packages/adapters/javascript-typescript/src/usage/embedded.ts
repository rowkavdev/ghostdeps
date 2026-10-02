/**
 * Script blocks embedded in HTML and single-file components (.html, .vue,
 * .svelte, .astro). Found with a linear, case-insensitive tag scan over the
 * raw text. Nothing is rendered or evaluated, and no HTML parser is involved:
 * each block's body is handed to the same parse-only scanner as a .js/.ts file.
 */
import ts from "typescript";

/** Script blocks scanned per file; the rest are reported as a limitation. */
export const MAX_SCRIPT_BLOCKS_PER_FILE = 200;

const EMBEDDED_EXTENSIONS = new Set([".html", ".htm", ".vue", ".svelte", ".astro"]);

/** True for files whose script blocks are scanned. */
export function isEmbeddedScriptFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && EMBEDDED_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

export interface ScriptBlock {
  /** Block body, exactly as written. */
  code: string;
  /** 1-based line of the first character of `code` in the file. */
  line: number;
  kind: ts.ScriptKind;
}

export interface ExtractedBlocks {
  blocks: ScriptBlock[];
  /** Blocks beyond MAX_SCRIPT_BLOCKS_PER_FILE that were not scanned. */
  dropped: number;
}

/** `type` values that hold JavaScript (absent means classic JavaScript). */
const JS_TYPES = new Set([
  "",
  "module",
  // HTML uses exact MIME essence strings, not MIME strings with parameters.
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
  "text/typescript",
  "application/typescript",
  "text/jsx",
  "text/babel",
]);

/** Consume whole attributes so text inside quoted values cannot become a name. */
function attr(tag: string, name: string): string | undefined {
  const attributes = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.slice(7, -1).matchAll(attributes)) {
    if (match[1]!.toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return undefined;
}

function kindFor(lang: string | undefined): ts.ScriptKind {
  switch ((lang ?? "").toLowerCase()) {
    case "ts":
    case "typescript":
      return ts.ScriptKind.TS;
    case "tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.JSX;
  }
}

/** Find the tag terminator, ignoring delimiters inside quoted attributes. */
function openingTagEnd(text: string, start: number): number {
  let quote: string | undefined;
  let valueStart = false;
  for (let i = start; i < text.length; i++) {
    const character = text[i];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === ">") return i;
    else if (character === "=") valueStart = true;
    else if (valueStart && character !== undefined && !/[\t\n\f\r ]/.test(character)) {
      if (character === '"' || character === "'") quote = character;
      valueStart = false;
    }
  }
  return -1;
}

/** A script end tag needs a delimiter after its complete ASCII name. */
function closingScriptStart(lower: string, from: number): number {
  for (;;) {
    const close = lower.indexOf("</script", from);
    if (close < 0) return -1;
    if (/[\t\n\f\r />]/.test(lower[close + 8] ?? "")) return close;
    from = close + 8;
  }
}

/** Scan markup boundaries, never tag-looking text inside comments or attributes. */
function nextScriptStart(text: string, lower: string, from: number): number {
  for (;;) {
    const open = lower.indexOf("<", from);
    if (open < 0) return -1;
    if (lower.startsWith("<!--", open)) {
      const start = open + 4;
      if (text[start] === ">") from = start + 1;
      else if (text.startsWith("->", start)) from = start + 2;
      else {
        const end = /--!?>/g;
        end.lastIndex = start;
        const match = end.exec(text);
        if (match === null) return -1;
        from = end.lastIndex;
      }
    } else if (lower.startsWith("<script", open)) return open;
    else if (/^<\/?[a-z!]/i.test(text.slice(open, open + 3))) {
      const end = openingTagEnd(text, open + 1);
      if (end < 0) return -1;
      from = end + 1;
    } else from = open + 1;
  }
}

/** HTML ignores self-closing flags on non-void script; components do not. */
function isSelfClosingScript(file: string, tag: string): boolean {
  return !/\.html?$/i.test(file) && tag.endsWith("/>");
}

export function extractScriptBlocks(file: string, text: string): ExtractedBlocks {
  const blocks: ScriptBlock[] = [];
  let dropped = 0;
  // Line numbers are computed incrementally so the whole scan stays linear.
  let lineAt = 0;
  let line = 1;
  const lineOf = (index: number): number => {
    for (let i = lineAt; i < index; i++) if (text.charCodeAt(i) === 10) line++;
    lineAt = index;
    return line;
  };
  const push = (start: number, end: number, kind: ts.ScriptKind) => {
    if (blocks.length >= MAX_SCRIPT_BLOCKS_PER_FILE) {
      dropped++;
      return;
    }
    blocks.push({ code: text.slice(start, end), line: lineOf(start), kind });
  };

  // Astro component frontmatter: a leading `---` fence holding TypeScript.
  let from = 0;
  if (file.toLowerCase().endsWith(".astro")) {
    const lead = /^\uFEFF?\s*---[^\S\n]*\n/.exec(text);
    if (lead) {
      const start = lead[0].length;
      const close = text.indexOf("\n---", start - 1);
      if (close >= 0) {
        push(start, close, ts.ScriptKind.TS);
        from = close + 4;
      }
    }
  }

  // HTML tag matching is ASCII-insensitive. Unicode folding can expand
  // characters (e.g. İ), which shifts indices into the original source.
  const lower = text.replace(/[A-Z]/g, (character) => character.toLowerCase());
  for (;;) {
    const open = nextScriptStart(text, lower, from);
    if (open < 0) break;
    const next = lower.charCodeAt(open + 7);
    // `<scripts>` or `<script-x>` are other tags.
    if (!(
      next === 62 ||
      next === 47 ||
      next === 32 ||
      next === 9 ||
      next === 10 ||
      next === 12 ||
      next === 13
    )) {
      from = open + 7;
      continue;
    }
    const tagEnd = openingTagEnd(text, open + 7);
    if (tagEnd < 0) break;
    const tag = text.slice(open, tagEnd + 1);
    const close = closingScriptStart(lower, tagEnd + 1);
    const bodyEnd = close < 0 ? text.length : close;
    const type = (attr(tag, "type") ?? "").trim().toLowerCase();
    const selfClosing = isSelfClosingScript(file, tag);
    if (!selfClosing && JS_TYPES.has(type)) {
      const lang = attr(tag, "lang") ?? (type.includes("typescript") ? "ts" : undefined);
      push(tagEnd + 1, bodyEnd, kindFor(lang));
    }
    if (close < 0) break;
    from = close + 8;
  }
  return { blocks, dropped };
}
