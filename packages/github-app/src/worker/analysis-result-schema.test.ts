import assert from "node:assert/strict";
import { test } from "node:test";
import { analyseDirectory, type EcosystemAdapter, adapterApiVersion } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAnalysisResult } from "./analysis-result-schema.js";
import { AnalysisProtocolError } from "./analysis-protocol.js";

const empty = {
  schemaVersion: 1,
  projects: [],
  dependencies: [],
  usages: [],
  findings: [],
  detected: [],
  surface: [],
  projectTree: [],
  graph: { nodes: [], ecosystems: [], truncated: false },
  impact: [],
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function rejected(value: unknown): void {
  assert.throws(
    () => validateAnalysisResult(value),
    (error: unknown) =>
      error instanceof AnalysisProtocolError && error.code === "BAD_RESULT_SCHEMA",
  );
}

test("accepts complete empty result and optional graph/scope/native surfaces", () => {
  assert.deepEqual(validateAnalysisResult(empty), empty);
  const result = {
    ...empty,
    projectTree: [{ id: "javascript-typescript:.", ecosystem: "javascript-typescript", path: "." }],
    graph: {
      nodes: [],
      ecosystems: [{ ecosystem: "javascript-typescript", graphs: "none", nodes: 0, emitted: 0 }],
      truncated: false,
    },
    impact: [
      {
        ecosystem: "javascript-typescript",
        project: ".",
        name: "x",
        graph: "none",
        transitive: null,
        exclusive: null,
      },
    ],
    nativeEvaluations: [
      {
        ruleId: "native",
        dependency: "x",
        declaringManifest: { ecosystem: "javascript-typescript", path: "package.json" },
        status: "blocked",
        pillar: "runtime",
        reason: "unknown",
      },
    ],
    scanScope: {
      source: "none",
      schemaVersion: null,
      digest: "d",
      configDigest: null,
      overrideDigest: null,
      analysedSha: null,
      roots: [],
      matchedRoots: 0,
      excludedFiles: 0,
      excludedManifests: 0,
      countingComplete: true,
      builtInPolicy: "default-v1",
    },
  };
  assert.deepEqual(validateAnalysisResult(result), result);
});

test("rejects missing surfaces, extra fields and invalid verdict semantics", () => {
  const missing = clone(empty) as Record<string, unknown>;
  delete missing.usages;
  rejected(missing);
  rejected({ ...empty, credential: "secret" });
  rejected({ ...empty, schemaVersion: 2 });
  rejected({
    ...empty,
    findings: [
      {
        kind: "unused",
        summary: "drop",
        recommendation: "drop",
        evidence: [],
        confidence: "invented",
        limitations: [],
        affectedFiles: [],
      },
    ],
  });
  rejected({
    ...empty,
    findings: [
      {
        kind: "unused",
        summary: "drop",
        recommendation: "drop",
        evidence: [],
        confidence: "high",
        limitations: [],
        affectedFiles: [],
        action: "run code",
      },
    ],
  });
  rejected({
    ...empty,
    usages: [{ dependency: "x", file: "a", line: -1, form: "static", symbols: [] }],
  });
  rejected({
    ...empty,
    surface: [{ ecosystem: "x", direct: 1, transitive: 0, graphs: "complete!" }],
  });
  rejected({ ...empty, scanScope: { source: "none" } });
  const noGraph = clone(empty) as Record<string, unknown>;
  delete noGraph.graph;
  rejected(noGraph);
  rejected({
    ...empty,
    nativeEvaluations: [
      {
        ruleId: "r",
        dependency: "x",
        declaringManifest: { ecosystem: "js", path: "package.json" },
        status: "produced",
        reason: "fake",
      },
    ],
  });
});

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/js/basic-unused",
);
const adapter: EcosystemAdapter = {
  ecosystem: "javascript-typescript",
  apiVersion: adapterApiVersion,
  capabilities: new Set(),
  async detect(ctx) {
    const found = await ctx.repository.exists("package.json");
    return {
      confidence: found ? 1 : 0,
      projects: found
        ? [{ path: ".", ecosystem: "javascript-typescript", packageManagers: [] }]
        : [],
      evidence: found
        ? [{ kind: "manifest-found", statement: "package.json", file: "package.json" }]
        : [],
    };
  },
  async listDirectDependencies(ctx, projects) {
    const manifest = JSON.parse(await ctx.repository.readFile("package.json")) as {
      dependencies?: Record<string, string>;
    };
    return Object.entries(manifest.dependencies ?? {}).map(([name, constraint]) => ({
      name,
      constraint,
      kind: "runtime" as const,
      project: projects[0]!,
      declaredIn: "package.json",
    }));
  },
};
test("accepts a real current engine result, rejects mutation of nested surfaces", async () => {
  const real = await analyseDirectory(fixture, { adapters: [adapter] });
  assert.ok(real.dependencies.length > 0);
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(real))), real);
  rejected({
    ...real,
    dependencies: real.dependencies.map((dependency) => ({
      ...dependency,
      project: { ...dependency.project, escape: true },
    })),
  });
});

test("accepts full production JavaScript adapter output", async () => {
  const real = await analyseDirectory(fixture, { adapters: [createJavaScriptTypeScriptAdapter()] });
  assert.ok(real.dependencies.length > 0);
  assert.deepEqual(validateAnalysisResult(JSON.parse(JSON.stringify(real))), real);
});

const FINDING_KINDS = [
  "unused",
  "potentially-unnecessary",
  "duplicate-capability",
  "maintenance-risk",
  "footprint",
  "should-be-dev",
  "type-only",
  "info",
] as const;
const baseFinding = {
  kind: "unused",
  summary: "s",
  recommendation: "r",
  evidence: [],
  confidence: "high",
  limitations: [],
  affectedFiles: [],
};
const baseNative = {
  ruleId: "r",
  dependency: "x",
  declaringManifest: { ecosystem: "js", path: "package.json" },
};
const withFindings = (findings: unknown[]) => ({ ...empty, findings });
const withNative = (nativeEvaluations: unknown[]) => ({ ...empty, nativeEvaluations });

test("enforces the full native-evaluation status x pillar x reason matrix", () => {
  const statuses = ["produced", "blocked", "no-verdict"] as const;
  for (const status of statuses)
    for (const pillar of [undefined, "p"])
      for (const reason of [undefined, "r"]) {
        const entry = {
          ...baseNative,
          status,
          ...(pillar ? { pillar } : {}),
          ...(reason ? { reason } : {}),
        };
        const valid =
          (status === "produced" && !pillar && !reason) ||
          (status === "blocked" && pillar && reason) ||
          (status === "no-verdict" && !pillar && reason);
        if (valid) assert.ok(validateAnalysisResult(withNative([entry])));
        else rejected(withNative([entry]));
      }
  rejected(withNative([{ ...baseNative, status: "blocked", pillar: 1, reason: "r" }]));
  rejected(withNative([{ ...baseNative, status: "blocked", pillar: "p", reason: ["r"] }]));
});

test("enforces the finding-kind x flag matrix for awareness, adapterNote and healthFact", () => {
  for (const flag of ["awareness", "adapterNote", "healthFact"] as const)
    for (const kind of FINDING_KINDS) {
      const finding =
        kind === "info"
          ? { ...baseFinding, kind, severity: "info", [flag]: true }
          : { ...baseFinding, kind, [flag]: true };
      if (kind === "info") assert.ok(validateAnalysisResult(withFindings([finding])));
      else rejected(withFindings([finding]));
    }
  rejected(withFindings([{ ...baseFinding, kind: "unused", awareness: false }]));
  rejected(withFindings([{ ...baseFinding, kind: "unused", awareness: "true" }]));
});

test("enforces the info-kind severity rule one way only", () => {
  for (const severity of ["critical", "high", "medium", "low", "info"] as const) {
    const finding = { ...baseFinding, kind: "info", severity };
    if (severity === "info") assert.ok(validateAnalysisResult(withFindings([finding])));
    else rejected(withFindings([finding]));
  }
  rejected(withFindings([{ ...baseFinding, kind: "info" }]));
  assert.ok(
    validateAnalysisResult(withFindings([{ ...baseFinding, kind: "unused", severity: "info" }])),
  );
});

test("rejects the whole result when one entry among many breaks an invariant", () => {
  const goodNative = { ...baseNative, status: "no-verdict", reason: "r" };
  const badNative = { ...baseNative, status: "produced", pillar: "p" };
  rejected(withNative([goodNative, badNative, goodNative]));
  const goodFinding = { ...baseFinding, kind: "info", severity: "info", awareness: true };
  const badFinding = { ...baseFinding, kind: "unused", healthFact: true };
  rejected(withFindings([goodFinding, badFinding]));
});
