import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, runAdapterContractTests } from "./index.js";
import type { AdapterContext, EcosystemAdapter } from "./adapter.js";
import type { Dependency } from "./types/index.js";

const mockProject = { path: ".", ecosystem: "mock", packageManagers: [] };

const mockDep: Dependency = {
  name: "leftpad",
  constraint: "^1.0.0",
  kind: "runtime",
  project: mockProject,
  declaredIn: "package.json",
};

const mockAdapter: EcosystemAdapter = {
  ecosystem: "mock",
  apiVersion: adapterApiVersion,
  capabilities: new Set(["usageAnalysis"]),
  async detect() {
    return {
      confidence: 1,
      projects: [mockProject],
      evidence: [{ kind: "manifest-found", statement: "mock manifest" }],
    };
  },
  async listDirectDependencies() {
    return [mockDep];
  },
  async findUsage() {
    return [
      { dependency: "leftpad", file: "src/a.js", line: 3, form: "static", symbols: ["default"] },
    ];
  },
};

const context: AdapterContext = {
  repository: {
    async listFiles() {
      return ["package.json"];
    },
    async readFile() {
      return "{}";
    },
    async exists() {
      return true;
    },
  },
  network: { mode: "offline" },
};

describe("@ghostdeps/core", () => {
  it("exports the adapter API version", () => {
    assert.equal(adapterApiVersion, "0.1.0");
  });
});

runAdapterContractTests(mockAdapter, context);
