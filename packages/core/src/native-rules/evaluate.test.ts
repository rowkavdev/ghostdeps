import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import { evaluateNativeRule, type NativeEligibilityEvidence } from "./evaluate.js";

// Synthetic facts are deliberately NOT produced from a repository. This test checks
// only the data contract; the candidate cannot be surfaced as a recommendation.
const complete = (): NativeEligibilityEvidence => ({
  version: 1,
  ecosystem: "javascript-typescript",
  project: ".",
  manifest: "package.json",
  packageName: "axios",
  snapshotSha256: "a".repeat(64),
  referencesComplete: true,
  targets: [
    {
      runtime: "node",
      minimumVersion: "22.0.0",
      source: {
        kind: "deployment-runtime-floor",
        statement: "Supported Node runtime floor is 22.0.0",
        file: "package.json",
      },
    },
  ],
  uses: [{ api: "get", file: "src/api.ts", line: 2, resolved: true, optionsChecked: true }],
  incompatibleChecks: AXIOS_FETCH_RULE.incompatibleUses.map((pattern) => ({
    pattern,
    checked: true,
    observed: false,
    source: {
      kind: "native-incompatibility-checked",
      statement: `${pattern} checked across source`,
      file: "src/api.ts",
    },
  })),
  semanticChecks: AXIOS_FETCH_RULE.semanticDifferences.map((difference) => ({
    difference,
    file: "src/api.ts",
    line: 2,
    checked: true,
    source: {
      kind: "native-semantic-checked",
      statement: `${difference} considered at call site`,
      file: "src/api.ts",
      line: 2,
    },
  })),
});

describe("axios to native fetch evidence contract (#56)", () => {
  it("checks contract shape only with synthetic facts; never authorizes a finding", () => {
    const result = evaluateNativeRule(AXIOS_FETCH_RULE, complete());
    assert.equal(result.status, "candidate");
    if (result.status !== "candidate") return;
    assert.equal(result.ruleId, "javascript-typescript/axios-to-fetch/v1");
    assert.deepEqual(result.matchedApis, ["get"]);
    assert.ok(result.excludedIncompatibilities.includes("interceptors"));
    assert.equal(result.alternative.confidence, "medium");
    assert.equal(result.alternative.nativeCapability, "fetch()");
    assert.ok(result.evidence.some((e) => e.kind === "deployment-runtime-floor"));
    assert.ok(result.evidence.some((e) => e.kind === "native-api-matched"));
  });
  for (const [caseName, change] of [
    ["no reference coverage", { referencesComplete: false }],
    ["no incompatible-use coverage", { incompatibleChecks: [] }],
    ["no semantic check", { semanticChecks: [] }],
    ["missing target", { targets: [] }],
    [
      "below stable floor",
      {
        targets: [
          { runtime: "node", minimumVersion: "18.0.0", source: complete().targets[0]!.source },
        ],
      },
    ],
    [
      "untrusted floor source",
      {
        targets: [
          {
            runtime: "node",
            minimumVersion: "22.0.0",
            source: {
              kind: "ci-matrix",
              statement: "Node 22 in CI",
              file: ".github/workflows/ci.yml",
            },
          },
        ],
      },
    ],
    [
      "browser target",
      {
        targets: [
          { runtime: "browser", minimumVersion: "120.0.0", source: complete().targets[0]!.source },
        ],
      },
    ],
    ["unresolved alias", { uses: [{ ...complete().uses[0], resolved: false }] }],
    ["unknown options", { uses: [{ ...complete().uses[0], optionsChecked: false }] }],
    ["unsupported API", { uses: [{ ...complete().uses[0], api: "post" }] }],
    [
      "interceptor",
      {
        incompatibleChecks: complete().incompatibleChecks.map((check) =>
          check.pattern === "interceptors" ? { ...check, observed: true } : check,
        ),
      },
    ],
    ["no uses", { uses: [] }],
    ["wrong package", { packageName: "got" }],
    ["missing snapshot", { snapshotSha256: "" }],
    ["malformed evidence", { incompatibleChecks: undefined }],
  ] as const) {
    it(`blocks ${caseName}`, () => {
      const result = evaluateNativeRule(AXIOS_FETCH_RULE, {
        ...complete(),
        ...change,
      } as NativeEligibilityEvidence);
      assert.equal(result.status, "blocked", caseName);
    });
  }
});
