/**
 * JSON reporter for AnalysisResult. The output is the schema shared by
 * `ghostdeps --json` and any future integration, so it must be stable:
 * the same result always serialises to the same bytes.
 *
 * Stability rules (documented in docs/architecture.md, "JSON output"):
 * - `schemaVersion` is the first key; every other object key is sorted.
 * - Top-level collections are sorted by their identifying fields, so the
 *   order adapters happen to run in never shows up as a diff.
 * - Order inside a finding (evidence, limitations) is preserved: it is
 *   meaningful and set by the recommendation engine, which must emit it in
 *   a stable order.
 * - `undefined` fields are omitted; two-space indent; trailing newline.
 * - Invisible and direction-changing characters from repository content are
 *   escaped so output can't hide or reorder text (security-model rule 6).
 */
import type { AnalysisResult, Dependency, Finding, ProjectRef, Usage } from "../types/index.js";

/** The JSON schema version this reporter writes. Bump on any breaking change. */
export const jsonSchemaVersion = 1 as const satisfies AnalysisResult["schemaVersion"];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compare by a list of keys, first difference wins. */
function by<T>(...keys: ((item: T) => string | number)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key(a);
      const y = key(b);
      const diff =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : compareStrings(String(x), String(y));
      if (diff !== 0) return diff;
    }
    return 0;
  };
}

const projectOrder = by<Pick<ProjectRef, "path" | "ecosystem">>(
  (p) => p.path,
  (p) => p.ecosystem,
);
const dependencyOrder = by<Dependency>(
  (d) => d.declaredIn,
  (d) => d.project.path,
  (d) => d.name,
  (d) => d.kind,
  (d) => d.constraint,
);
const usageOrder = by<Usage>(
  (u) => u.dependency,
  (u) => u.file,
  (u) => u.line,
  (u) => u.form,
);
const findingOrder = by<Finding>(
  (f) => f.dependency ?? "",
  (f) => f.kind,
  (f) => f.summary,
  (f) => f.evidence[0]?.file ?? "",
  (f) => f.evidence[0]?.line ?? 0,
  // Last resort: the whole finding, so equal-looking findings from
  // concurrently running adapters still land in one fixed order.
  (f) => sortKey(f),
);
/**
 * Content key for the last-resort tie-break. Never throws: sorting runs
 * inside the engine (normaliseAnalysisResult), and one odd value must not
 * abort a whole analysis. Non-plain values are still rejected, loudly, by
 * renderJsonReport.
 */
function sortKey(value: unknown): string {
  try {
    return JSON.stringify(canonical(value));
  } catch {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
}

/** Sort keys recursively, dropping undefined. schemaVersion stays first at the top. */
function canonical(value: unknown, top = false): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`cannot serialise non-finite number ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value instanceof Set) return canonical([...value]);
  if (typeof value === "object") {
    // Map, Date and class instances would silently serialise as {} and lose data.
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `cannot serialise ${(value as object).constructor?.name ?? "non-plain object"}; use plain objects, arrays or Sets`,
      );
    }
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort(compareStrings);
    if (top && keys.includes("schemaVersion")) {
      keys.splice(keys.indexOf("schemaVersion"), 1);
      keys.unshift("schemaVersion");
    }
    const out: { [key: string]: Json } = {};
    for (const key of keys) out[key] = canonical(source[key]);
    return out;
  }
  throw new TypeError(`cannot serialise value of type ${typeof value}`);
}

/**
 * Characters escaped beyond what JSON.stringify does: soft hyphen, Arabic
 * letter mark, Mongolian vowel separator, line/paragraph separators, bidi
 * controls (Trojan Source), zero-width characters and BOM. All of them can
 * hide in a lookalike package name.
 */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Return a copy of the result with every collection in canonical order. */
export function normaliseAnalysisResult(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    projects: [...result.projects].sort(projectOrder),
    ...(result.projectTree ? { projectTree: [...result.projectTree].sort(projectOrder) } : {}),
    dependencies: [...result.dependencies].sort(dependencyOrder),
    usages: [...result.usages].sort(usageOrder),
    findings: [...result.findings].sort(findingOrder),
    detected: [...result.detected].sort(by((d) => d.ecosystem)),
    surface: [...result.surface].sort(by((s) => s.ecosystem)),
  };
}

/** Serialise an AnalysisResult to the stable, versioned JSON schema. */
export function renderJsonReport(result: AnalysisResult): string {
  if (result.schemaVersion !== jsonSchemaVersion) {
    throw new RangeError(
      `unsupported schemaVersion ${String(result.schemaVersion)}; this reporter writes ${jsonSchemaVersion}`,
    );
  }
  const json = JSON.stringify(canonical(normaliseAnalysisResult(result), true), null, 2);
  return `${escapeInvisible(json)}\n`;
}
