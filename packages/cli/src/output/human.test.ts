import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AnalysisResult,
  Dependency,
  DependencyImpact,
  Finding,
  FindingKind,
  ProjectRef,
} from "@ghostdeps/core";
import { formatBytes, renderRepositorySummary } from "./human.js";

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

describe("opt-in Scan scope rendering", () => {
  it("names unmatched roots even on an otherwise clean result", () => {
    const result = {
      ...emptyResult(),
      scanScope: {
        source: "repo-config" as const,
        schemaVersion: 1 as const,
        digest: "a".repeat(64),
        roots: [{ root: "missing", matched: false, files: 0, manifests: 0 }],
        matchedRoots: 0,
        excludedFiles: 0,
        excludedManifests: 0,
        countingComplete: true as const,
        builtInPolicy: "default-v1" as const,
      },
    };
    const output = renderRepositorySummary(result);
    assert.match(output, /Scan scope:/);
    assert.match(output, /missing: unmatched \(0 files, 0 recognised manifests excluded\)/);
    assert.match(output, /Findings:\n  none/);
  });
});

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
        {
          kind: "info",
          rule: "cross-ecosystem-capability-overlap",
          dependency: "left-pad",
          summary: "left-pad provides the same capability as left_pad (pip)",
          recommendation: "No action suggested.",
          evidence: [{ kind: "capability-overlap", statement: "same capability in npm and pip" }],
          confidence: "high",
          awareness: true,
          limitations: [],
          affectedFiles: [],
        },
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
      "Notes:",
      "    eslint - no imports of eslint found; scripts and config were not checked (low confidence, rule: unverified-no-imports)",
      "      - no import of eslint found",
      "    (repository-wide) - info finding 0 (high confidence)",
      "      - test evidence",
      "",
      "Awareness notes:",
      "    left-pad - left-pad provides the same capability as left_pad (pip) (high confidence, rule: cross-ecosystem-capability-overlap)",
      "      - same capability in npm and pip",
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

  it("renders verdicts grouped by kind, unflagged info findings as notes", () => {
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
    // Info findings without the awareness flag render as notes, never as
    // verdict lines.
    const verdictsEnd = text.indexOf("Notes:");
    assert.ok(verdictsEnd > 0, text);
    assert.ok(!text.slice(0, verdictsEnd).includes("info finding 0 -"), text);
    assert.ok(
      text.includes(
        [
          "Notes:",
          "    (repository-wide) - info finding 0 (high confidence)",
          "      - test evidence",
          "    (repository-wide) - info finding 1 (high confidence)",
          "      - test evidence",
        ].join("\n"),
      ),
      text,
    );
  });

  it("splits info findings into notes and awareness notes on the core flag (#234)", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [
        ...makeFindings("info", 1),
        {
          kind: "info",
          rule: "cross-ecosystem-capability-overlap",
          dependency: "left-pad",
          summary: "same capability in another ecosystem",
          recommendation: "No action suggested.",
          evidence: [{ kind: "capability-overlap", statement: "overlap in npm and pip" }],
          confidence: "high",
          awareness: true,
          limitations: [],
          affectedFiles: [],
        },
      ],
    };
    const text = renderRepositorySummary(result);
    assert.ok(!text.includes("Verdicts:"), text);
    const notesAt = text.indexOf("Notes:");
    const awarenessAt = text.indexOf("Awareness notes:");
    assert.ok(notesAt > 0, text);
    assert.ok(awarenessAt > notesAt, text);
    assert.ok(
      text.includes(
        "Awareness notes:\n    left-pad - same capability in another ecosystem (high confidence, rule: cross-ecosystem-capability-overlap)",
      ),
      text,
    );
    assert.ok(!text.slice(0, awarenessAt).includes("cross-ecosystem-capability-overlap"), text);
  });

  it("prints Findings: none for an awareness-only result, keeping the section (#234)", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [
        {
          kind: "info",
          rule: "cross-ecosystem-capability-overlap",
          dependency: "axios",
          summary: "axios overlaps requests",
          recommendation: "No action suggested.",
          evidence: [{ kind: "capability-overlap", statement: "same capability in npm and pip" }],
          confidence: "high",
          awareness: true,
          limitations: [],
          affectedFiles: [],
        },
      ],
    };
    const text = renderRepositorySummary(result);
    assert.ok(text.includes("Findings:\n  none"), text);
    assert.ok(!text.includes("1 info"), text);
    assert.ok(
      text.includes(
        "Awareness notes:\n    axios - axios overlaps requests (high confidence, rule: cross-ecosystem-capability-overlap)",
      ),
      text,
    );
  });

  it("lists health facts in a Package facts section with structured provenance (#385)", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [
        {
          kind: "info",
          rule: "locked-version-published",
          dependency: "left-pad",
          summary: "left-pad locked version 1.3.0 published 2022-01-02T00:00:00Z",
          recommendation: "Review the source-backed status before changing this dependency.",
          evidence: [
            { kind: "locked-version-published", statement: "source: npm registry time[version]" },
          ],
          confidence: "high",
          healthFact: true,
          source: { kind: "registry", basis: "npm registry time[version]" },
          declaringManifest: { ecosystem: "javascript-typescript", path: "package.json" },
          limitations: [],
          affectedFiles: [],
        },
      ],
    };
    const text = renderRepositorySummary(result);
    assert.ok(
      text.includes(
        "Package facts:\n    left-pad - left-pad locked version 1.3.0 published 2022-01-02T00:00:00Z (source: npm registry time[version]; declared in package.json, javascript-typescript)",
      ),
      text,
    );
  });

  it("keeps facts out of the tally, the verdicts and the notes (#385)", () => {
    const fact: Finding = {
      kind: "info",
      rule: "registry-deprecated",
      dependency: "moment",
      summary: "moment is marked deprecated",
      recommendation: "Review the source-backed status before changing this dependency.",
      evidence: [{ kind: "registry-deprecated", statement: "source: npm registry deprecated" }],
      confidence: "high",
      healthFact: true,
      source: { kind: "registry", basis: "npm registry deprecated" },
      declaringManifest: { ecosystem: "javascript-typescript", path: "package.json" },
      limitations: [],
      affectedFiles: [],
    };
    const text = renderRepositorySummary({ ...emptyResult(), findings: [fact] });
    assert.ok(text.includes("Findings:\n  none"), text);
    assert.ok(!text.includes("Verdicts:"), text);
    assert.ok(!text.includes("Notes:"), text);
    assert.ok(text.includes("Package facts:"), text);
    // Facts render before Notes in canonical order.
    const factsAt = text.indexOf("Package facts:");
    const verdictText = renderRepositorySummary({
      ...emptyResult(),
      findings: [...makeFindings("unused", 1), fact],
    });
    assert.ok(
      verdictText.indexOf("Verdicts:") < verdictText.indexOf("Package facts:"),
      verdictText,
    );
    assert.ok(factsAt > 0, text);
  });

  it("renders a fact without provenance fields as a bare summary line (#385)", () => {
    const result: AnalysisResult = {
      ...emptyResult(),
      findings: [
        {
          kind: "info",
          rule: "locked-version-published",
          dependency: "chalk",
          summary: "chalk locked version 4.1.2 published 2024-06-01T00:00:00Z",
          recommendation: "review",
          evidence: [],
          confidence: "high",
          healthFact: true,
          limitations: [],
          affectedFiles: [],
        },
      ],
    };
    const text = renderRepositorySummary(result);
    assert.ok(
      text.includes(
        "Package facts:\n    chalk - chalk locked version 4.1.2 published 2024-06-01T00:00:00Z",
      ),
      text,
    );
  });

  it("omits the Verdicts section when every finding is info", () => {
    const result: AnalysisResult = { ...emptyResult(), findings: makeFindings("info", 2) };
    const text = renderRepositorySummary(result);
    assert.ok(!text.includes("Verdicts:"));
    assert.ok(text.includes("Notes:"));
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

  describe("impact lines (#59 C)", () => {
    const verdict = (
      dependency: string,
      kind: FindingKind = "unused",
      files = ["package.json"],
    ): Finding => ({
      kind,
      dependency,
      summary: "declared but never imported",
      recommendation: "remove",
      evidence: [{ kind: "no-usage-found", statement: "no import found" }],
      confidence: "high",
      limitations: [],
      affectedFiles: files,
    });
    const impact = (name: string, extra: Partial<DependencyImpact> = {}) => ({
      ecosystem: "javascript-typescript",
      project: ".",
      name,
      graph: "complete" as const,
      transitive: 12,
      exclusive: 3,
      ...extra,
    });
    const render = (findings: Finding[], entries: ReturnType<typeof impact>[]) =>
      renderRepositorySummary({ ...emptyResult(), findings, impact: entries });

    it("adds counts and footprint under a removal verdict", () => {
      const out = render(
        [verdict("left-pad")],
        [
          impact("left-pad", {
            footprint: {
              approximate: true,
              basis: "npm unpackedSize",
              bytes: 1_400_000,
              coverage: { sized: 11, total: 13 },
            },
          }),
        ],
      );
      assert.match(
        out,
        /\n {6}- no import found\n {6}- impact: 12 transitive packages; removing it drops 3 of them; at least 1\.4 MB installed \(11 of 13 packages sized, npm unpackedSize\)/,
      );
    });

    it("says at least on a partial graph and skips unknown removal counts", () => {
      const out = render([verdict("a")], [impact("a", { graph: "partial", exclusive: null })]);
      assert.match(out, /- impact: at least 12 transitive packages$/m);
    });

    it("says no other packages for exclusive 0 and singular for 1", () => {
      const out = render([verdict("a")], [impact("a", { transitive: 1, exclusive: 0 })]);
      assert.match(out, /- impact: 1 transitive package; removing it drops no other packages$/m);
    });

    it("prints nothing for unknown or limited counts", () => {
      for (const extra of [{ transitive: null, exclusive: null }, { limited: true as const }]) {
        assert.doesNotMatch(render([verdict("a")], [impact("a", extra)]), /impact:/);
      }
    });

    it("prints nothing for non-removal verdicts", () => {
      assert.doesNotMatch(render([verdict("a", "should-be-dev")], [impact("a")]), /impact:/);
    });

    it("picks the declaring project, and prints nothing when ambiguous", () => {
      const entries = [
        impact("a", { transitive: 5 }),
        impact("a", { project: "web", transitive: 9 }),
      ];
      assert.match(render([verdict("a", "unused", ["web/package.json"])], entries), /impact: 9 /);
      assert.match(render([verdict("a")], entries), /impact: 5 /);
      assert.doesNotMatch(render([verdict("a", "unused", [])], entries), /impact:/);
    });

    it("escapes the provider basis", () => {
      const out = render(
        [verdict("a")],
        [
          impact("a", {
            footprint: {
              approximate: true,
              basis: "x\u001b[31m",
              bytes: 5,
              coverage: { sized: 1, total: 1 },
            },
          }),
        ],
      );
      assert.ok(!out.includes("\u001b"));
      assert.match(out, /at least 5 B installed/);
    });
  });
});

describe("formatBytes", () => {
  it("rolls over to the next unit after rounding", () => {
    assert.equal(formatBytes(999), "999 B");
    assert.equal(formatBytes(1000), "1.0 kB");
    assert.equal(formatBytes(999_949), "999.9 kB");
    assert.equal(formatBytes(999_950), "1.0 MB");
    assert.equal(formatBytes(1_400_000), "1.4 MB");
    assert.equal(formatBytes(999_950_000), "1.0 GB");
  });
});
