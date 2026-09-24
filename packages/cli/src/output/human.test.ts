import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult, Dependency, Finding, FindingKind, ProjectRef } from "@ghostdeps/core";
import { renderRepositorySummary } from "./human.js";

const rootProject: ProjectRef = {
  path: ".",
  ecosystem: "javascript-typescript",
  packageManagers: [],
};

function makeDeps(count: number): Dependency[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `dep-${i}`,
    constraint: "^1.0.0",
    kind: "runtime" as const,
    project: rootProject,
    declaredIn: "package.json",
  }));
}

function makeFindings(kind: FindingKind, count: number): Finding[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    summary: `${kind} finding ${i}`,
    recommendation: "review",
    evidence: [{ kind: "test", statement: "test evidence" }],
    confidence: "high" as const,
    limitations: [],
    affectedFiles: [],
  }));
}

function emptyResult(): AnalysisResult {
  return {
    schemaVersion: 1,
    projects: [],
    dependencies: [],
    usages: [],
    findings: [],
    detected: [],
    surface: [],
  };
}

describe("renderRepositorySummary", () => {
  it("matches the canonical repository summary format", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [
        {
          path: ".",
          ecosystem: "javascript-typescript",
          packageManagers: [{ name: "pnpm", lockfile: "pnpm-lock.yaml" }],
        },
        {
          path: "api",
          ecosystem: "python",
          packageManagers: [{ name: "uv", lockfile: "uv.lock" }],
        },
        {
          path: "agent",
          ecosystem: "rust",
          packageManagers: [{ name: "Cargo", lockfile: "Cargo.lock" }],
        },
      ],
      dependencies: makeDeps(112),
      findings: [
        ...makeFindings("unused", 5),
        ...makeFindings("potentially-unnecessary", 8),
        ...makeFindings("duplicate-capability", 2),
      ],
      detected: [
        { ecosystem: "javascript-typescript", confidence: "high", evidence: [] },
        { ecosystem: "python", confidence: "high", evidence: [] },
        { ecosystem: "rust", confidence: "high", evidence: [] },
      ],
      surface: [
        { ecosystem: "javascript-typescript", direct: 60, transitive: 900 },
        { ecosystem: "python", direct: 30, transitive: 400 },
        { ecosystem: "rust", direct: 22, transitive: 182 },
      ],
    };

    const expected = [
      "GhostDeps",
      "",
      "Languages:",
      "  JavaScript/TypeScript",
      "  Python",
      "  Rust",
      "",
      "Package managers:",
      "  pnpm",
      "  uv",
      "  Cargo",
      "",
      "Direct dependencies:",
      "  112",
      "",
      "Transitive dependencies:",
      "  1,482",
      "",
      "Findings:",
      "  5 unused",
      "  8 potentially unnecessary",
      "  2 duplicate capabilities",
    ].join("\n");

    assert.equal(renderRepositorySummary(result), expected);
  });

  it("renders an empty result honestly", () => {
    const expected = [
      "GhostDeps",
      "",
      "Languages:",
      "  none detected",
      "",
      "Package managers:",
      "  none detected",
      "",
      "Direct dependencies:",
      "  0",
      "",
      "Transitive dependencies:",
      "  unknown",
      "",
      "Findings:",
      "  none",
    ].join("\n");
    assert.equal(renderRepositorySummary(emptyResult()), expected);
  });

  it("says unknown for transitive totals when no graph was built", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [rootProject],
      dependencies: makeDeps(3),
      detected: [{ ecosystem: "javascript-typescript", confidence: "medium", evidence: [] }],
    };
    assert.ok(renderRepositorySummary(result).includes("Transitive dependencies:\n  unknown"));
  });

  it("dedupes package managers across monorepo projects", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [
        { path: ".", ecosystem: "javascript-typescript", packageManagers: [{ name: "pnpm" }] },
        { path: "web", ecosystem: "javascript-typescript", packageManagers: [{ name: "pnpm" }] },
      ],
      detected: [{ ecosystem: "javascript-typescript", confidence: "high", evidence: [] }],
    };
    assert.ok(renderRepositorySummary(result).includes("Package managers:\n  pnpm\n"));
  });

  it("omits zero-count finding kinds and keeps canonical order", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [...makeFindings("duplicate-capability", 1), ...makeFindings("unused", 2)],
    };
    assert.ok(
      renderRepositorySummary(result).includes("Findings:\n  2 unused\n  1 duplicate capabilities"),
    );
  });

  it("groups thousands in dependency counts", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      dependencies: makeDeps(1234),
    };
    assert.ok(renderRepositorySummary(result).includes("Direct dependencies:\n  1,234"));
  });

  it("escapes repository-derived package-manager names for the terminal", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [
        {
          path: ".",
          ecosystem: "javascript-typescript",
          packageManagers: [{ name: "pm\u001B[2Jevil" }],
        },
      ],
      detected: [{ ecosystem: "javascript-typescript", confidence: "high", evidence: [] }],
    };
    const text = renderRepositorySummary(result);
    assert.ok(!text.includes("\u001B"), "no raw ESC reaches the terminal");
    assert.ok(text.includes("pm\uFFFD[2Jevil"), text);
  });

  it("escapes unknown ecosystem ids for the terminal", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      detected: [{ ecosystem: "evi\u202El", confidence: "low", evidence: [] }],
    };
    const text = renderRepositorySummary(result);
    assert.ok(text.includes("Evi\uFFFDl"), text);
  });
});
