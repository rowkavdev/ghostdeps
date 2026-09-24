/**
 * Shared recommendation-policy contract tests (#128). Any policy plugged
 * into the engine's `recommend` hook runs this suite over the fixtures
 * below, in both full-scan and pull-request mode.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecommendationInput, RecommendationPolicy } from "../engine/analyse.js";
import type { Dependency, ProjectRef } from "../types/index.js";

const project: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };

const dep = (name: string, kind: Dependency["kind"] = "runtime"): Dependency => ({
  name,
  constraint: "^1.0.0",
  kind,
  project,
  declaredIn: "package.json",
});

const baseFacts = {
  dependencies: [dep("used"), dep("unused"), dep("added-unused"), dep("added-used")],
  usages: [
    { dependency: "used", file: "src/index.ts", line: 1, form: "static" as const, symbols: [] },
    { dependency: "added-used", file: "src/new.ts", line: 2, form: "static" as const, symbols: [] },
  ],
  graphs: [],
  usageAnalysedEcosystems: new Set(["javascript-typescript"]),
};

/** Facts for both engine modes. PR mode touches only the "added-*" deps and a removal. */
export const policyContractFixtures: Readonly<Record<"full" | "pullRequest", RecommendationInput>> =
  {
    full: { ...baseFacts, mode: "full" },
    pullRequest: {
      ...baseFacts,
      mode: "pull-request",
      pullRequestChanges: [
        {
          change: "added",
          name: "added-unused",
          ecosystem: "javascript-typescript",
          manifest: "package.json",
          after: { constraint: "^1.0.0", kind: "runtime" },
          usageCheck: "pending",
        },
        {
          change: "added",
          name: "added-used",
          ecosystem: "javascript-typescript",
          manifest: "package.json",
          after: { constraint: "^1.0.0", kind: "runtime" },
          usageCheck: "pending",
        },
        {
          change: "removed",
          name: "gone",
          ecosystem: "javascript-typescript",
          manifest: "package.json",
          before: { constraint: "^1.0.0", kind: "runtime" },
        },
      ],
    },
  };

const CONFIDENCE = new Set(["high", "medium", "low"]);

/** Invariants every recommendation policy must honour in both modes. */
export function runRecommendationPolicyContractTests(
  name: string,
  policy: RecommendationPolicy,
  fixtures: Readonly<Record<"full" | "pullRequest", RecommendationInput>> = policyContractFixtures,
): void {
  describe(`recommendation policy contract: ${name}`, () => {
    for (const [label, input] of Object.entries(fixtures)) {
      it(`${label}: every finding carries evidence and a valid confidence`, async () => {
        for (const finding of await policy(input)) {
          assert.ok(CONFIDENCE.has(finding.confidence));
          if (finding.kind !== "info") {
            assert.ok(finding.evidence.length > 0, "a verdict without evidence is a bug");
          }
        }
      });

      it(`${label}: never calls a dependency unused where usage was not analysed`, async () => {
        const notAnalysed = { ...input, usageAnalysedEcosystems: new Set<string>() };
        const findings = await policy(notAnalysed);
        assert.deepEqual(
          findings.filter((f) => f.kind === "unused"),
          [],
        );
      });
    }

    it("pull-request mode: findings only concern dependencies the PR touched", async () => {
      const input = fixtures.pullRequest;
      assert.equal(input.mode, "pull-request");
      const touched = new Set((input.pullRequestChanges ?? []).map((c) => c.name));
      for (const finding of await policy(input)) {
        if (finding.dependency !== undefined) {
          assert.ok(touched.has(finding.dependency), `${finding.dependency} was not touched`);
        } else {
          assert.equal(finding.kind, "info", "untargeted findings in PR mode must be info");
        }
      }
    });

    it("full mode: carries no pull-request changes", () => {
      assert.equal(fixtures.full.mode, "full");
      assert.equal(fixtures.full.pullRequestChanges, undefined);
    });
  });
}
