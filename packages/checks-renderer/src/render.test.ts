import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult, Finding } from "@ghostdeps/core";
import { addedLinesFromFiles, addedLinesFromPatch } from "./diff.js";
import { incompleteTitle, maxAnnotations, md, quietSummary, renderCheck } from "./render.js";

function result(findings: Finding[]): AnalysisResult {
  return {
    schemaVersion: 1,
    projects: [],
    dependencies: [],
    usages: [],
    findings,
    detected: [],
    surface: [],
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    kind: "unused",
    dependency: "left-pad",
    summary: "left-pad is declared but never imported",
    recommendation: "Remove left-pad from dependencies",
    evidence: [
      { kind: "declared", statement: "declared in package.json", file: "package.json", line: 12 },
    ],
    confidence: "high",
    limitations: [],
    affectedFiles: ["package.json"],
    ...over,
  };
}

const added = new Map([["package.json", new Set([12])]]);

describe("opt-in Scan scope rendering", () => {
  const scope = {
    source: "repo-config" as const,
    schemaVersion: 1 as const,
    digest: "b".repeat(64),
    roots: [{ root: "missing", matched: false, files: 0, manifests: 0 }],
    matchedRoots: 0,
    excludedFiles: 0,
    excludedManifests: 0,
    countingComplete: true as const,
    builtInPolicy: "default-v1" as const,
  };
  it("names an unmatched root and keeps a complete finding-free result successful", () => {
    const check = renderCheck({ ...result([]), scanScope: scope }, new Map());
    assert.equal(check.conclusion, "success");
    assert.match(check.output.summary, /Scan scope/);
    assert.match(check.output.summary, /missing: unmatched/);
    assert.match(check.output.summary, /0 files/);
  });
  it("makes omitted declarations neutral, even without a finding", () => {
    const check = renderCheck(
      {
        ...result([]),
        scanScope: {
          ...scope,
          roots: [{ root: "fixtures", matched: true, files: 2, manifests: 1 }],
          matchedRoots: 1,
          excludedFiles: 2,
          excludedManifests: 1,
        },
      },
      new Map(),
    );
    assert.equal(check.conclusion, "neutral");
    assert.match(check.output.summary, /fixtures/);
    assert.match(check.output.summary, /2 files/);
  });
});

describe("addedLinesFromPatch", () => {
  it("returns new-file line numbers of added lines only", () => {
    const patch = [
      "@@ -10,4 +10,5 @@",
      " a",
      "-b",
      "+B",
      "+C",
      " d",
      "\\ No newline at end of file",
    ].join("\n");
    assert.deepEqual([...addedLinesFromPatch(patch)], [11, 12]);
  });

  it("handles multiple hunks and missing patches", () => {
    const patch = ["@@ -1 +1 @@", "-x", "+y", "@@ -20,2 +20,3 @@", " p", "+q", " r"].join("\n");
    assert.deepEqual([...addedLinesFromPatch(patch)], [1, 21]);
    assert.equal(addedLinesFromPatch(undefined).size, 0);
    assert.equal(addedLinesFromFiles([{ filename: "bin.png" }]).size, 0);
  });
});

describe("renderCheck", () => {
  it("is success with the quiet summary when there are no findings", () => {
    const out = renderCheck(result([]), added);
    assert.equal(out.conclusion, "success");
    assert.equal(out.output.summary, quietSummary);
    assert.equal(out.output.annotations.length, 0);
  });

  const capNote: Finding = {
    ...finding(),
    kind: "info",
    summary: "unused confidence capped pending corpus validation",
    evidence: [{ kind: "unused-confidence-capped", statement: "capped" }],
  };
  delete (capNote as { dependency?: string }).dependency;

  it("keeps run-level notes out of the title, count and headline (#195)", () => {
    const unused = finding({ confidence: "medium" });
    const out = renderCheck(result([capNote, unused]), added);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, "1 dependency finding to review");
    const s = out.output.summary;
    assert.match(s, /^GhostDeps found 1 finding worth review/);
    assert.doesNotMatch(s, /### High confidence/);
    assert.match(s, /1 lower-confidence finding/);
    const notesAt = s.indexOf("### Notes");
    assert.ok(notesAt > s.indexOf("left\\-pad"), "notes come after the findings");
    assert.match(s.slice(notesAt), /unused confidence capped/);
  });

  it("is neutral 'Analysis incomplete', never success, when only run-level notes remain", () => {
    const out = renderCheck(result([capNote]), added);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, incompleteTitle);
    assert.match(out.output.summary, /not a clean result/);
    assert.match(out.output.summary, /### Notes\n\n- unused confidence capped/);
    assert.equal(out.output.annotations.length, 0);
  });

  it("an adapter failure alone on a clean repo is not a green quiet check", () => {
    const failure: Finding = {
      kind: "info",
      summary: "javascript-typescript analysis incomplete: run failed: boom",
      recommendation: "Manual review recommended for this ecosystem.",
      evidence: [{ kind: "adapter-error", statement: "javascript-typescript adapter run stage" }],
      confidence: "low",
      limitations: ["Results for javascript-typescript may be missing or partial."],
      affectedFiles: [],
    };
    const out = renderCheck(result([failure]), added);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, incompleteTitle);
    assert.notEqual(out.output.summary, quietSummary);
    assert.match(out.output.summary, /analysis incomplete: run failed: boom/);
  });

  it("lists app notes in Notes and treats a notes-only run as incomplete", () => {
    const out = renderCheck(result([]), added, ["Removed-usage check skipped: diff too large."]);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, incompleteTitle);
    assert.match(
      out.output.summary,
      /### Notes\n\n- Removed\\-usage check skipped: diff too large\\./,
    );
  });

  it("opens the lower-confidence group when there is no high-confidence group", () => {
    const onlyMedium = renderCheck(result([finding({ confidence: "medium" })]), added);
    assert.match(onlyMedium.output.summary, /<details open><summary>1 lower-confidence/);
    const offDiff = finding({ dependency: "b", evidence: [] });
    const mixed = renderCheck(
      result([offDiff, finding({ dependency: "c", confidence: "low" })]),
      added,
    );
    assert.match(mixed.output.summary, /### High confidence/);
    assert.match(mixed.output.summary, /<details><summary>1 lower-confidence/);
  });

  const overlap = finding({
    kind: "info",
    dependency: "requests",
    rule: "cross-ecosystem-capability-overlap",
    summary:
      "requests (python) covers the same capability (HTTP client) as axios (javascript-typescript)",
    evidence: [{ kind: "capability-cluster", statement: "http-client" }],
    awareness: true,
  });

  it("an awareness note alone keeps the quiet success check (#209)", () => {
    const out = renderCheck(result([overlap]), added);
    assert.equal(out.conclusion, "success");
    assert.equal(out.output.title, quietSummary);
    assert.match(
      out.output.summary,
      /<details><summary>1 awareness note \(no action suggested\)<\/summary>/,
    );
    assert.match(
      out.output.summary,
      /\*\*requests\*\* - requests \\\(python\\\) covers the same capability/,
    );
    assert.equal(out.output.annotations.length, 0);
  });

  it("awareness notes stay out of the count and the confidence groups", () => {
    const out = renderCheck(result([overlap, finding({ confidence: "low" })]), added);
    assert.equal(out.output.title, "1 dependency finding to review");
    const s = out.output.summary;
    assert.doesNotMatch(s, /### High confidence/);
    assert.ok(s.indexOf("awareness note") > s.indexOf("lower-confidence finding"));
  });

  it("an unanalysed PR dependency change is incompleteness, not awareness", () => {
    const unanalysed = finding({
      kind: "info",
      summary: "left-pad was added in this PR but javascript-typescript was not analysed",
      evidence: [
        {
          kind: "pr-dependency-change",
          statement: "added left-pad in package.json",
          file: "package.json",
        },
      ],
    });
    const out = renderCheck(result([unanalysed]), added);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, incompleteTitle);
    assert.match(out.output.summary, /### Notes\n\n- \*\*left\\-pad\*\* - left\\-pad was added/);
    assert.doesNotMatch(out.output.summary, /awareness note/);
  });

  it("groups only through core: an unmarked dependency note is incomplete, not awareness (#239)", () => {
    const unverified = finding({
      kind: "info",
      dependency: "left-pad",
      rule: "unverified-no-imports",
      summary: "No imports of left-pad were found; manual review recommended",
      evidence: [],
    });
    const out = renderCheck(result([unverified]), added);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, incompleteTitle);
    assert.match(
      out.output.summary,
      /### Notes\n\n- \*\*left\\-pad\*\* - No imports of left\\-pad/,
    );
    assert.doesNotMatch(out.output.summary, /awareness note/);
    // An overlap finding without core's explicit marker is not awareness either.
    const unmarked: Finding = { ...overlap };
    delete unmarked.awareness;
    assert.equal(renderCheck(result([unmarked]), added).conclusion, "neutral");
  });

  it("a plain adapter note is shown but keeps the quiet success check (#239)", () => {
    const edges = finding({
      kind: "info",
      rule: "graph-edges-unavailable",
      summary: "go module graph edges unavailable",
      evidence: [],
      adapterNote: true,
    });
    const out = renderCheck(result([edges]), added);
    assert.equal(out.conclusion, "success");
    assert.equal(out.output.title, quietSummary);
    assert.match(
      out.output.summary,
      /### Notes\n\n- \*\*left\\-pad\*\* - go module graph edges unavailable/,
    );
  });

  it("an adapter note next to an incomplete note is still neutral", () => {
    const edges = finding({ kind: "info", summary: "edges", evidence: [], adapterNote: true });
    const capped = finding({ kind: "info", summary: "capped", evidence: [] });
    const out = renderCheck(result([edges, capped]), added);
    assert.equal(out.conclusion, "neutral");
    assert.equal(out.output.title, incompleteTitle);
  });

  it("a package fact alone keeps the quiet success check and lists the fact (#385)", () => {
    const { conclusion, output } = renderCheck(
      result([
        finding({
          kind: "info",
          rule: "locked-version-published",
          summary: "left-pad locked version 1.3.0 published 2022-01-02T00:00:00Z",
          recommendation: "Review the source-backed status before changing this dependency.",
          healthFact: true,
          source: { kind: "registry", basis: "npm registry time[version]" },
          declaringManifest: { ecosystem: "javascript-typescript", path: "package.json" },
          confidence: "high",
        }),
      ]),
      new Map(),
    );
    assert.equal(conclusion, "success");
    assert.equal(output.title, quietSummary);
    assert.ok(output.summary.startsWith(quietSummary), output.summary);
    assert.ok(output.summary.includes("### Package facts"), output.summary);
    assert.ok(
      output.summary.includes(
        "**left\\-pad** - left\\-pad locked version 1\\.3\\.0 published 2022\\-01\\-02T00:00:00Z _(source: npm registry time\\[version\\]; declared in package\\.json, javascript\\-typescript)_",
      ),
      output.summary,
    );
    assert.equal(output.annotations.length, 0);
  });

  it("facts never enter the count, the confidence groups or the annotations (#385)", () => {
    const { conclusion, output } = renderCheck(
      result([
        finding({}),
        finding({
          kind: "info",
          rule: "registry-deprecated",
          dependency: "moment",
          summary: "moment is marked deprecated",
          recommendation: "Review the source-backed status before changing this dependency.",
          healthFact: true,
          source: { kind: "registry", basis: "npm registry deprecated" },
          declaringManifest: { ecosystem: "javascript-typescript", path: "package.json" },
          confidence: "high",
        }),
      ]),
      added,
    );
    assert.equal(conclusion, "neutral");
    assert.equal(output.title, "1 dependency finding to review");
    assert.ok(output.summary.includes("### Package facts"), output.summary);
    assert.ok(output.summary.includes("moment is marked deprecated"), output.summary);
    // Only the verdict annotates; the fact stays summary-only.
    assert.equal(output.annotations.length, 1);
  });

  it("is neutral, never failure, when there are findings", () => {
    assert.equal(
      renderCheck(result([finding({ confidence: "low" })]), added).conclusion,
      "neutral",
    );
  });

  it("annotates a high-confidence finding on a PR-added line", () => {
    const out = renderCheck(result([finding()]), added);
    assert.equal(out.output.annotations.length, 1);
    const a = out.output.annotations[0]!;
    assert.equal(a.path, "package.json");
    assert.equal(a.start_line, 12);
    assert.equal(a.annotation_level, "notice");
    assert.match(a.message, /declared in package\.json/);
  });

  it("keeps findings off unchanged lines, lower confidence, and pushes in the summary", () => {
    const offDiff = finding({
      evidence: [{ kind: "declared", statement: "x", file: "package.json", line: 3 }],
    });
    const medium = finding({ dependency: "moment", confidence: "medium" });
    const out = renderCheck(result([offDiff, medium]), added);
    assert.equal(out.output.annotations.length, 0);
    assert.match(out.output.summary, /High confidence/);
    assert.match(out.output.summary, /<details>/);
    assert.match(out.output.summary, /moment/);
    assert.equal(renderCheck(result([finding()]), new Map()).output.annotations.length, 0);
  });

  it(`caps annotations at ${maxAnnotations} and reports the overflow in the summary`, () => {
    const lines = new Set(Array.from({ length: 60 }, (_, i) => i + 1));
    const many = Array.from({ length: 60 }, (_, i) =>
      finding({
        dependency: `dep${i}`,
        evidence: [{ kind: "declared", statement: "d", file: "package.json", line: i + 1 }],
      }),
    );
    const out = renderCheck(result(many), new Map([["package.json", lines]]));
    assert.equal(out.output.annotations.length, maxAnnotations);
    assert.match(out.output.summary, /10 more high-confidence findings exceeded/);
  });

  it("renders repository text as data", () => {
    const hostile = finding({
      dependency: "evil](https://x.test)<img src=x>",
      summary: "line1\n# heading \u202e",
      confidence: "low",
    });
    const out = renderCheck(result([hostile]), added);
    assert.doesNotMatch(out.output.summary, /(^|[^\\])<img/);
    assert.doesNotMatch(out.output.summary, /(^|[^\\])\]\(https/);
    assert.doesNotMatch(out.output.summary, /\u202e/);
    assert.equal(md("a*b"), "a\\*b");
  });

  it("never renders a live @mention", () => {
    const out = renderCheck(
      result([
        finding({ dependency: "@some-team/pkg", summary: "ping @octocat", confidence: "low" }),
      ]),
      added,
    );
    assert.doesNotMatch(out.output.summary, /@/);
    assert.match(out.output.summary, /&#64;some/);
  });

  it("truncates a huge summary on a line boundary and closes <details>", () => {
    const long = "x".repeat(900);
    const many = Array.from({ length: 200 }, (_, i) =>
      finding({ dependency: `dep${i}`, summary: long, confidence: "low" }),
    );
    const s = renderCheck(result(many), added).output.summary;
    assert.ok(s.length <= 65_000, `length ${s.length}`);
    assert.match(s, /<\/details>\n\n_Summary truncated\._$/);
    const body = s.slice(0, s.indexOf("\n</details>"));
    assert.match(body.slice(body.lastIndexOf("\n") + 1), /_\(low confidence\)_$/);
  });
});
