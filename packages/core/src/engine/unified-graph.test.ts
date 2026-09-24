import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Dependency,
  DependencyGraph,
  Finding,
  GraphNode,
  ProjectRef,
} from "../types/index.js";
import { assembleAnalysisResult, type RecommendationPolicy } from "./analyse.js";
import type { AdapterOutcome } from "./run-adapter.js";
import { buildUnifiedGraph } from "./unified-graph.js";

const project = (ecosystem: string, path: string): ProjectRef => ({
  ecosystem,
  path,
  packageManagers: [],
});
const node = (name: string, version: string, deps: string[] = [], dev = false): GraphNode => ({
  name,
  version,
  dependencies: deps,
  dev,
});
const graph = (p: ProjectRef, nodes: GraphNode[]): DependencyGraph => ({
  project: p,
  nodes,
  transitiveClosure: {},
  incomplete: false,
});
const dep = (p: ProjectRef, name: string): Dependency => ({
  name,
  constraint: "*",
  kind: "runtime",
  project: p,
  declaredIn: `${p.path}/manifest`,
});

const web = project("js", "packages/web");
const api = project("js", "packages/api");
const svc = project("py", "services/svc");

describe("buildUnifiedGraph (#55)", () => {
  it("merges project graphs by ecosystem + name + version and records reach", () => {
    const { graph: g, note } = buildUnifiedGraph(
      [
        graph(web, [node("react", "18.0.0", ["loose-envify"]), node("loose-envify", "1.4.0")]),
        graph(api, [node("loose-envify", "1.4.0", [], true), node("debug", "4.3.4")]),
        graph(svc, [node("debug", "1.0.0")]),
      ],
      [dep(web, "react"), dep(api, "debug"), dep(svc, "debug")],
      [
        { ecosystem: "js", direct: 2, transitive: 3, graphs: "complete" },
        { ecosystem: "py", direct: 1, transitive: 1, graphs: "partial" },
      ],
    );
    assert.equal(note, undefined);
    assert.equal(g.truncated, false);
    assert.deepEqual(
      g.nodes.map((n) => n.id),
      ["js:debug@4.3.4", "js:loose-envify@1.4.0", "js:react@18.0.0", "py:debug@1.0.0"],
    );
    const envify = g.nodes.find((n) => n.name === "loose-envify")!;
    assert.deepEqual(envify.projects, ["js:packages/api", "js:packages/web"]);
    assert.deepEqual(envify.directIn, []);
    // dev only when every project marks it dev.
    assert.equal(envify.dev, false);
    // npm debug and PyPI debug never merge.
    assert.deepEqual(g.nodes.find((n) => n.id === "py:debug@1.0.0")!.directIn, ["py:services/svc"]);
    assert.deepEqual(g.nodes.find((n) => n.id === "js:react@18.0.0")!.dependencies, [
      "loose-envify",
    ]);
    assert.deepEqual(g.ecosystems, [
      { ecosystem: "js", graphs: "complete", nodes: 3, emitted: 3 },
      { ecosystem: "py", graphs: "partial", nodes: 1, emitted: 1 },
    ]);
  });

  it("caps the emitted graph, keeping direct packages first, with one note", () => {
    const { graph: g, note } = buildUnifiedGraph(
      [graph(web, [node("a", "1"), node("b", "1"), node("z-direct", "1")])],
      [dep(web, "z-direct")],
      [{ ecosystem: "js", direct: 1, transitive: 3, graphs: "complete" }],
      2,
    );
    assert.equal(g.truncated, true);
    assert.deepEqual(
      g.nodes.map((n) => n.id),
      ["js:a@1", "js:z-direct@1"],
    );
    assert.deepEqual(g.ecosystems, [{ ecosystem: "js", graphs: "complete", nodes: 3, emitted: 2 }]);
    assert.equal(note?.kind, "info");
    assert.equal(note?.rule, "graph-truncated");
  });
});

describe("unified graph in the result (#55)", () => {
  const outcome = (): AdapterOutcome => ({
    ecosystem: "js",
    dependencies: [dep(web, "left-pad"), dep(web, "react")],
    usages: [],
    graphs: [
      graph(web, [
        node("left-pad", "1.3.0"),
        node("react", "18.0.0", ["loose-envify"]),
        node("loose-envify", "1.4.0"),
      ]),
    ],
    usageAnalysed: true,
    findings: [],
    detected: { confidence: "high", projects: [web], evidence: [] },
  });
  // A policy that reads the graphs: one finding per graph node.
  const policy: RecommendationPolicy = ({ graphs }) =>
    graphs.flatMap((g) =>
      g.nodes.map((n): Finding => ({
        kind: "footprint",
        dependency: n.name,
        summary: `${n.name} is in the graph`,
        recommendation: "r",
        evidence: [],
        confidence: "high",
        limitations: [],
        affectedFiles: [],
      })),
    );

  it("a capped graph never changes a verdict", async () => {
    const full = await assembleAnalysisResult([outcome()], policy);
    const capped = await assembleAnalysisResult([outcome()], policy, undefined, {
      maxGraphNodes: 1,
    });
    assert.equal(full.graph?.truncated, false);
    assert.equal(full.graph?.nodes.length, 3);
    assert.equal(capped.graph?.truncated, true);
    assert.equal(capped.graph?.nodes.length, 1);
    const verdicts = (r: typeof full) => r.findings.filter((f) => f.rule !== "graph-truncated");
    assert.deepEqual(verdicts(capped), verdicts(full));
    assert.equal(verdicts(full).length, 3);
    const notes = capped.findings.filter((f) => f.rule === "graph-truncated");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.severity, "info");
  });
});
