import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRecommendationPolicyContractTests } from "../contract-tests/policy.js";
import type { RecommendationInput } from "../engine/analyse.js";
import type { Dependency, DependencyGraph, Finding, ProjectRef, Usage } from "../types/index.js";
import { isNonShippedPath } from "./paths.js";
import { createDefaultPolicy, defaultPolicy, summariseFindings } from "./policy.js";

const TS = "javascript-typescript";
const project: ProjectRef = { path: ".", ecosystem: TS, packageManagers: [] };

function dep(
  name: string,
  kind: Dependency["kind"] = "runtime",
  extra: Partial<Dependency> = {},
): Dependency {
  return { name, constraint: "^1.0.0", kind, project, declaredIn: "package.json", ...extra };
}

function use(dependency: string, file = "src/index.ts", extra: Partial<Usage> = {}): Usage {
  return { dependency, file, line: 1, form: "static", symbols: [], ...extra };
}

function input(parts: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    dependencies: [],
    usages: [],
    graphs: [],
    usageAnalysedEcosystems: new Set([TS]),
    referenceAnalysedEcosystems: new Set([TS]),
    mode: "full",
    ...parts,
  };
}

async function run(
  parts: Partial<RecommendationInput>,
  policy = defaultPolicy,
): Promise<Finding[]> {
  return policy(input(parts));
}

const byDep = (findings: Finding[], name: string) => findings.filter((f) => f.dependency === name);

describe("default recommendation policy", () => {
  describe("removed-last-usage (#101)", () => {
    const removed = (name: string) => use(name, "src/old.ts", { line: 9, removedInPr: true });
    const pr = { mode: "pull-request" as const, pullRequestChanges: [] };

    it("flags a still-declared dependency whose only use the PR removed", async () => {
      const findings = await run({
        ...pr,
        dependencies: [dep("left-pad")],
        usages: [removed("left-pad")],
      });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.kind, "unused");
      assert.equal(findings[0]?.rule, "removed-last-usage");
      assert.equal(findings[0]?.confidence, "high");
      assert.deepEqual(findings[0]?.affectedFiles, ["package.json", "src/old.ts"]);
    });

    it("stays silent when the dependency is still used at head", async () => {
      const findings = await run({
        ...pr,
        dependencies: [dep("left-pad")],
        usages: [removed("left-pad"), use("left-pad")],
      });
      assert.deepEqual(findings, []);
    });

    it("never counts a removed line as usage in any rule", async () => {
      // Full scan: the removed usage is not usage, so plain "unused" applies.
      const findings = await run({
        dependencies: [dep("left-pad")],
        usages: [removed("left-pad")],
      });
      assert.deepEqual(
        findings.map((f) => f.rule),
        ["unused"],
      );
    });

    it("keeps the unused guards: no verdict without reference analysis", async () => {
      const findings = await run({
        ...pr,
        dependencies: [dep("left-pad")],
        usages: [removed("left-pad")],
        referenceAnalysedEcosystems: new Set(),
      });
      assert.ok(!findings.some((f) => f.kind === "unused"));
    });

    it("keeps the unused guards: allowlisted tooling gets no verdict", async () => {
      const findings = await run({
        ...pr,
        dependencies: [dep("typescript", "dev")],
        usages: [removed("typescript")],
      });
      assert.ok(!findings.some((f) => f.kind === "unused"));
    });

    it("is untouched by PR scoping: a dependency with no PR change and no removal gets nothing", async () => {
      const findings = await run({
        ...pr,
        dependencies: [dep("left-pad"), dep("other")],
        usages: [removed("left-pad")],
      });
      assert.deepEqual(
        findings.map((f) => f.dependency),
        ["left-pad"],
      );
    });
  });

  it("calls a dependency unused only with complete evidence", async () => {
    const findings = await run({
      dependencies: [dep("left-pad"), dep("axios")],
      usages: [use("axios")],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "unused");
    assert.equal(findings[0]?.rule, "unused");
    assert.equal(findings[0]?.dependency, "left-pad");
    assert.equal(findings[0]?.confidence, "high");
  });

  it("never emits unused when usage analysis did not run", async () => {
    const findings = await run({
      dependencies: [dep("left-pad")],
      usageAnalysedEcosystems: new Set(),
      referenceAnalysedEcosystems: new Set(),
    });
    assert.deepEqual(findings, []);
  });

  it("emits unverified-no-imports info when scripts and config were not checked", async () => {
    const findings = await run({
      dependencies: [dep("left-pad")],
      referenceAnalysedEcosystems: new Set(),
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "info");
    assert.equal(findings[0]?.rule, "unverified-no-imports");
    assert.equal(findings[0]?.confidence, "low");
    assert.ok(findings[0]?.limitations.length);
  });

  for (const via of ["script", "config", "convention", "import"] as const) {
    it(`treats a via=${via} usage as usage`, async () => {
      const findings = await run({
        dependencies: [dep("left-pad", "dev")],
        usages: [use("left-pad", "package.json", { via })],
      });
      assert.deepEqual(findings, []);
    });
  }

  it("never flags allowlisted tooling", async () => {
    const names = [
      "typescript",
      "eslint",
      "eslint-plugin-import",
      "@typescript-eslint/parser",
      "vitest",
      "vite",
      "@types/node",
      "prettier",
    ];
    const findings = await run({ dependencies: names.map((n) => dep(n, "dev")) });
    assert.deepEqual(findings, []);
  });

  it("merges caller allowlist entries", async () => {
    const policy = createDefaultPolicy({ allowlist: { [TS]: { exact: ["my-cli"] } } });
    assert.deepEqual(await run({ dependencies: [dep("my-cli", "dev")] }, policy), []);
  });

  it("counts @types/foo as used when foo is used, including scoped packages", async () => {
    const findings = await run({
      dependencies: [
        dep("@types/lodash", "dev"),
        dep("@types/scope__pkg", "dev"),
        dep("@types/orphan", "dev"),
        dep("lodash"),
        dep("@scope/pkg"),
      ],
      usages: [use("lodash"), use("@scope/pkg")],
    });
    assert.deepEqual(byDep(findings, "@types/lodash"), []);
    assert.deepEqual(byDep(findings, "@types/scope__pkg"), []);
    assert.equal(byDep(findings, "@types/orphan")[0]?.kind, "unused");
  });

  it("gives no verdict for peer, optional or non-registry dependencies", async () => {
    const findings = await run({
      dependencies: [
        dep("react", "peer"),
        dep("fsevents", "optional"),
        dep("local-lib", "runtime", { specifier: { type: "workspace" } }),
      ],
    });
    assert.deepEqual(findings, []);
  });

  it("downgrades to info when another direct dependency depends on it", async () => {
    const graph: DependencyGraph = {
      project,
      nodes: [],
      transitiveClosure: { "react-dom": ["react", "scheduler"], react: [] },
      incomplete: false,
    };
    const findings = await run({
      dependencies: [dep("react"), dep("react-dom")],
      usages: [use("react-dom")],
      graphs: [graph],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "unverified-no-imports");
    assert.equal(findings[0]?.kind, "info");
    assert.match(findings[0]?.summary ?? "", /react-dom depends on it/);
  });

  it("flags runtime deps imported only from non-shipped code as should-be-dev", async () => {
    const findings = await run({
      dependencies: [dep("supertest"), dep("express")],
      usages: [
        use("supertest", "test/app.test.ts"),
        use("express"),
        use("express", "test/app.test.ts"),
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "should-be-dev");
    assert.equal(findings[0]?.dependency, "supertest");
    assert.equal(findings[0]?.confidence, "medium");
  });

  it("does not flag dev dependencies as should-be-dev", async () => {
    assert.deepEqual(
      await run({
        dependencies: [dep("supertest", "dev")],
        usages: [use("supertest", "test/a.test.ts")],
      }),
      [],
    );
  });

  it("flags runtime deps used only in type positions as type-only", async () => {
    const findings = await run({
      dependencies: [dep("type-fest")],
      usages: [
        use("type-fest", "src/a.ts", { typeOnly: true }),
        use("type-fest", "src/b.ts", { typeOnly: true }),
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "type-only");
    assert.equal(findings[0]?.rule, "type-only");
  });

  it("skips type-only when the ecosystem does not strip types or any usage is a value use", async () => {
    const mixed = await run({
      dependencies: [dep("zod")],
      usages: [use("zod", "src/a.ts", { typeOnly: true }), use("zod", "src/b.ts")],
    });
    assert.deepEqual(mixed, []);
    const policy = createDefaultPolicy({ typeStrippingEcosystems: [] });
    const off = await run(
      {
        dependencies: [dep("type-fest")],
        usages: [use("type-fest", "src/a.ts", { typeOnly: true })],
      },
      policy,
    );
    assert.deepEqual(off, []);
  });

  it("honours disabled rules and confidence downgrades", async () => {
    const parts = { dependencies: [dep("left-pad")] };
    assert.deepEqual(await run(parts, createDefaultPolicy({ disabled: ["unused"] })), []);
    const capped = await run(parts, createDefaultPolicy({ downgrade: { unused: "medium" } }));
    assert.equal(capped[0]?.confidence, "medium");
    const notRaised = await run(
      { dependencies: [dep("left-pad")], referenceAnalysedEcosystems: new Set() },
      createDefaultPolicy({ downgrade: { "unverified-no-imports": "high" } }),
    );
    assert.equal(notRaised[0]?.confidence, "low");
  });

  it("keeps ecosystems separate", async () => {
    const py: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
    const findings = await run({
      dependencies: [
        dep("requests"),
        { ...dep("requests"), project: py, declaredIn: "requirements.txt" },
      ],
      usages: [use("requests")],
      usageAnalysedEcosystems: new Set([TS, "python"]),
      referenceAnalysedEcosystems: new Set([TS, "python"]),
    });
    // Usages are not ecosystem-tagged, so a same-name usage counts for both: stays quiet.
    assert.deepEqual(findings, []);
  });

  it("summarises findings by kind, rule and confidence", async () => {
    const findings = await run({
      dependencies: [dep("left-pad"), dep("supertest")],
      usages: [use("supertest", "test/a.test.ts")],
    });
    const summary = summariseFindings(findings);
    assert.equal(summary.total, 2);
    assert.equal(summary.byRule.unused, 1);
    assert.equal(summary.byRule["should-be-dev"], 1);
    assert.equal(summary.byConfidence.high, 1);
  });
});

describe("pull-request mode", () => {
  it("only gives findings for dependencies the PR added or changed", async () => {
    const findings = await run({
      dependencies: [dep("left-pad"), dep("new-pad"), dep("bumped-pad"), dep("gone-pad")],
      mode: "pull-request",
      pullRequestChanges: [
        { change: "added", name: "new-pad", ecosystem: TS, manifest: "package.json" },
        { change: "changed", name: "bumped-pad", ecosystem: TS, manifest: "package.json" },
        { change: "removed", name: "gone-pad", ecosystem: TS, manifest: "package.json" },
      ],
    });
    assert.deepEqual(findings.map((f) => f.dependency).sort(), ["bumped-pad", "new-pad"]);
  });

  it("gives no findings for a source-only PR", async () => {
    assert.deepEqual(
      await run({ dependencies: [dep("left-pad")], mode: "pull-request", pullRequestChanges: [] }),
      [],
    );
  });
});

runRecommendationPolicyContractTests("defaultPolicy", defaultPolicy);

describe("isNonShippedPath", () => {
  it("classifies test, build and config paths", () => {
    for (const p of [
      "test/a.ts",
      "src/__tests__/a.ts",
      "src/a.test.ts",
      "vite.config.ts",
      ".eslintrc.cjs",
      "scripts/build.mjs",
      "tests/test_x.py",
      "conftest.py",
    ]) {
      assert.equal(isNonShippedPath(p), true, p);
    }
    for (const p of ["src/index.ts", "lib/testing-utils.ts", "src/config.ts", "app/main.py"]) {
      assert.equal(isNonShippedPath(p), false, p);
    }
  });
});
