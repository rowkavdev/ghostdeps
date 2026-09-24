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
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "application/typescript",
  "text/jsx",
  "text/babel",
]);

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : undefined;
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

  const lower = text.toLowerCase();
  for (;;) {
    const open = lower.indexOf("<script", from);
    if (open < 0) break;
    const next = lower.charCodeAt(open + 7);
    // `<scripts>` or `<script-x>` are other tags.
    if (!(next === 62 || next === 47 || next === 32 || next === 9 || next === 10 || next === 13)) {
      from = open + 7;
      continue;
    }
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd < 0) break;
    const tag = text.slice(open, tagEnd + 1);
    const close = lower.indexOf("</script", tagEnd + 1);
    const bodyEnd = close < 0 ? text.length : close;
    const type = (attr(tag, "type") ?? "").trim().toLowerCase();
    const selfClosing = tag.endsWith("/>");
    if (!selfClosing && JS_TYPES.has(type)) {
      const lang = attr(tag, "lang") ?? (type.includes("typescript") ? "ts" : undefined);
      push(tagEnd + 1, bodyEnd, kindFor(lang));
    }
    if (close < 0) break;
    from = close + 8;
  }
  return { blocks, dropped };
}
