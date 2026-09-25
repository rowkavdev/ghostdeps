import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Dependency,
  DependencyGraph,
  PackageMetadataProvider,
  PackageRegistryFacts,
  ProjectRef,
} from "../types/index.js";
import { healthFindings } from "./health.js";

const project: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };
const dep: Dependency = {
  name: "example",
  constraint: "^1.0.0",
  kind: "runtime",
  project,
  declaredIn: "package.json",
};
const origin = "https://registry.npmjs.org";
const graph: DependencyGraph = {
  project,
  nodes: [
    { name: "example", version: "1.0.0", registryOrigin: origin, dependencies: [], dev: false },
  ],
  transitiveClosure: { example: [] },
  incomplete: false,
};
const answer: PackageRegistryFacts = {
  name: "example",
  version: "1.0.0",
  origin,
  publishedAt: { value: "2022-01-02T00:00:00.000Z", basis: "npm registry time[version]" },
  deprecated: { value: true, basis: "npm registry versions[version].deprecated" },
  repositoryArchived: { value: true, basis: "repository host archived status" },
};
const provider = (facts: readonly PackageRegistryFacts[]): PackageMetadataProvider => ({
  async installSizes() {
    return undefined;
  },
  async packageFacts() {
    return facts;
  },
});

describe("source-backed health signals (#61)", () => {
  it("reports only explicit facts with a basis, without staleness or cadence claims", async () => {
    const found = await healthFindings([dep], [graph], provider([answer]));
    assert.deepEqual(
      found.map((f) => f.rule),
      ["registry-deprecated", "repository-archived", "locked-version-published"],
    );
    for (const finding of found) {
      assert.equal(finding.kind, "info");
      assert.equal(finding.dependency, "example");
      assert.match(finding.evidence[0]!.statement, /source:/);
      assert.doesNotMatch(
        finding.summary + finding.recommendation,
        /remove|stale|last release|cadence/i,
      );
    }
    assert.match(found[2]!.summary, /locked version 1\.0\.0 published 2022-01-02/);
  });

  it("does not guess false, absent, malformed or sourceless facts", async () => {
    assert.deepEqual(
      await healthFindings(
        [dep],
        [graph],
        provider([
          {
            ...answer,
            deprecated: { value: false, basis: "registry" },
            repositoryArchived: { value: true, basis: "" },
            publishedAt: { value: "not a date", basis: "registry" },
          },
        ]),
      ),
      [],
    );
    assert.deepEqual(await healthFindings([dep], [graph], provider([])), []);
    assert.deepEqual(await healthFindings([dep], [graph], undefined), []);
  });

  it("never trusts wrong versions, origins, missing locks, or conflicting locks", async () => {
    assert.deepEqual(
      await healthFindings([dep], [graph], provider([{ ...answer, version: "2.0.0" }])),
      [],
    );
    assert.deepEqual(
      await healthFindings(
        [dep],
        [graph],
        provider([{ ...answer, origin: "https://private.example" }]),
      ),
      [],
    );
    assert.deepEqual(await healthFindings([dep], [], provider([answer])), []);
    assert.deepEqual(
      await healthFindings(
        [dep],
        [{ ...graph, nodes: [...graph.nodes, { ...graph.nodes[0]!, version: "2.0.0" }] }],
        provider([answer]),
      ),
      [],
    );
  });

  it("fails quiet on offline errors and bounded timeouts", async () => {
    const error: PackageMetadataProvider = {
      async installSizes() {
        return undefined;
      },
      async packageFacts() {
        throw new Error("offline");
      },
    };
    assert.deepEqual(await healthFindings([dep], [graph], error), []);
    const slow: PackageMetadataProvider = {
      async installSizes() {
        return undefined;
      },
      async packageFacts() {
        return new Promise(() => {});
      },
    };
    assert.deepEqual(await healthFindings([dep], [graph], slow, 1), []);
  });
});

it("rejects every duplicate answer for a locked package", async () => {
  assert.deepEqual(await healthFindings([dep], [graph], provider([answer, answer, answer])), []);
});

it("includes only touched dependencies in a PR-mode analysis", async () => {
  const { assembleAnalysisResult } = await import("./analyse.js");
  const outcome = {
    ecosystem: project.ecosystem,
    detected: { confidence: "high" as const, projects: [project], evidence: [] },
    dependencies: [dep],
    usages: [],
    graphs: [graph],
    findings: [],
    adapterNotes: [],
    usageAnalysed: false,
    referenceAnalysed: false,
  };
  const noChange = await assembleAnalysisResult([outcome], undefined, [], {
    metadata: provider([answer]),
  });
  assert.ok(!noChange.findings.some((f) => f.rule === "registry-deprecated"));
  const changed = await assembleAnalysisResult(
    [outcome],
    undefined,
    [
      {
        ecosystem: project.ecosystem,
        name: dep.name,
        change: "changed",
        manifest: dep.declaredIn,
      },
    ],
    { metadata: provider([answer]) },
  );
  assert.ok(changed.findings.some((f) => f.rule === "registry-deprecated"));
  assert.ok(changed.findings.some((f) => f.rule === "locked-version-published"));
});
