import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adapterApiVersion,
  normaliseUsageResult,
  type AdapterCapability,
  type EcosystemAdapter,
  type UsageAnalysisResult,
} from "../adapter.js";
import type { Dependency, ProjectRef, RepositoryHandle } from "../types/index.js";
import { analyseRepository, type RecommendationInput } from "./analyse.js";

const handle: RepositoryHandle = {
  async listFiles() {
    return ["package.json"];
  },
  async readFile() {
    return "{}";
  },
  async exists(p) {
    return p === "package.json";
  },
};

function adapter(
  capabilities: AdapterCapability[],
  results: Record<string, UsageAnalysisResult>,
): EcosystemAdapter {
  const project: ProjectRef = { path: ".", ecosystem: "mock", packageManagers: [] };
  const deps: Dependency[] = Object.keys(results).map((name) => ({
    name,
    constraint: "^1.0.0",
    kind: "runtime",
    project,
    declaredIn: "package.json",
  }));
  return {
    ecosystem: "mock",
    apiVersion: adapterApiVersion,
    capabilities: new Set(capabilities),
    async detect() {
      return { confidence: 0.9, projects: [project], evidence: [] };
    },
    async listDirectDependencies() {
      return deps;
    },
    async findUsage(_ctx, dep) {
      return results[dep.name] ?? [];
    },
  };
}

async function referenceAnalysed(
  capabilities: AdapterCapability[],
  results: Record<string, UsageAnalysisResult>,
  scanIncomplete = false,
): Promise<boolean> {
  let seen: RecommendationInput | undefined;
  await analyseRepository(handle, {
    adapters: [adapter(capabilities, results)],
    scanIncomplete,
    recommend: (input) => {
      seen = input;
      return [];
    },
  });
  assert.ok(seen, "policy ran");
  return seen.referenceAnalysedEcosystems.has("mock");
}

const both: AdapterCapability[] = ["usageAnalysis", "referenceAnalysis"];
const complete = { usages: [], referenceAnalysisComplete: true };

describe("referenceAnalysedEcosystems", () => {
  it("needs the capability and an explicit true from every dependency", async () => {
    assert.equal(await referenceAnalysed(both, { a: complete, b: complete }), true);
  });

  it("is cleared by any array result, omitted flag or false", async () => {
    assert.equal(await referenceAnalysed(both, { a: complete, b: [] }), false);
    assert.equal(await referenceAnalysed(both, { a: complete, b: { usages: [] } }), false);
    assert.equal(
      await referenceAnalysed(both, {
        a: complete,
        b: { usages: [], referenceAnalysisComplete: false },
      }),
      false,
    );
  });

  it("is cleared without the referenceAnalysis capability", async () => {
    assert.equal(await referenceAnalysed(["usageAnalysis"], { a: complete }), false);
  });

  it("is cleared when the scan was incomplete", async () => {
    assert.equal(await referenceAnalysed(both, { a: complete }, true), false);
  });
});

describe("normaliseUsageResult on malformed adapter output", () => {
  it("reads a missing or non-array usages field as empty and incomplete", () => {
    const bad = { usages: null } as unknown as UsageAnalysisResult;
    assert.deepEqual(normaliseUsageResult(bad), { usages: [], referenceAnalysisComplete: false });
    const worse = {
      usages: "x",
      referenceAnalysisComplete: true,
    } as unknown as UsageAnalysisResult;
    assert.deepEqual(normaliseUsageResult(worse), { usages: [], referenceAnalysisComplete: false });
  });
});

describe("scan completeness in analyseRepository (#154)", () => {
  const note = {
    kind: "info" as const,
    summary: "repository scan stopped early (max-files)",
    recommendation: "Manual review recommended.",
    evidence: [{ kind: "scan-truncated", statement: "stopped" }],
    confidence: "high" as const,
    limitations: [],
    affectedFiles: [],
  };
  const unusedPolicy = () => [
    {
      kind: "unused" as const,
      dependency: "a",
      summary: "a is unused",
      recommendation: "Remove a.",
      evidence: [{ kind: "no-usage-found", statement: "none" }],
      confidence: "high" as const,
      limitations: [],
      affectedFiles: ["package.json"],
    },
  ];

  async function analyse(extra: { scanIncomplete?: boolean; scanCompleteness?: (typeof note)[] }) {
    return analyseRepository(handle, {
      adapters: [adapter(both, { a: complete })],
      recommend: unusedPolicy,
      ...extra,
    });
  }

  it("caps absence findings and appends the notes when scanCompleteness is non-empty", async () => {
    const result = await analyse({ scanCompleteness: [note] });
    const unused = result.findings.find((f) => f.kind === "unused");
    assert.equal(unused?.confidence, "medium");
    assert.ok(unused?.limitations.some((l) => l.includes("scan was incomplete")));
    assert.ok(result.findings.some((f) => f.summary === note.summary));
  });

  it("caps without notes when only scanIncomplete is set", async () => {
    const result = await analyse({ scanIncomplete: true });
    assert.equal(result.findings.find((f) => f.kind === "unused")?.confidence, "medium");
  });

  it("leaves findings alone when the scan was complete", async () => {
    const result = await analyse({ scanCompleteness: [] });
    assert.equal(result.findings.find((f) => f.kind === "unused")?.confidence, "high");
  });
});
