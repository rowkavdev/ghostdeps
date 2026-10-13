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
function attr(tag: string, name: string, nameLength = 7): string | undefined {
  const attributes = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.slice(nameLength, -1).matchAll(attributes)) {
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

/** HTML elements whose body is text rather than markup. */
const HTML_TEXT_ELEMENTS = new Set([
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);

/** HTML text elements end only at an appropriate complete end-tag name. */
function textElementEnd(lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  for (;;) {
    const close = lower.indexOf(needle, from);
    if (close < 0) return -1;
    if (/[\t\n\f\r />]/.test(lower[close + needle.length] ?? "")) {
      const end = openingTagEnd(lower, close + needle.length);
      return end < 0 ? -1 : end + 1;
    }
    from = close + needle.length;
  }
}

/** HTML comment endings include abrupt empty comments and --!>. */
function commentEnd(text: string, start: number): number {
  if (text[start] === ">") return start + 1;
  if (text.startsWith("->", start)) return start + 2;
  const end = /--!?>/g;
  end.lastIndex = start;
  return end.exec(text) === null ? -1 : end.lastIndex;
}

/** Skip one markup tag and, for HTML, any text-only body. */
function markupEnd(text: string, lower: string, open: number, html: boolean): number {
  const end = openingTagEnd(text, open + 1);
  if (end < 0) return -1;
  if (!html) return end + 1;
  const name = /^<([a-z]+)(?=[\t\n\f\r />])/.exec(lower.slice(open, end + 1))?.[1];
  if (name === "plaintext") return -1;
  return name !== undefined && HTML_TEXT_ELEMENTS.has(name)
    ? textElementEnd(lower, name, end + 1)
    : end + 1;
}

/** Scan markup boundaries, never tag-looking text inside comments or attributes. */
function nextScriptStart(text: string, lower: string, from: number, html: boolean): number {
  for (;;) {
    const open = lower.indexOf("<", from);
    if (open < 0) return -1;
    if (lower.startsWith("<!--", open)) from = commentEnd(text, open + 4);
    else if (lower.startsWith("<script", open)) return open;
    else if (/^<\/?[a-z!]/i.test(text.slice(open, open + 3)))
      from = markupEnd(text, lower, open, html);
    else from = open + 1;
    if (from < 0) return -1;
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
    const open = nextScriptStart(text, lower, from, /\.html?$/i.test(file));
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
    // A self-closing component script has no body: resume right after the tag
    // instead of seeking the next closing tag (#867).
    if (isSelfClosingScript(file, tag)) {
      from = tagEnd + 1;
      continue;
    }
    const close = closingScriptStart(lower, tagEnd + 1);
    const bodyEnd = close < 0 ? text.length : close;
    const type = (attr(tag, "type") ?? "").trim().toLowerCase();
    if (JS_TYPES.has(type)) {
      const lang = attr(tag, "lang") ?? (type.includes("typescript") ? "ts" : undefined);
      push(tagEnd + 1, bodyEnd, kindFor(lang));
    }
    if (close < 0) break;
    from = close + 8;
  }
  return { blocks, dropped };
}

/** `lang` values that name a stylesheet preprocessor. */
const STYLE_LANGS = new Set(["scss", "sass", "less", "stylus", "styl", "sugarss", "sss"]);

/** Component formats whose style blocks may name a preprocessor. */
export function hasStyleBlocks(file: string): boolean {
  return /\.(vue|svelte|astro)$/i.test(file);
}

/** Index just past a leading Astro frontmatter fence, or 0 when there is none. */
function astroFrontmatterEnd(text: string): number {
  const lead = /^\uFEFF?\s*---[^\S\n]*\n/.exec(text);
  if (!lead) return 0;
  const close = text.indexOf("\n---", lead[0].length - 1);
  return close >= 0 ? close + 4 : 0;
}

/**
 * Next scan position after a tag that is not script or style, or -1 to stop.
 * Skips the tag whole so attribute values cannot look like markup, and skips
 * the body of text-only elements (textarea, title, ...).
 */
function skipOtherTag(text: string, lower: string, open: number): number {
  const end = /^<\/?[a-z]/.test(lower.slice(open, open + 3)) ? openingTagEnd(text, open + 1) : -1;
  if (end < 0) return open + 1;
  const textOnly = /^<([a-z]+)(?=[\t\n\f\r />])/.exec(lower.slice(open, end + 1))?.[1];
  if (
    textOnly !== undefined &&
    HTML_TEXT_ELEMENTS.has(textOnly) &&
    !text.startsWith("/>", end - 1)
  ) {
    return textElementEnd(lower, textOnly, end + 1);
  }
  return end + 1;
}

/** Next scan position after a script or style body starting at `bodyStart`, or -1 to stop. */
function scriptOrStyleEnd(lower: string, name: string, bodyStart: number): number {
  if (name === "script") {
    const close = closingScriptStart(lower, bodyStart);
    return close < 0 ? -1 : close + 8;
  }
  return textElementEnd(lower, name, bodyStart);
}

/**
 * Preprocessor `lang` values of style tags in a component, at any depth.
 * Which package compiles such a block depends on the framework and its
 * toolchain, so the caller reports it as a limitation and credits nothing.
 * Comments, attribute values, script bodies and style bodies are skipped.
 * Nothing is rendered or evaluated.
 */
export function extractStyleLangs(file: string, text: string): string[] {
  const lower = text.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const langs = new Set<string>();
  let from = /\.astro$/i.test(file) ? astroFrontmatterEnd(text) : 0;
  while (from >= 0 && from < text.length) {
    const open = lower.indexOf("<", from);
    if (open < 0) break;
    if (lower.startsWith("<!--", open)) {
      from = commentEnd(text, open + 4);
      continue;
    }
    const opening = /^<(script|style)(?=[\t\n\f\r />])/.exec(lower.slice(open, open + 10));
    if (!opening) {
      from = skipOtherTag(text, lower, open);
      continue;
    }
    const name = opening[1]!;
    const end = openingTagEnd(text, open + 1);
    if (end < 0) break;
    const tag = text.slice(open, end + 1);
    if (name === "style") {
      const lang = (attr(tag, "lang", 6) ?? "").trim().toLowerCase();
      if (STYLE_LANGS.has(lang)) langs.add(lang);
    }
    if (tag.endsWith("/>")) {
      from = end + 1;
      continue;
    }
    from = scriptOrStyleEnd(lower, name, end + 1);
  }
  return [...langs];
}
