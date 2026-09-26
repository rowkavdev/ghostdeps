import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult, Dependency, Finding } from "@ghostdeps/core";
import { eligibilityId, resolveFindingDeclaration } from "./resolve.js";

function dep(name: string, projectPath: string, declaredIn: string): Dependency {
  return {
    name,
    constraint: "^1.0.0",
    kind: "dependencies",
    project: { path: projectPath, ecosystem: "javascript", packageManagers: ["npm"] },
    declaredIn,
  } as unknown as Dependency;
}

function finding(rule: string, dependency: string): Finding {
  return {
    kind: "verdict",
    rule,
    dependency,
    summary: "s",
    recommendation: "r",
    evidence: [],
    confidence: "medium",
  } as unknown as Finding;
}

function result(deps: Dependency[]): AnalysisResult {
  return { findings: [], dependencies: deps } as unknown as AnalysisResult;
}

describe("resolveFindingDeclaration", () => {
  it("resolves a uniquely declared dependency", () => {
    const r = result([dep("left-pad", ".", "package.json")]);
    const out = resolveFindingDeclaration(r, finding("unused", "left-pad"));
    assert.equal(out.status, "resolved");
    assert.equal(out.status === "resolved" && out.dependency.project.path, ".");
  });

  it("fails closed when the same name is declared in several projects", () => {
    const r = result([
      dep("left-pad", ".", "package.json"),
      dep("left-pad", "packages/web", "packages/web/package.json"),
    ]);
    assert.equal(resolveFindingDeclaration(r, finding("unused", "left-pad")).status, "ambiguous");
  });

  it("reports missing when no declaration carries the name", () => {
    assert.equal(
      resolveFindingDeclaration(result([]), finding("unused", "left-pad")).status,
      "missing",
    );
  });
});

describe("eligibilityId", () => {
  it("binds rule, project path and dependency so projects cannot collide", () => {
    assert.notEqual(
      eligibilityId("unused", ".", "left-pad"),
      eligibilityId("unused", "packages/web", "left-pad"),
    );
  });
});
