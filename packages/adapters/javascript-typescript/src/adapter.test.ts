import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAdapterContractTests } from "@ghostdeps/core";
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
    const usages = await adapter.findUsage!(ctx("usage-static-and-require"), axios);
    assert.ok(usages.length > 0);
    assert.ok(usages.every((u) => u.file.length > 0 && u.line > 0));
  });
});

runAdapterContractTests(createJavaScriptTypeScriptAdapter(), ctx("lockfile-npm-v3"));
runAdapterContractTests(createJavaScriptTypeScriptAdapter(), ctx("usage-static-and-require"));
