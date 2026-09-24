import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { createDefaultPolicy } from "../recommend/index.js";
import {
  findingGroup,
  type Dependency,
  type DependencyGraph,
  type ProjectRef,
  type RepositoryHandle,
} from "../types/index.js";
import { analyseRepository } from "./analyse.js";
import { computeImpact } from "./impact.js";

const project = (path: string, ecosystem = "npm"): ProjectRef => ({
  path,
  ecosystem,
  packageManagers: [],
});
const dep = (name: string, p: ProjectRef = project(".")): Dependency => ({
  name,
  constraint: "^1",
  kind: "runtime",
  project: p,
  declaredIn: "package.json",
});
const graph = (
  closure: Record<string, string[]>,
  incomplete = false,
  p: ProjectRef = project("."),
): DependencyGraph => ({
  project: p,
  nodes: Object.values(closure)
    .flat()
    .map((name) => ({ name, version: "1.0.0", dependencies: [], dev: false })),
  transitiveClosure: closure,
  incomplete,
});
const byName = (r: ReturnType<typeof computeImpact>) =>
  Object.fromEntries(r.impact.map((i) => [i.name, i]));

describe("computeImpact (#59)", () => {
  it("counts transitive and exclusive packages on a complete graph", () => {
    const r = byName(
      computeImpact(
        [
          graph({
            a: ["a", "x", "shared", "b"],
            b: ["b", "shared", "y"],
            c: [],
          }),
        ],
        [dep("a"), dep("b"), dep("c")],
      ),
    );
    // a reaches x, shared and b; b is declared directly and shared is also
    // reached by b, so only x is exclusive.
    assert.deepEqual([r.a!.transitive, r.a!.exclusive, r.a!.graph], [3, 1, "complete"]);
    assert.deepEqual([r.b!.transitive, r.b!.exclusive], [2, 1]);
    assert.deepEqual([r.c!.transitive, r.c!.exclusive], [0, 0]);
  });

  it("drops exclusive for the whole project when any direct closure is missing", () => {
    // Reviewer's repro: the lockfile spells PyYAML as pyyaml, so PyYAML has
    // no closure entry and urllib3 must not look exclusive to requests.
    const r = byName(
      computeImpact(
        [graph({ requests: ["urllib3", "idna"], pyyaml: ["urllib3"] })],
        [dep("requests"), dep("PyYAML")],
      ),
    );
    assert.deepEqual([r.requests!.transitive, r.requests!.exclusive], [2, null]);
    assert.deepEqual([r.PyYAML!.transitive, r.PyYAML!.exclusive], [null, null]);
  });

  it("emits one row per name per project", () => {
    const r = computeImpact([graph({ a: ["x"] })], [dep("a"), { ...dep("a"), kind: "dev" }]);
    assert.equal(r.impact.length, 1);
    assert.deepEqual([r.impact[0]!.transitive, r.impact[0]!.exclusive], [1, 1]);
  });

  it("gives a lower bound and no exclusive on a partial graph", () => {
    const r = byName(computeImpact([graph({ a: ["x", "y"] }, true)], [dep("a")]));
    assert.deepEqual([r.a!.graph, r.a!.transitive, r.a!.exclusive], ["partial", 2, null]);
  });

  it("is unknown (null, never 0) with no graph or no closure entry", () => {
    const other = project("svc");
    const r = computeImpact(
      [graph({ a: ["x"] }), graph({}, true, other)],
      [dep("a"), dep("missing"), dep("z", other)],
    );
    const m = byName(r);
    assert.deepEqual([m.missing!.transitive, m.missing!.exclusive], [null, null]);
    assert.deepEqual([m.z!.graph, m.z!.transitive, m.z!.exclusive], ["none", null, null]);
  });

  it("keeps ecosystems and projects apart", () => {
    const py = project(".", "python");
    const r = computeImpact(
      [graph({ debug: ["ms"] }), graph({ debug: [] }, false, py)],
      [dep("debug"), dep("debug", py)],
    );
    assert.deepEqual(r.impact.map((i) => [i.ecosystem, i.transitive]).sort(), [
      ["npm", 1],
      ["python", 0],
    ]);
  });

  it("marks whole projects limited past the budget, deterministically", () => {
    const second = project("b");
    const r = computeImpact(
      [graph({ a: ["x", "y"] }), graph({ q: ["x", "y", "z"] }, false, second)],
      [dep("a"), dep("q", second)],
      4,
    );
    const m = byName(r);
    assert.deepEqual([m.a!.transitive, m.a!.limited], [2, undefined]);
    assert.deepEqual([m.q!.transitive, m.q!.exclusive, m.q!.limited], [null, null, true]);
    assert.deepEqual([r.limitedProjects, r.limitedDependencies], [1, 1]);
  });

  it("ignores hostile closure shapes", () => {
    const g = graph({ a: ["x"] });
    (g.transitiveClosure as Record<string, unknown>).b = "nope";
    const r = byName(computeImpact([g], [dep("a"), dep("b"), dep("__proto__")]));
    assert.equal(r.a!.transitive, 1);
    assert.equal(r.b!.transitive, null);
    assert.equal(r["__proto__"]?.transitive ?? null, null);
  });
});

describe("impact in the analysis result (#59)", () => {
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
  const p = project(".", "mock");
  const adapter: EcosystemAdapter = {
    ecosystem: "mock",
    apiVersion: adapterApiVersion,
    capabilities: new Set(["usageAnalysis", "referenceAnalysis", "dependencyGraph"]),
    async detect() {
      return { confidence: 0.9, projects: [p], evidence: [] };
    },
    async listDirectDependencies() {
      return [dep("a", p), dep("b", p)];
    },
    async buildDependencyGraph() {
      return [graph({ a: ["a", "x"], b: ["b"] }, false, p)];
    },
    async findUsage() {
      return { usages: [], referenceAnalysisComplete: true };
    },
  };

  it("is emitted in canonical order and adds no finding", async () => {
    const result = await analyseRepository(handle, {
      adapters: [adapter],
      recommend: createDefaultPolicy(),
    });
    assert.deepEqual(
      result.impact?.map((i) => [i.name, i.transitive, i.exclusive]),
      [
        ["a", 1, 1],
        ["b", 0, 0],
      ],
    );
    assert.ok(!result.findings.some((f) => f.rule === "impact-limited"));
  });
});

describe("impact-limited note", () => {
  it("is a non-capping note", async () => {
    const { impactLimitedNote } = await import("./impact.js");
    const note = impactLimitedNote(1, 3);
    assert.equal(findingGroup(note), "note");
    assert.match(note.summary, /3 dependencies in 1 project/);
  });
});
