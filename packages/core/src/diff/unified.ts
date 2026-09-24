/**
 * Unified diff parser for pull request diffs (`git diff` / GitHub's
 * `application/vnd.github.diff` format).
 *
 * PR diffs are attacker-controlled (docs/security-model.md), so this parser
 * never throws on malformed input: it keeps what it can read, records what
 * it could not in `problems`, and enforces size limits. Callers lower
 * confidence when `problems` or `truncated` are set.
 */

export type FileChangeStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  /** Line number in the old file (context and deleted lines). */
  oldLine?: number;
  /** Line number in the new file (context and added lines). */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/**
 * One file in the diff. Paths are attacker data exactly as written in the
 * diff: they may contain `..`, absolute paths or control characters.
 * Consumers must validate them (see isSafeRepositoryPath) and read only
 * through a RepositoryHandle, and escape them before display.
 */
export interface FileDiff {
  /** Path before the change; undefined for added files. */
  oldPath?: string;
  /** Path after the change; undefined for deleted files. */
  newPath?: string;
  status: FileChangeStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

export interface DiffParseLimits {
  /**
   * Maximum diff size in UTF-16 code units (JavaScript string length), not
   * bytes. Default 5,000,000.
   */
  maxChars: number;
  /** Maximum number of files. Default 3,000 (GitHub's own PR file cap). */
  maxFiles: number;
  /** Maximum total diff lines kept across all hunks. Default 200,000. */
  maxLines: number;
}

export interface ParsedDiff {
  files: FileDiff[];
  /** True when a limit stopped parsing early; the file list is incomplete. */
  truncated: boolean;
  /** Malformed input that was skipped, for limitations/evidence. */
  problems: string[];
}

export const defaultDiffParseLimits: DiffParseLimits = {
  maxChars: 5_000_000,
  maxFiles: 3_000,
  maxLines: 200_000,
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git (.+)$/;
const MAX_PROBLEMS = 50;

/** Decode a git C-style quoted path ("a/caf\303\251.txt"). Invalid UTF-8 keeps the raw text. */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
  let encoded = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      encoded += encodeURIComponent(ch);
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(i + 1));
    const next = body[i + 1] ?? "";
    if (octal) {
      encoded += "%" + parseInt(octal[0], 8).toString(16).padStart(2, "0");
      i += 3;
    } else if (next in simple) {
      encoded += encodeURIComponent(simple[next]!);
      i += 1;
    } else {
      encoded += "%5C";
    }
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return raw;
  }
}

/** Strip the a/ or b/ prefix; "/dev/null" means no file. */
function cleanPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const path = unquote(raw.replace(/\t.*$/, "").trim());
  if (path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}

/** Split `a/x b/y` from a `diff --git` header when paths have no spaces or quotes. */
function splitGitHeader(rest: string): [string | undefined, string | undefined] {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted) return [cleanPath(quoted[1]), cleanPath(quoted[2])];
  // Paths with spaces: "a/p q b/p q" - split in the middle when both halves match.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) {
      return [cleanPath(a), cleanPath(b)];
    }
  }
  return [undefined, undefined];
}

function finalise(file: FileDiff, problem: (msg: string) => void): FileDiff {
  if (file.oldPath === undefined && file.newPath === undefined) {
    problem("a file header had no readable path");
  }
  if (file.status === "modified" && file.oldPath !== undefined && file.newPath !== undefined) {
    if (file.oldPath !== file.newPath) file.status = "renamed";
  }
  if (file.oldPath === undefined && file.newPath !== undefined) file.status = "added";
  if (file.newPath === undefined && file.oldPath !== undefined) file.status = "deleted";
  return file;
}

/** Parse a unified diff. Never throws on malformed input. */
export function parseUnifiedDiff(input: string, limits: Partial<DiffParseLimits> = {}): ParsedDiff {
  const lim = { ...defaultDiffParseLimits, ...limits };
  const problems: string[] = [];
  const problem = (msg: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(msg);
  };
  let truncated = false;
  let text = input;
  if (text.length > lim.maxChars) {
    text = text.slice(0, lim.maxChars);
    truncated = true;
  }

  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let totalLines = 0;

  const startFile = (oldPath: string | undefined, newPath: string | undefined): boolean => {
    if (current) files.push(finalise(current, problem));
    current = undefined;
    hunk = undefined;
    if (files.length >= lim.maxFiles) {
      truncated = true;
      return false;
    }
    current = { status: "modified", binary: false, hunks: [] };
    if (oldPath !== undefined) current.oldPath = oldPath;
    if (newPath !== undefined) current.newPath = newPath;
    return true;
  };

  const lines = text.split(/\r?\n/);
  // A trailing newline yields one empty final element that is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line[0];
      if (tag === " " || tag === "+" || tag === "-" || line === "") {
        if (++totalLines > lim.maxLines) {
          truncated = true;
          break outer;
        }
        const body = line.slice(1);
        if (tag === "+") {
          hunk.lines.push({ type: "add", text: body, newLine });
          newLine++;
          newLeft--;
        } else if (tag === "-") {
          hunk.lines.push({ type: "del", text: body, oldLine });
          oldLine++;
          oldLeft--;
        } else {
          // Context; some tools strip the leading space from blank context lines.
          hunk.lines.push({ type: "context", text: body, oldLine, newLine });
          oldLine++;
          newLine++;
          oldLeft--;
          newLeft--;
        }
        continue;
      }
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      problem(`hunk in ${current?.newPath ?? current?.oldPath ?? "?"} ended early`);
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("\\")) continue;

    const git = DIFF_GIT.exec(line);
    if (git) {
      const [a, b] = splitGitHeader(git[1]!);
      if (!startFile(a, b)) break;
      continue;
    }

    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldPath = cleanPath(line.slice(4));
      const newPath = cleanPath(lines[i + 1]!.slice(4));
      // Plain unified diff without a `diff --git` header, or a second file in one.
      if (!current || current.hunks.length > 0) {
        if (!startFile(oldPath, newPath)) break;
      } else {
        if (oldPath === undefined) delete current.oldPath;
        else current.oldPath = oldPath;
        if (newPath === undefined) delete current.newPath;
        else current.newPath = newPath;
      }
      i++;
      continue;
    }

    if (!current) continue; // preamble (commit message, stats) before the first file

    const header = HUNK_HEADER.exec(line);
    if (header) {
      const [oldStart, oldCount, newStart, newCount] = [
        Number(header[1]),
        header[2] === undefined ? 1 : Number(header[2]),
        Number(header[3]),
        header[4] === undefined ? 1 : Number(header[4]),
      ];
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
        problem(`unreadable hunk header in ${current.newPath ?? current.oldPath ?? "?"}`);
        hunk = undefined;
        continue;
      }
      hunk = { oldStart, oldLines: oldCount, newStart, newLines: newCount, lines: [] };
      current.hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      oldLeft = oldCount;
      newLeft = newCount;
      continue;
    }

    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.oldPath = unquote(line.slice(12));
      current.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      current.newPath = unquote(line.slice(10));
      current.status = "renamed";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
    }
  }
  if (current) files.push(finalise(current, problem));
  if (oldLeft > 0 || newLeft > 0) problem("diff ended inside a hunk");
  return { files, truncated, problems };
}

/** Lines removed from the old version of a file, with old-file line numbers. */
export function removedLines(file: FileDiff): { line: number; text: string }[] {
  return file.hunks.flatMap((h) =>
    h.lines.filter((l) => l.type === "del").map((l) => ({ line: l.oldLine ?? 0, text: l.text })),
  );
}

/** Lines added in the new version of a file, with new-file line numbers. */
export function addedLines(file: FileDiff): { line: number; text: string }[] {
  return file.hunks.flatMap((h) =>
    h.lines.filter((l) => l.type === "add").map((l) => ({ line: l.newLine ?? 0, text: l.text })),
  );
}
