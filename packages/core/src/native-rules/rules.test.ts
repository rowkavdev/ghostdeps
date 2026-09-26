import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeRule } from "./index.js";
import { evaluateNativeRule, type NativeEligibilityEvidence } from "./evaluate.js";
import { JS_NATIVE_RULES } from "./rules.js";

// Synthetic records exercise the inert data contract, not source-backed verdicts.
function synthetic(rule: NativeRule): NativeEligibilityEvidence {
  const use = {
    api: rule.coveredApis[0]!,
    file: "src/index.ts",
    line: 1,
    resolved: true,
    optionsChecked: true,
  };
  return {
    version: 1,
    ecosystem: rule.ecosystem,
    project: ".",
    manifest: "package.json",
    packageName: rule.packages[0]!,
    snapshotSha256: "a".repeat(64),
    referencesComplete: true,
    targets: [
      {
        runtime: "node",
        minimumVersion: rule.minimumRuntime.node!,
        source: {
          kind: "deployment-runtime-floor",
          statement: "Synthetic floor",
          file: "package.json",
        },
      },
    ],
    uses: [use],
    incompatibleChecks: rule.incompatibleUses.map((pattern) => ({
      pattern,
      checked: true,
      observed: false,
      source: {
        kind: "native-incompatibility-checked",
        statement: `Synthetic ${pattern}`,
        file: use.file,
      },
    })),
    semanticChecks: rule.semanticDifferences.map((difference) => ({
      difference,
      file: use.file,
      line: use.line,
      checked: true,
      source: {
        kind: "native-semantic-checked",
        statement: `Synthetic ${difference}`,
        file: use.file,
        line: use.line,
      },
    })),
  };
}

describe("JS native rule seed data (#57)", () => {
  it("has unique, versioned rules with references and bounded contracts", () => {
    assert.deepEqual(
      JS_NATIVE_RULES.map((r) => r.packages[0]),
      ["axios", "uuid", "lodash.clonedeep"],
    );
    assert.equal(new Set(JS_NATIVE_RULES.map((r) => r.id)).size, JS_NATIVE_RULES.length);
    for (const rule of JS_NATIVE_RULES) {
      assert.match(rule.id, /^javascript-typescript\/.+\/v1$/);
      assert.ok(rule.references.every((url) => url.startsWith("https://")));
      assert.ok(rule.incompatibleUses.length && rule.semanticDifferences.length);
    }
  });

  for (const rule of JS_NATIVE_RULES) {
    it(`${rule.id}: matches only a fully covered synthetic record`, () => {
      assert.equal(evaluateNativeRule(rule, synthetic(rule)).status, "candidate");
    });
    for (const [reason, change] of [
      ["absent reference coverage", { referencesComplete: false }],
      ["unresolved use", { uses: [{ ...synthetic(rule).uses[0], resolved: false }] }],
      ["uninspected options", { uses: [{ ...synthetic(rule).uses[0], optionsChecked: false }] }],
      ["unsupported API", { uses: [{ ...synthetic(rule).uses[0], api: "unsupported" }] }],
      ["unproved deployment floor", { targets: [] }],
      ["browser target", { targets: [{ ...synthetic(rule).targets[0], runtime: "browser" }] }],
      [
        "below-floor runtime",
        { targets: [{ ...synthetic(rule).targets[0], minimumVersion: "1.0.0" }] },
      ],
      [
        "observed incompatibility",
        {
          incompatibleChecks: synthetic(rule).incompatibleChecks.map((c, i) =>
            i === 0 ? { ...c, observed: true } : c,
          ),
        },
      ],
      ["missing semantic checks", { semanticChecks: [] }],
    ] as const) {
      it(`${rule.id}: blocks ${reason}`, () => {
        assert.equal(
          evaluateNativeRule(rule, { ...synthetic(rule), ...change } as NativeEligibilityEvidence)
            .status,
          "blocked",
        );
      });
    }
  }
});
