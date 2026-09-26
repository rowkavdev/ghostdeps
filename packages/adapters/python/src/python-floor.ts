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
  if (raw.includes("|") && arms.length === 1) return undefined;
  if (arms.some((arm) => !arm.trim())) return undefined;
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
    // The exact lower version is excluded: there is no safe numeric floor
    // for the remaining interval without interpreting successor semantics.
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
  let active = false;
  let line = 0;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const match = /^\s*\[([^\]]+)\]/.exec(raw);
    if (match) active = match[1]!.trim() === header;
    else if (active && new RegExp(`^\\s*["']?${key}["']?\\s*=`).test(raw)) {
      line = i + 1;
      break;
    }
  }
  return { present: true, ...(typeof constraint === "string" ? { constraint } : {}), line };
}
function setupCfgCandidate(text: string): Candidate {
  let active = false;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const header = /^\s*\[([^\]]+)\]/.exec(raw);
    if (header) {
      active = header[1]!.trim().toLowerCase() === "options";
      continue;
    }
    if (!active) continue;
    const match = /^\s*python_requires\s*=\s*([^#;\r\n]*)/.exec(raw);
    if (match) return { present: true, constraint: match[1]!.trim(), line: i + 1 };
  }
  return { present: false, line: 0 };
}
function setupPyCandidate(text: string): Candidate {
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    if (/^\s*#/.test(raw)) continue;
    const match = /\bpython_requires\s*=/.exec(raw);
    if (!match) continue;
    const literal = /^\s*python_requires\s*=\s*(['"])([^'"\r\n]+)\1\s*,?\s*(?:#.*)?$/.exec(raw);
    return { present: true, ...(literal ? { constraint: literal[2]! } : {}), line: i + 1 };
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
    if (!bound) {
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
