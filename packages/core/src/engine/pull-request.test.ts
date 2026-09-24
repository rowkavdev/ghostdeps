import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { runRecommendationPolicyContractTests } from "../contract-tests/policy.js";
import type { DependencyChange } from "../diff/dependency-changes.js";
import type { Finding, ProjectRef, RepositoryHandle } from "../types/index.js";
import {
  analyseRepository,
  type RecommendationInput,
  type RecommendationPolicy,
} from "./analyse.js";

const project: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };

const repo: RepositoryHandle = {
  async listFiles() {
    return ["package.json"];
  },
  async readFile() {
    return "{}";
  },
  async exists() {
    return true;
  },
};

const adapter: EcosystemAdapter = {
  ecosystem: "javascript-typescript",
  apiVersion: adapterApiVersion,
  capabilities: new Set(),
  async detect() {
    return { confidence: 1, projects: [project], evidence: [{ kind: "k", statement: "s" }] };
  },
  async listDirectDependencies() {
    return ["kept", "added"].map((name) => ({
      name,
      constraint: "^1.0.0",
      kind: "runtime" as const,
      project,
      declaredIn: "package.json",
    }));
  },
};

const added = (name: string, ecosystem = "javascript-typescript"): DependencyChange => ({
  change: "added",
  name,
  ecosystem,
  manifest: "package.json",
  after: { constraint: "^1.0.0", kind: "runtime" },
  usageCheck: "pending",
});

/** Example scoped policy: flags unused deps, scoped to PR changes in pull-request mode. */
const scopedUnused: RecommendationPolicy = (input) => {
  const touched = new Set((input.pullRequestChanges ?? []).map((c) => c.name));
  return input.dependencies
    .filter((d) => input.usageAnalysedEcosystems.has(d.project.ecosystem))
    .filter((d) => input.mode === "full" || touched.has(d.name))
    .filter((d) => !input.usages.some((u) => u.dependency === d.name))
    .map((d): Finding => ({
      kind: "unused",
      dependency: d.name,
      summary: `${d.name} is never imported`,
      recommendation: "Remove it.",
      evidence: [{ kind: "no-import-found", statement: "no imports" }],
      confidence: "high",
      limitations: [],
      affectedFiles: [d.declaredIn],
    }));
};

describe("analyseRepository pullRequestChanges (#128)", () => {
  it("runs policy in full mode when no changes are supplied", async () => {
    let seen: RecommendationInput | undefined;
    await analyseRepository(repo, {
      adapters: [adapter],
      recommend: (input) => {
        seen = input;
        return [];
      },
    });
    assert.equal(seen?.mode, "full");
    assert.equal(seen?.pullRequestChanges, undefined);
  });

  it("threads changes to policy in pull-request mode", async () => {
    let seen: RecommendationInput | undefined;
    const changes = [added("added")];
    await analyseRepository(repo, {
      adapters: [adapter],
      pullRequestChanges: changes,
      recommend: (input) => {
        seen = input;
        return [];
      },
    });
    assert.equal(seen?.mode, "pull-request");
    assert.deepEqual(seen?.pullRequestChanges, changes);
  });

  it("treats an empty change list (source-only PR) as pull-request mode", async () => {
    let seen: RecommendationInput | undefined;
    await analyseRepository(repo, {
      adapters: [adapter],
      pullRequestChanges: [],
      recommend: (input) => {
        seen = input;
        return [];
      },
    });
    assert.equal(seen?.mode, "pull-request");
  });

  it("reports added dependencies the analysis could not cover", async () => {
    const result = await analyseRepository(repo, {
      adapters: [adapter],
      pullRequestChanges: [
        added("added"),
        added("ghost"),
        added("requests", "python"),
        { ...added("old"), change: "removed" },
      ],
    });
    const summaries = result.findings.map((f) => f.summary);
    assert.ok(summaries.some((s) => s.startsWith("ghost was added") && s.includes("not found")));
    assert.ok(summaries.some((s) => s.startsWith("requests was added") && s.includes("python")));
    assert.ok(!summaries.some((s) => s.startsWith("added was added")), "covered changes are quiet");
    assert.ok(!summaries.some((s) => s.startsWith("old ")), "removals are policy's call");
  });
});

runRecommendationPolicyContractTests("example scoped unused policy", scopedUnused);
