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
    assert.equal(byDep(findings, "@types/orphan")[0]?.rule, "ambient-types-unverified");
    assert.equal(byDep(findings, "@types/orphan")[0]?.kind, "info");
  });

  it("credits a declared runtime companion even when its import use is ambient", async () => {
    const findings = await run({ dependencies: [dep("@types/react", "dev"), dep("react")] });
    assert.deepEqual(byDep(findings, "@types/react"), []);
    assert.equal(byDep(findings, "react")[0]?.kind, "unused");
  });

  it("scopes companion matching to the same project, not another workspace", async () => {
    const other = { ...project, path: "packages/other" };
    const findings = await run({
      dependencies: [
        dep("@types/react", "dev", { project: other, declaredIn: "packages/other/package.json" }),
        dep("react"),
      ],
    });
    assert.equal(byDep(findings, "@types/react")[0]?.rule, "ambient-types-unverified");
  });

  it("marks standalone ambient packages incomplete instead of an unused verdict", async () => {
    const findings = await run({
      dependencies: [dep("@types/node", "dev"), dep("@types/orphan", "dev")],
    });
    assert.deepEqual(
      findings.map((f) => [f.dependency, f.kind, f.rule]),
      [
        ["@types/node", "info", "ambient-types-unverified"],
        ["@types/orphan", "info", "ambient-types-unverified"],
      ],
    );
  });

  it("keeps @types no-absence safety across all generic paths when the ambient note is disabled", async () => {
    const policy = createDefaultPolicy({ disabled: ["ambient-types-unverified"] });
    const d = dep("@types/orphan", "dev");
    const cases: Partial<RecommendationInput>[] = [
      { dependencies: [d], usages: [] }, // unused
      {
        dependencies: [d],
        usages: [use(d.name, "src/old.ts", { removedInPr: true })],
        mode: "pull-request",
        pullRequestChanges: [],
      }, // removed-last-usage
      { dependencies: [d], usages: [], referenceAnalysedEcosystems: new Set() }, // unverified-no-imports
    ];
    for (const candidate of cases) {
      const findings = await run(candidate, policy);
      assert.deepEqual(findings, [], JSON.stringify(candidate));
    }
  });

  it("does not manufacture an ambient note if usage analysis never ran", async () => {
    const findings = await run({
      dependencies: [dep("@types/node", "dev")],
      usageAnalysedEcosystems: new Set(),
      referenceAnalysedEcosystems: new Set(),
    });
    assert.deepEqual(findings, []);
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
    assert.match(findings[0]?.summary ?? "", /reachable through react-dom/);
    assert.match(findings[0]?.evidence[1]?.statement ?? "", /transitive closure of react-dom/);
  });

  it("attributes a peer note to the exact host, not the first transitive closure (#395)", async () => {
    const graph: DependencyGraph = {
      project,
      nodes: [],
      transitiveClosure: {
        "@vercel/analytics": ["next", "react-dom"],
        next: ["react-dom"],
        "react-dom": [],
      },
      directPeers: { "@vercel/analytics": ["next"], next: ["react-dom"] },
      incomplete: false,
    };
    const findings = await run({
      dependencies: [dep("@vercel/analytics"), dep("next"), dep("react-dom")],
      usages: [use("next"), use("@vercel/analytics")],
      graphs: [graph],
    });
    const peer = byDep(findings, "react-dom");
    assert.equal(peer.length, 1);
    assert.equal(peer[0]?.kind, "info");
    assert.equal(peer[0]?.confidence, "low");
    assert.match(peer[0]?.summary ?? "", /next declares it as a peer/);
    assert.deepEqual(peer[0]?.evidence[1], {
      kind: "required-by-peer-host",
      statement: "next declares react-dom as a peer in the resolved lockfile",
    });
    assert.ok(!JSON.stringify(peer).includes("@vercel/analytics"));
  });

  it("does not attribute another workspace's exact peer host (#395 review)", async () => {
    const appA: ProjectRef = { ...project, path: "apps/a" };
    const appB: ProjectRef = { ...project, path: "apps/b" };
    const graphA: DependencyGraph = {
      project: appA,
      nodes: [],
      transitiveClosure: { next: ["react-dom"], "react-dom": [] },
      directPeers: { next: ["react-dom"] },
      incomplete: false,
    };
    const graphB: DependencyGraph = {
      project: appB,
      nodes: [],
      transitiveClosure: { next: [], "react-dom": [] },
      directPeers: { next: [] },
      incomplete: false,
    };
    const findings = await run({
      dependencies: [
        dep("next", "runtime", { project: appA }),
        dep("react-dom", "runtime", { project: appA }),
        dep("next", "runtime", { project: appB }),
        dep("react-dom", "runtime", { project: appB }),
      ],
      graphs: [graphA, graphB],
    });
    const peer = byDep(findings, "react-dom");
    assert.equal(peer.length, 2);
    assert.equal(
      peer.filter((f) => f.evidence.some((e) => e.kind === "required-by-peer-host")).length,
      1,
    );
    assert.equal(peer.filter((f) => f.kind === "unused").length, 1);
  });

  it("does not transfer an unresolved peer guard across workspaces", async () => {
    const appA: ProjectRef = { ...project, path: "apps/a" };
    const appB: ProjectRef = { ...project, path: "apps/b" };
    const graphA: DependencyGraph = {
      project: appA,
      nodes: [],
      transitiveClosure: { host: [], peer: [] },
      unresolvedDirectPeers: { host: ["peer"] },
      incomplete: false,
    };
    const graphB: DependencyGraph = {
      project: appB,
      nodes: [],
      transitiveClosure: { host: [], peer: [] },
      incomplete: false,
    };
    const findings = await run({
      dependencies: [
        dep("host", "runtime", { project: appA }),
        dep("peer", "runtime", { project: appA }),
        dep("host", "runtime", { project: appB }),
        dep("peer", "runtime", { project: appB }),
      ],
      graphs: [graphA, graphB],
    });
    const peer = byDep(findings, "peer");
    assert.equal(
      peer.filter((f) => f.evidence.some((e) => e.kind === "unresolved-peer-host")).length,
      1,
    );
    assert.equal(peer.filter((f) => f.kind === "unused").length, 1);
  });

  it("does not invent a peer host from closure alone", async () => {
    const graph: DependencyGraph = {
      project,
      nodes: [],
      transitiveClosure: { host: ["peer"], peer: [] },
      incomplete: false,
    };
    const findings = await run({ dependencies: [dep("host"), dep("peer")], graphs: [graph] });
    const note = byDep(findings, "peer")[0]!;
    assert.equal(note.kind, "info");
    assert.equal(note.evidence[1]?.kind, "required-by-direct-dependency");
    assert.match(note.evidence[1]?.statement ?? "", /transitive closure/);
    assert.ok(!note.evidence.some((e) => e.kind === "required-by-peer-host"));
  });

  it("unresolved peer edge never turns into a confident unused verdict", async () => {
    const graph: DependencyGraph = {
      project,
      nodes: [],
      transitiveClosure: { host: [], peer: [] },
      unresolvedDirectPeers: { host: ["peer"] },
      incomplete: false,
    };
    const findings = await run({ dependencies: [dep("host"), dep("peer")], graphs: [graph] });
    const peer = byDep(findings, "peer");
    assert.equal(peer.length, 1);
    assert.equal(peer[0]?.kind, "info");
    assert.equal(peer[0]?.evidence[1]?.kind, "unresolved-peer-host");
    assert.ok(peer[0]?.limitations.length);
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
