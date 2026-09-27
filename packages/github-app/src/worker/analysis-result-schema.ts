/** Strict wire schema for a child-produced AnalysisResult (#326).
 * Not wired to any runner or reporter until the OS boundary is verified.
 * Reject unknown fields, partial surfaces and invented verdict fields rather
 * than silently interpreting an untrusted result as a complete scan.
 */
import type { AnalysisResult } from "@ghostdeps/core";
import { AnalysisProtocolError } from "./analysis-protocol.js";

type Spec =
  | { anyOf: readonly Spec[] }
  | { enum: readonly (string | number | null)[] }
  | "string"
  | "integer"
  | "boolean"
  | "true"
  | "null"
  | readonly [Spec]
  | {
      required: Record<string, Spec>;
      optional?: Record<string, Spec>;
    };
const str: Spec = "string";
const num: Spec = "integer";
const bool: Spec = "boolean";
const texts: Spec = [str];
const oneOf = (...choices: Spec[]): Spec => ({ anyOf: choices });
const enumOf = (...values: (string | number | null)[]): Spec => ({ enum: values });
const integerOrNull = oneOf(num, "null");
const stringOrNull = oneOf(str, "null");
const record = (required: Record<string, Spec>, optional?: Record<string, Spec>): Spec => ({
  required,
  ...(optional ? { optional } : {}),
});
const evidence = record({ kind: str, statement: str }, { file: str, line: num });
const confidence = enumOf("high", "medium", "low");
const graphCompleteness = enumOf("none", "partial", "complete");
const project = record({
  path: str,
  ecosystem: str,
  packageManagers: [record({ name: str }, { lockfile: str })],
});
const manifest = record({ ecosystem: str, path: str });
const dependency = record(
  {
    name: str,
    constraint: str,
    kind: enumOf("runtime", "dev", "peer", "optional", "build"),
    project,
    declaredIn: str,
  },
  {
    declaredLine: num,
    specifier: record(
      { type: enumOf("registry", "git", "file", "link", "workspace") },
      { detail: str },
    ),
  },
);
const usage = record(
  {
    dependency: str,
    file: str,
    line: num,
    form: enumOf("static", "require", "dynamic", "unknown"),
    symbols: texts,
  },
  { typeOnly: bool, via: enumOf("import", "script", "config", "convention"), removedInPr: bool },
);
const finding = record(
  {
    kind: enumOf(
      "unused",
      "potentially-unnecessary",
      "duplicate-capability",
      "maintenance-risk",
      "footprint",
      "should-be-dev",
      "type-only",
      "info",
    ),
    summary: str,
    recommendation: str,
    evidence: [evidence],
    confidence,
    limitations: texts,
    affectedFiles: texts,
  },
  {
    rule: str,
    dependency: str,
    severity: enumOf("critical", "high", "medium", "low", "info"),
    awareness: "true",
    adapterNote: "true",
    healthFact: "true",
    source: record({ kind: enumOf("registry", "repository-host"), basis: str }, { url: str }),
    declaringManifest: manifest,
  },
);
const surface = record({ ecosystem: str, direct: num, transitive: num, graphs: graphCompleteness });
const projectNode = record({ id: str, path: str, ecosystem: str }, { parent: str });
const graphNode = record({
  id: str,
  ecosystem: str,
  name: str,
  version: str,
  dependencies: texts,
  dev: bool,
  projects: texts,
  directIn: texts,
});
const graphEcosystem = record({
  ecosystem: str,
  graphs: graphCompleteness,
  nodes: num,
  emitted: num,
});
const impact = record(
  {
    ecosystem: str,
    project: str,
    name: str,
    graph: graphCompleteness,
    transitive: integerOrNull,
    exclusive: integerOrNull,
  },
  {
    limited: "true",
    footprint: record({
      approximate: "true",
      basis: str,
      bytes: num,
      coverage: record({ sized: num, total: num }),
    }),
  },
);
const scopeRoot = record({ root: str, matched: bool, files: num, manifests: num });
const scanScope = record({
  source: enumOf("none", "repo-config", "per-run-override"),
  schemaVersion: oneOf(enumOf(1), "null"),
  digest: str,
  configDigest: stringOrNull,
  overrideDigest: stringOrNull,
  analysedSha: stringOrNull,
  roots: [scopeRoot],
  matchedRoots: num,
  excludedFiles: num,
  excludedManifests: num,
  countingComplete: "true",
  builtInPolicy: enumOf("default-v1"),
});
const nativeBase = record(
  {
    ruleId: str,
    dependency: str,
    declaringManifest: manifest,
    status: enumOf("produced", "blocked", "no-verdict"),
  },
  { pillar: str, reason: str },
);
const resultSpec = record(
  {
    schemaVersion: num,
    projects: [project],
    dependencies: [dependency],
    usages: [usage],
    findings: [finding],
    detected: [record({ ecosystem: str, confidence, evidence: [evidence] })],
    surface: [surface],
    projectTree: [projectNode],
    graph: record({ nodes: [graphNode], ecosystems: [graphEcosystem], truncated: bool }),
    impact: [impact],
  },
  {
    nativeEvaluations: [nativeBase],
    scanScope,
  },
);

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function check(value: unknown, spec: Spec, depth = 0): boolean {
  if (depth > 32) return false;
  if (spec === "string") return typeof value === "string";
  if (spec === "integer")
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (spec === "boolean") return typeof value === "boolean";
  if (spec === "true") return value === true;
  if (spec === "null") return value === null;
  if ("anyOf" in spec) return spec.anyOf.some((choice) => check(value, choice, depth + 1));
  if ("enum" in spec) return spec.enum.includes(value as never);
  if (Array.isArray(spec))
    return Array.isArray(value) && value.every((entry) => check(entry, spec[0]!, depth + 1));
  if (!object(value)) return false;
  const shape = spec as { required: Record<string, Spec>; optional?: Record<string, Spec> };
  const allowed = { ...shape.required, ...shape.optional };
  if (
    Object.keys(shape.required).some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !Object.hasOwn(allowed, key))
  )
    return false;
  return Object.entries(value).every(([key, entry]) => check(entry, allowed[key]!, depth + 1));
}

/** Validate discriminated surfaces. This is not provenance or verdict authentication. */
function checkResultInvariants(value: Record<string, unknown>): boolean {
  const findings = value.findings as Record<string, unknown>[];
  const native = (value.nativeEvaluations ?? []) as Record<string, unknown>[];
  if (
    native.some(
      (n) =>
        (n.status === "produced" && ("pillar" in n || "reason" in n)) ||
        (n.status === "blocked" &&
          (typeof n.pillar !== "string" || typeof n.reason !== "string")) ||
        (n.status === "no-verdict" && ("pillar" in n || typeof n.reason !== "string")),
    )
  )
    return false;
  if (
    findings.some(
      (f) =>
        (f.kind === "info" && f.severity !== "info") ||
        (f.awareness === true && f.kind !== "info") ||
        (f.adapterNote === true && f.kind !== "info") ||
        (f.healthFact === true && f.kind !== "info"),
    )
  )
    return false;
  return true;
}

/** Acceptance is all-or-nothing. Never coerce, truncate or default a missing surface. */
export function validateAnalysisResult(value: unknown): AnalysisResult {
  if (
    !check(value, resultSpec) ||
    !object(value) ||
    value.schemaVersion !== 1 ||
    !checkResultInvariants(value)
  ) {
    throw new AnalysisProtocolError("BAD_RESULT_SCHEMA");
  }
  return value as unknown as AnalysisResult;
}
