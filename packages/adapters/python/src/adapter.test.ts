import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAdapterContractTests } from "@ghostdeps/core";
import { createPythonAdapter } from "./adapter.js";
import { fixtureHandle } from "./testing/fs-handle.js";

const adapter = createPythonAdapter();

describe("createPythonAdapter wiring", () => {
  it("identifies as the python ecosystem", () => {
    assert.equal(adapter.ecosystem, "python");
  });

  it("declares and implements dependencyGraph", () => {
    assert.ok(adapter.capabilities.has("dependencyGraph"));
    assert.equal(typeof adapter.buildDependencyGraph, "function");
  });
});

for (const scenario of ["pip-requirements", "poetry-basic", "mixed-js-python"]) {
  runAdapterContractTests(adapter, {
    repository: fixtureHandle("python", scenario),
    network: { mode: "offline" },
  });
}
