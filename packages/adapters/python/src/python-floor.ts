/** Declared Python minimum, statically read for the post-M2 native-rule path (#300). */
import { parse as parseToml } from "smol-toml";
import type { Evidence, ProjectRef, RepositoryHandle } from "@ghostdeps/core";
import { MAX_PYPROJECT_BYTES } from "./detect.js";
import { joinPath } from "./paths.js";

export type PythonFloor =
  | {
      status: "declared";
      version: readonly number[];
      exclusive: boolean;
      constraint: string;
      declaredIn: string;
      line: number;
      evidence: Evidence[];
    }
  | { status: "absent"; evidence: Evidence[] }
  | { status: "unparsed"; declaredIn: string; line?: number; evidence: Evidence[] };
type Bound = { version: number[]; exclusive: boolean };

export function comparePythonVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Unknown operators or a union arm with no bound give no usable floor. */
export function parsePythonFloor(raw: string): Bound | undefined {
  if (raw.length > 4096) return undefined;
  const arms = raw.split(/\s*\|\|\s*/);
  if ((raw.includes("|") && arms.length === 1) || arms.some((arm) => !arm.trim())) return undefined;
  const bounds: Bound[] = [];
  for (const arm of arms) {
    let best: Bound | undefined;
    const uppers: Bound[] = [];
    const exclusions: number[][] = [];
    const terms = arm.split(/\s*,\s*|\s+(?=[<>!=~^]|\d)/).map((s) => s.trim());
    if (terms.some((term) => !term)) return undefined;
    for (const term of terms) {
      const m = /^(>=|>|<=|<|==|!=|~=|\^|~)?\s*(\d+(?:\.\d+){0,2})(\.\*)?$/.exec(term);
      if (!m) return undefined;
      const op = m[1] ?? "";
      if (m[3] && op !== "==") return undefined;
      const version = m[2]!.split(".").map(Number);
      if (!version.every(Number.isSafeInteger)) return undefined;
      if (op === "==" && !m[3] && version.length === 1) return undefined;
      if (op === "!=") {
        exclusions.push(version);
        continue;
      }
      if (op === "<" || op === "<=") {
        uppers.push({ version, exclusive: op === "<" });
        continue;
      }
      if (op === "==" && !m[3]) uppers.push({ version, exclusive: false });
      if (op === "==" && m[3]) {
        const upper = [...version];
        upper[upper.length - 1] = upper.at(-1)! + 1;
        uppers.push({ version: upper, exclusive: true });
      }
      if (op === "^" || op === "~" || op === "~=") {
        if (op === "~=" && version.length < 2) return undefined;
        const upper = [...version];
        const index =
          op === "^"
            ? version[0] === 0 && version.length > 1
              ? 1
              : 0
            : op === "~"
              ? version.length > 1
                ? 1
                : 0
              : version.length - 2;
        upper[index] = upper[index]! + 1;
        upper.length = index + 1;
        uppers.push({ version: upper, exclusive: true });
      }
      const candidate = { version, exclusive: op === ">" };
      const cmp = best === undefined ? 1 : comparePythonVersions(candidate.version, best.version);
      if (cmp > 0 || (cmp === 0 && candidate.exclusive)) best = candidate;
    }
    if (!best) return undefined;
    if (
      uppers.some((upper) => {
        const cmp = comparePythonVersions(best.version, upper.version);
        return cmp > 0 || (cmp === 0 && (best.exclusive || upper.exclusive));
      })
    )
      return undefined;
    if (
      !best.exclusive &&
      exclusions.some((excluded) => comparePythonVersions(excluded, best.version) === 0)
    )
      return undefined;
    bounds.push(best);
  }
  return bounds.reduce((lowest, next) => {
    const cmp = comparePythonVersions(next.version, lowest.version);
    return cmp < 0 || (cmp === 0 && !next.exclusive) ? next : lowest;
  });
}

const table = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type Candidate = { constraint?: string; present: boolean; line: number };
function tomlCandidate(text: string, target: "project" | "poetry"): Candidate {
  const doc = table(parseToml(text));
  const section =
    target === "project"
      ? table(doc?.project)
      : table(table(table(doc?.tool)?.poetry)?.dependencies);
  const key = target === "project" ? "requires-python" : "python";
  if (!section || !Object.hasOwn(section, key)) return { present: false, line: 0 };
  const value = section[key];
  const constraint = typeof value === "string" ? value : table(value)?.version;
  // Find the key within its exact TOML table. Do not confuse poetry's python
  // dependency with similarly named keys elsewhere in the file.
  const header = target === "project" ? "project" : "tool.poetry.dependencies";
  const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const sectionName = (value: string): string => value.split(".").map(unquote).join(".");
  let active = false;
  let line = 0;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const match = /^\s*\[([^\]]+)\]/.exec(raw);
    if (match) active = sectionName(match[1]!) === header;
    else if (active) {
      const keyMatch = /^\s*(["'][^"']+["']|[A-Za-z0-9_-]+)\s*=/.exec(raw);
      if (keyMatch && unquote(keyMatch[1]!) === key) {
        line = i + 1;
        break;
      }
    }
  }
  return { present: true, ...(typeof constraint === "string" ? { constraint } : {}), line };
}
function setupCfgCandidate(text: string): Candidate {
  let active = false;
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const header = /^\s*\[([^\]]+)\]/.exec(raw);
    if (header) {
      active = header[1]!.trim().toLowerCase() === "options";
      continue;
    }
    if (!active) continue;
    const match = /^\s*python_requires\s*=\s*(.*)$/.exec(raw);
    if (!match) continue;
    const parts = [match[1]!.trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!/^\s+\S/.test(next)) break;
      parts.push(next.trim());
    }
    return { present: true, constraint: parts.join("").replace(/\s*#.*$/, ""), line: i + 1 };
  }
  return { present: false, line: 0 };
}

/** A bounded static setup(...) literal reader. It never runs setup.py code. */
function setupPyCandidate(text: string): Candidate {
  const lines = text.split(/\r?\n/);
  let inSetup = false;
  let depth = 0;
  let quote = "";
  for (const [i, raw] of lines.entries()) {
    // Lex one line, replacing quoted bytes with spaces in the search view.
    // Keep the original for extracting a literal at the matched index.
    let code = "";
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j]!;
      if (quote) {
        code += " ";
        if (ch === "\\" && j + 1 < raw.length) {
          code += " ";
          j++;
        } else if (raw.startsWith(quote, j)) {
          code += " ".repeat(quote.length - 1);
          j += quote.length - 1;
          quote = "";
        }
      } else if (ch === "#") break;
      else if (ch === '"' || ch === "'") {
        quote = raw.startsWith(ch.repeat(3), j) ? ch.repeat(3) : ch;
        code += " ".repeat(quote.length);
        j += quote.length - 1;
      } else code += ch;
    }
    let start = 0;
    if (!inSetup) {
      const call = /^\s*(?:setuptools\.)?setup\s*\(/.exec(code);
      if (!call) continue;
      inSetup = true;
      start = call[0].length;
      depth = 1;
    }
    for (let j = start; j < code.length; j++) {
      const ch = code[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          inSetup = false;
          break;
        }
      }
      if (depth !== 1) continue;
      const match = /^python_requires\s*=/.exec(code.slice(j));
      if (!match || (j > 0 && /[A-Za-z0-9_]/.test(code[j - 1]!))) continue;
      const tail = raw.slice(j + match[0].length).trimStart();
      const literal = /^(['"])([^'"\r\n]+)\1(?=\s*[,)]|\s*$)/.exec(tail);
      return { present: true, ...(literal ? { constraint: literal[2]! } : {}), line: i + 1 };
    }
  }
  return { present: false, line: 0 };
}

export async function readPythonFloor(
  repository: RepositoryHandle,
  project: ProjectRef,
): Promise<PythonFloor> {
  const evidence: Evidence[] = [];
  for (const [file, source] of [
    ["pyproject.toml", "project"],
    ["pyproject.toml", "poetry"],
    ["setup.py", "setup.py"],
    ["setup.cfg", "setup.cfg"],
  ] as const) {
    const path = joinPath(project.path, file);
    if (!(await repository.exists(path))) continue;
    let text: string;
    try {
      text = await repository.readFile(path);
    } catch {
      unparsed(path, 0, "unreadable", evidence);
      if (source === "setup.py") continue;
      return lastUnparsed(evidence);
    }
    if (Buffer.byteLength(text, "utf8") > MAX_PYPROJECT_BYTES) {
      unparsed(path, 0, "over size cap", evidence);
      if (source === "setup.py") continue;
      return lastUnparsed(evidence);
    }
    let candidate: Candidate;
    try {
      candidate =
        source === "project" || source === "poetry"
          ? tomlCandidate(text, source)
          : source === "setup.py"
            ? setupPyCandidate(text)
            : setupCfgCandidate(text);
    } catch {
      unparsed(path, 0, "invalid TOML", evidence);
      return lastUnparsed(evidence);
    }
    if (!candidate.present) continue;
    const bound =
      candidate.constraint === undefined ? undefined : parsePythonFloor(candidate.constraint);
    if (!bound || candidate.line === 0) {
      const note = unparsed(path, candidate.line, "Python floor unparsed", evidence);
      if (source === "setup.py") continue; // setuptools may supply it in setup.cfg.
      return note;
    }
    return {
      status: "declared",
      ...bound,
      constraint: candidate.constraint!,
      declaredIn: path,
      line: candidate.line,
      evidence,
    };
  }
  if (evidence.length) return lastUnparsed(evidence);
  return { status: "absent", evidence };
}
function unparsed(path: string, line: number, why: string, evidence: Evidence[]): PythonFloor {
  evidence.push({
    kind: "python-floor-unparsed",
    statement: `${path}${line ? `:${line}` : ""}: ${why}; no Python floor inferred${path.endsWith("setup.py") ? "; falling back to setup.cfg if present" : ""}`,
    file: path,
    ...(line ? { line } : {}),
  });
  return { status: "unparsed", declaredIn: path, ...(line ? { line } : {}), evidence };
}

function lastUnparsed(evidence: Evidence[]): PythonFloor {
  const last = evidence[evidence.length - 1]!;
  return {
    status: "unparsed",
    declaredIn: last.file!,
    ...(last.line !== undefined ? { line: last.line } : {}),
    evidence,
  };
}
