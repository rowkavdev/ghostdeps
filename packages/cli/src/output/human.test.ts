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
        {
          kind: "info",
          rule: "unverified-no-imports",
          dependency: "eslint",
          summary: "no imports of eslint found; scripts and config were not checked",
          recommendation: "review",
          evidence: [{ kind: "no-usage-found", statement: "no import of eslint found" }],
          confidence: "low",
          limitations: [],
          affectedFiles: [],
        },
        ...makeFindings("info", 1),
      ],
      detected: [
        { ecosystem: "javascript-typescript", confidence: "high", evidence: [] },
        { ecosystem: "python", confidence: "high", evidence: [] },
        { ecosystem: "rust", confidence: "high", evidence: [] },
      ],
      surface: [
        { ecosystem: "javascript-typescript", direct: 60, transitive: 900, graphs: "complete" },
        { ecosystem: "python", direct: 30, transitive: 400, graphs: "complete" },
        { ecosystem: "rust", direct: 22, transitive: 182, graphs: "complete" },
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
      "  2 info",
      "",
      "Verdicts:",
      "  unused:",
      "    (repository-wide) - unused finding 0 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - unused finding 1 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - unused finding 2 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - unused finding 3 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - unused finding 4 (high confidence)",
      "      - test evidence",
      "  potentially unnecessary:",
      "    (repository-wide) - potentially-unnecessary finding 0 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 1 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 2 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 3 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 4 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 5 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 6 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - potentially-unnecessary finding 7 (high confidence)",
      "      - test evidence",
      "  duplicate capabilities:",
      "    (repository-wide) - duplicate-capability finding 0 (high confidence)",
      "      - test evidence",
      "    (repository-wide) - duplicate-capability finding 1 (high confidence)",
      "      - test evidence",
      "",
      "Awareness notes:",
      "    eslint - no imports of eslint found; scripts and config were not checked (low confidence, rule: unverified-no-imports)",
      "      - no import of eslint found",
      "    (repository-wide) - info finding 0 (high confidence)",
      "      - test evidence",
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

  it("says unknown when every surface entry has graphs: none", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [rootProject],
      dependencies: makeDeps(1),
      detected: [{ ecosystem: "javascript-typescript", confidence: "high", evidence: [] }],
      surface: [{ ecosystem: "javascript-typescript", direct: 1, transitive: 0, graphs: "none" }],
    };
    assert.ok(renderRepositorySummary(result).includes("Transitive dependencies:\n  unknown"));
  });

  it("marks a partial graph total as a lower bound", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [rootProject],
      dependencies: makeDeps(2),
      detected: [{ ecosystem: "javascript-typescript", confidence: "high", evidence: [] }],
      surface: [
        { ecosystem: "javascript-typescript", direct: 2, transitive: 42, graphs: "partial" },
      ],
    };
    assert.ok(renderRepositorySummary(result).includes("Transitive dependencies:\n  at least 42"));
  });

  it("reads a missing graphs marker as never complete, keeping the lower bound", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [rootProject],
      dependencies: makeDeps(1),
      detected: [{ ecosystem: "javascript-typescript", confidence: "high", evidence: [] }],
      surface: [{ ecosystem: "javascript-typescript", direct: 1, transitive: 7 }],
    };
    const text = renderRepositorySummary(result);
    assert.ok(text.includes("Transitive dependencies:\n  at least 7"));
    assert.ok(!text.includes("Transitive dependencies:\n  7\n"));
  });

  it("mixes complete and partial graphs into one lower bound", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      projects: [rootProject],
      dependencies: makeDeps(2),
      detected: [
        { ecosystem: "javascript-typescript", confidence: "high", evidence: [] },
        { ecosystem: "python", confidence: "high", evidence: [] },
      ],
      surface: [
        { ecosystem: "javascript-typescript", direct: 1, transitive: 900, graphs: "complete" },
        { ecosystem: "python", direct: 1, transitive: 400, graphs: "partial" },
      ],
    };
    assert.ok(
      renderRepositorySummary(result).includes("Transitive dependencies:\n  at least 1,300"),
    );
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

  it("renders verdicts grouped by kind, info as awareness notes", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [
        {
          kind: "unused",
          rule: "unused",
          dependency: "left-pad",
          summary: "left-pad is declared but never used",
          recommendation: "Remove left-pad.",
          evidence: [{ kind: "no-import-found", statement: "no import of left-pad found" }],
          confidence: "high",
          limitations: [],
          affectedFiles: ["package.json"],
        },
        {
          kind: "should-be-dev",
          rule: "should-be-dev",
          dependency: "typescript",
          summary: "typescript is imported only from tests and build config",
          recommendation: "Move typescript to devDependencies.",
          evidence: [{ kind: "test-import", statement: "imports found only under test/" }],
          confidence: "medium",
          limitations: [],
          affectedFiles: ["package.json"],
        },
        ...makeFindings("info", 2),
      ],
    };
    const text = renderRepositorySummary(result);
    assert.match(text, /Findings:\n {2}1 unused\n {2}1 should be dev dependencies\n {2}2 info/);
    assert.ok(
      text.includes(
        [
          "Verdicts:",
          "  unused:",
          "    left-pad - left-pad is declared but never used (high confidence, rule: unused)",
          "      - no import of left-pad found",
          "  should be dev dependencies:",
          "    typescript - typescript is imported only from tests and build config (medium confidence, rule: should-be-dev)",
          "      - imports found only under test/",
        ].join("\n"),
      ),
      text,
    );
    // Info findings render as awareness notes, never as verdict lines.
    const verdictsEnd = text.indexOf("Awareness notes:");
    assert.ok(verdictsEnd > 0, text);
    assert.ok(!text.slice(0, verdictsEnd).includes("info finding 0 -"), text);
    assert.ok(
      text.includes(
        [
          "Awareness notes:",
          "    (repository-wide) - info finding 0 (high confidence)",
          "      - test evidence",
          "    (repository-wide) - info finding 1 (high confidence)",
          "      - test evidence",
        ].join("\n"),
      ),
      text,
    );
  });

  it("omits the Verdicts section when every finding is info", () => {
    const result: AnalysisResult = { ...emptyResult(), findings: makeFindings("info", 2) };
    const text = renderRepositorySummary(result);
    assert.ok(!text.includes("Verdicts:"));
    assert.ok(text.includes("Awareness notes:"));
  });

  it("caps long evidence lists with a +N more line and escapes verdict text", () => {
    const evidence = Array.from({ length: 11 }, (_, i) => ({
      kind: "e",
      statement: `evidence line ${i}`,
    }));
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [
        {
          kind: "unused",
          dependency: "evil\u001B[8;;https://bad.example",
          summary: "declared but never used",
          recommendation: "Remove it.",
          evidence,
          confidence: "high",
          limitations: [],
          affectedFiles: [],
        },
      ],
    };
    const text = renderRepositorySummary(result);
    assert.ok(!text.includes("\u001B"), "raw ESC must never reach the terminal");
    assert.ok(text.includes("evil\uFFFD[8;;https://bad.example - declared but never used"), text);
    assert.ok(text.includes("- ... and 3 more"), text);
  });
});
