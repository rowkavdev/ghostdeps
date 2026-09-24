import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseUsageResult, runAdapterContractTests } from "@ghostdeps/core";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "./adapter.js";
import { fixtureHandle } from "./testing/fs-handle.js";

const ctx = (name: string): AdapterContext => ({
  repository: fixtureHandle("js", name),
  network: { mode: "offline" },
});
const root: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };

describe("createJavaScriptTypeScriptAdapter wiring", () => {
  const adapter = createJavaScriptTypeScriptAdapter();

  it("declares dependencyGraph and usageAnalysis, and implements both", () => {
    assert.deepEqual([...adapter.capabilities].sort(), ["dependencyGraph", "usageAnalysis"]);
    assert.equal(typeof adapter.buildDependencyGraph, "function");
    assert.equal(typeof adapter.findUsage, "function");
  });

  it("buildDependencyGraph returns one graph per project from the lockfile", async () => {
    const graphs = await adapter.buildDependencyGraph!(ctx("lockfile-npm-v3"), [root]);
    assert.equal(graphs.length, 1);
    assert.ok(graphs[0]!.nodes.length > 0);
  });

  it("findUsage finds evidence through the adapter", async () => {
    const axios: Dependency = {
      name: "axios",
      constraint: "*",
      kind: "runtime",
      project: root,
      declaredIn: "package.json",
    };
    const { usages } = normaliseUsageResult(
      await adapter.findUsage!(ctx("usage-static-and-require"), axios),
    );
    assert.ok(usages.length > 0);
    assert.ok(usages.every((u) => u.file.length > 0 && u.line > 0));
  });
});

runAdapterContractTests(createJavaScriptTypeScriptAdapter(), ctx("lockfile-npm-v3"));
runAdapterContractTests(createJavaScriptTypeScriptAdapter(), ctx("usage-static-and-require"));

describe("reference analysis completeness (#132)", () => {
  const adapter = createJavaScriptTypeScriptAdapter();
  const dev = (name: string): Dependency => ({
    name,
    constraint: "*",
    kind: "dev",
    project: root,
    declaredIn: "package.json",
  });
  const report = async (fixture: string, name: string) =>
    normaliseUsageResult(await adapter.findUsage!(ctx(fixture), dev(name)));

  it("script-only dependency: via=script usage, analysis complete", async () => {
    const r = await report("refs-script-only", "typescript");
    assert.deepEqual(
      r.usages.map((u) => [u.via, u.file, u.symbols]),
      [["script", "package.json", ["tsc"]]],
    );
    assert.equal(r.referenceAnalysisComplete, true);
  });

  it("config-only dependencies: via=config usage, analysis complete", async () => {
    for (const [name, file] of [
      ["eslint-plugin-import", ".eslintrc.json"],
      ["@types/node", "tsconfig.json"],
    ] as const) {
      const r = await report("refs-config-only", name);
      assert.deepEqual(
        r.usages.map((u) => [u.via, u.file]),
        [["config", file]],
        name,
      );
      assert.equal(r.referenceAnalysisComplete, true, name);
    }
  });

  it("no evidence anywhere: no usage and complete, so the policy may say unused", async () => {
    const r = await report("basic-unused", "left-pad");
    assert.deepEqual(r.usages, []);
    assert.equal(r.referenceAnalysisComplete, true);
  });

  it("partial scans are never complete", async () => {
    // Non-literal dynamic import in the source scan.
    assert.equal((await report("usage-dynamic", "plugin-a")).referenceAnalysisComplete, false);
    // A JS config that is never evaluated.
    const js = await report("refs-partial-js-config", "eslint-plugin-foo");
    assert.deepEqual(js.usages, []);
    assert.equal(js.referenceAnalysisComplete, false);
  });

  it("pnpm: a script bin whose name differs from its package is a gap, never complete", async () => {
    const r = await report("refs-pnpm-bin-mismatch", "npm-check-updates");
    assert.equal(r.referenceAnalysisComplete, false);
  });
});
