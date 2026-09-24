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
});

for (const scenario of ["pip-requirements", "poetry-basic", "mixed-js-python"]) {
  runAdapterContractTests(adapter, {
    repository: fixtureHandle("python", scenario),
    network: { mode: "offline" },
  });
}
