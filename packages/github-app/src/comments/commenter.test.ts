import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AnalysisResult, Dependency, Finding } from "@ghostdeps/core";
import { computeEligibility, defaultCommentAdapters } from "./commenter.js";
import { eligibilityId } from "./resolve.js";

function dep(name: string, projectPath: string): Dependency {
  return {
    name,
    constraint: "^1.0.0",
    kind: "dependencies",
    project: { path: projectPath, ecosystem: "javascript", packageManagers: ["npm"] },
    declaredIn: projectPath === "." ? "package.json" : `${projectPath}/package.json`,
  } as unknown as Dependency;
}

function finding(name: string): Finding {
  return {
    kind: "verdict",
    rule: "unused",
    dependency: name,
    summary: "s",
    recommendation: "r",
    evidence: [],
    confidence: "medium",
  } as unknown as Finding;
}

function result(findings: Finding[], deps: Dependency[]): AnalysisResult {
  return { findings, dependencies: deps } as unknown as AnalysisResult;
}

function repoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gd-commenter-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", dependencies: { "left-pad": "^1.3.0" } }),
  );
  writeFileSync(join(dir, "index.js"), "console.log('nothing imported');\n");
  return dir;
}

describe("computeEligibility", () => {
  it("scopes eligibility by project: a nested package never gets the root preview stamped on it", async () => {
    const r = result(
      [finding("left-pad"), finding("nested-only")],
      [dep("left-pad", "."), dep("nested-only", "packages/web")],
    );
    const map = await computeEligibility(repoRoot(), defaultCommentAdapters(), r);
    const nested = map.get(eligibilityId("unused", "packages/web", "nested-only"));
    assert.equal(nested?.status, "ineligible");
    assert.match(nested?.status === "ineligible" ? nested.reason : "", /root npm package layout/);
    // The root finding is evaluated on its own id; the nested refusal must
    // not collide with or suppress it.
    assert.ok(map.has(eligibilityId("unused", ".", "left-pad")));
    assert.equal(map.size, 2);
  });

  it("skips findings whose declaration cannot be resolved", async () => {
    const r = result(
      [finding("left-pad")],
      [dep("left-pad", "."), dep("left-pad", "packages/web")],
    );
    const map = await computeEligibility(repoRoot(), defaultCommentAdapters(), {
      ...r,
      findings: [finding("left-pad")],
      dependencies: [dep("left-pad", "."), dep("left-pad", "packages/web")],
    });
    // Ambiguous (same name in both projects): no map entry at all - the
    // renderer explains it instead of any key being minted.
    assert.equal(map.size, 0);
  });
});
