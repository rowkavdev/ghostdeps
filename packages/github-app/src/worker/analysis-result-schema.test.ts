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
