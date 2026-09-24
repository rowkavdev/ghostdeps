import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { runRecommendationPolicyContractTests } from "../contract-tests/policy.js";
import type { DependencyChange } from "../diff/dependency-changes.js";
import { defaultPolicy } from "../recommend/policy.js";
import type {
  Finding,
  ProjectRef,
  RepositoryHandle,
  SourceLineChanges,
  Usage,
} from "../types/index.js";
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
  return (
    input.dependencies
      .filter((d) => input.usageAnalysedEcosystems.has(d.project.ecosystem))
      // High-confidence absence claims need complete reference analysis.
      .filter((d) => input.referenceAnalysedEcosystems.has(d.project.ecosystem))
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
      }))
  );
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

describe("PR source changes reach usage analysis (#101)", () => {
  /** Matches removed lines naively by name; real adapters own the matching. */
  const seen: (readonly SourceLineChanges[] | undefined)[] = [];
  const usageAdapter: EcosystemAdapter = {
    ...adapter,
    capabilities: new Set(["usageAnalysis", "referenceAnalysis"]),
    async listDirectDependencies() {
      return ["dropped", "kept"].map((name) => ({
        name,
        constraint: "^1.0.0",
        kind: "runtime" as const,
        project,
        declaredIn: "package.json",
      }));
    },
    async findUsage(context, dependency) {
      seen.push(context.pullRequestSourceChanges);
      const usages: Usage[] = [];
      if (dependency.name === "kept") {
        usages.push({ dependency: "kept", file: "src/a.ts", line: 1, form: "static", symbols: [] });
      }
      for (const file of context.pullRequestSourceChanges ?? []) {
        for (const l of file.removedLines) {
          if (l.text.includes(`"${dependency.name}"`)) {
            usages.push({
              dependency: dependency.name,
              file: file.path,
              line: l.line,
              form: "static",
              symbols: [],
              removedInPr: true,
            });
          }
        }
      }
      return { usages, referenceAnalysisComplete: true };
    },
  };
  const sourceChanges: SourceLineChanges[] = [
    {
      path: "src/a.ts",
      removedLines: [
        { line: 4, text: 'import d from "dropped";' },
        { line: 5, text: 'import k from "kept";' },
      ],
      addedLines: [],
    },
  ];

  it("reports a PR-scoped unused finding when the PR removed the last use", async () => {
    seen.length = 0;
    const result = await analyseRepository(repo, {
      adapters: [usageAdapter],
      recommend: defaultPolicy,
      pullRequestChanges: [],
      pullRequestSourceChanges: sourceChanges,
    });
    assert.deepEqual(seen[0], sourceChanges);
    const verdicts = result.findings.filter((f) => f.kind === "unused");
    assert.deepEqual(
      verdicts.map((f) => [f.rule, f.dependency]),
      [["removed-last-usage", "dropped"]],
    );
    assert.deepEqual(
      verdicts[0]?.evidence.find((e) => e.kind === "usage-removed-in-pr"),
      {
        kind: "usage-removed-in-pr",
        statement: "this pull request removes a use of dropped",
        file: "src/a.ts",
        line: 4,
      },
    );
    assert.deepEqual(verdicts[0]?.affectedFiles, ["package.json", "src/a.ts"]);
    // "kept" is still used at head: its removed line is not a verdict.
    assert.ok(!result.findings.some((f) => f.dependency === "kept"));
  });

  it("never forwards source changes on a full scan", async () => {
    seen.length = 0;
    await analyseRepository(repo, {
      adapters: [usageAdapter],
      recommend: defaultPolicy,
      pullRequestSourceChanges: sourceChanges,
    });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((s) => s === undefined));
  });

  it("notes capped source changes in the result", async () => {
    const result = await analyseRepository(repo, {
      adapters: [usageAdapter],
      recommend: defaultPolicy,
      pullRequestChanges: [],
      pullRequestSourceChanges: [
        { path: "../escape.ts", removedLines: [], addedLines: [] },
        ...sourceChanges,
      ],
    });
    assert.ok(result.findings.some((f) => f.rule === "pr-source-changes-capped"));
    assert.ok(result.findings.some((f) => f.rule === "removed-last-usage"));
  });
});
