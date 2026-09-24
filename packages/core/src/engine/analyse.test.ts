import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { adapterApiVersion, type AdapterCapability, type EcosystemAdapter } from "../adapter.js";
import type {
  Dependency,
  DependencyGraph,
  Finding,
  ProjectRef,
  RepositoryHandle,
} from "../types/index.js";
import { UNUSED_CONFIDENCE_CAP } from "../report/severity.js";
import { analyseRepository, detectionConfidence } from "./analyse.js";

// dist/engine -> repository root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixture = path.join(repoRoot, "fixtures/js/basic-unused");

/** Minimal in-memory handle over a fixture directory (the real one is FsRepositoryHandle, #7). */
async function fixtureHandle(dir: string): Promise<RepositoryHandle> {
  const files = new Map<string, string>();
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.set(child, await readFile(path.join(dir, child), "utf8"));
    }
  }
  await walk("");
  return {
    async listFiles() {
      return [...files.keys()].sort();
    },
    async readFile(p) {
      const content = files.get(p);
      if (content === undefined) throw new Error(`missing ${p}`);
      return content;
    },
    async exists(p) {
      return files.has(p);
    },
  };
}

interface MockSpec {
  ecosystem: string;
  confidence?: number;
  deps?: string[];
  capabilities?: AdapterCapability[];
  apiVersion?: string;
  failDetect?: boolean;
  failUsage?: boolean;
  hangDetect?: boolean;
  delayMs?: number;
  /** Replace the default complete graph (needs the dependencyGraph capability). */
  graphs?: (project: ProjectRef) => DependencyGraph[];
  /** A second detected project, to test graph coverage. */
  extraProject?: ProjectRef;
}

function mockAdapter(spec: MockSpec): EcosystemAdapter & { calls: string[] } {
  const project: ProjectRef = { path: ".", ecosystem: spec.ecosystem, packageManagers: [] };
  const caps = new Set<AdapterCapability>(spec.capabilities ?? []);
  const calls: string[] = [];
  const deps: Dependency[] = (spec.deps ?? []).map((name) => ({
    name,
    constraint: "^1.0.0",
    kind: "runtime",
    project,
    declaredIn: "package.json",
  }));
  const adapter: EcosystemAdapter & { calls: string[] } = {
    calls,
    ecosystem: spec.ecosystem,
    apiVersion: spec.apiVersion ?? adapterApiVersion,
    capabilities: caps,
    async detect(ctx) {
      calls.push("detect");
      if (spec.hangDetect) await new Promise(() => {});
      if (spec.failDetect) throw new Error("boom\nwith newline");
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      const hasManifest = await ctx.repository.exists("package.json");
      return {
        confidence: spec.confidence ?? (hasManifest ? 0.9 : 0),
        projects: spec.extraProject ? [project, spec.extraProject] : [project],
        evidence: [{ kind: "manifest-found", statement: `${spec.ecosystem} manifest` }],
      };
    },
    async listDirectDependencies() {
      calls.push("list");
      return [...deps].reverse();
    },
  };
  if (caps.has("usageAnalysis")) {
    adapter.findUsage = async (_ctx, dep) => {
      calls.push(`usage:${dep.name}`);
      if (spec.failUsage) throw new Error("parser exploded");
      return dep.name === "used"
        ? [{ dependency: "used", file: "src/index.js", line: 1, form: "static", symbols: [] }]
        : [];
    };
  }
  if (caps.has("dependencyGraph")) {
    adapter.buildDependencyGraph = async () =>
      spec.graphs
        ? spec.graphs(project)
        : [
            {
              project,
              nodes: [
                { name: "used", version: "1.0.0", dependencies: ["t1"], dev: false },
                { name: "t1", version: "1.0.0", dependencies: [], dev: false },
              ],
              transitiveClosure: { used: ["t1"] },
              incomplete: false,
            },
          ];
  }
  return adapter;
}

describe("unused confidence cap (#178 contract)", () => {
  const finding = (
    kind: Finding["kind"],
    confidence: Finding["confidence"],
    dependency: string,
  ): Finding => ({
    kind,
    rule: kind,
    dependency,
    summary: `${dependency} ${kind}`,
    recommendation: "r",
    evidence: [],
    confidence,
    limitations: [],
    affectedFiles: [],
  });
  const withPolicy = async (findings: Finding[]) => {
    const repo = await fixtureHandle(fixture);
    return analyseRepository(repo, {
      adapters: [mockAdapter({ ecosystem: "js", confidence: 1, deps: ["a"] })],
      recommend: () => findings,
    });
  };

  it("emits a high-computed unused finding at medium, with one run-level note", async () => {
    assert.equal(UNUSED_CONFIDENCE_CAP, "medium");
    const result = await withPolicy([
      finding("unused", "high", "a"),
      finding("unused", "high", "b"),
      finding("should-be-dev", "high", "c"),
      finding("potentially-unnecessary", "high", "d"),
    ]);
    const conf = (dep: string) => result.findings.find((f) => f.dependency === dep)?.confidence;
    assert.equal(conf("a"), "medium");
    assert.equal(conf("b"), "medium");
    // Other kinds are unaffected.
    assert.equal(conf("c"), "high");
    assert.equal(conf("d"), "high");
    const notes = result.findings.filter((f) => f.rule === "unused-confidence-capped");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.kind, "info");
    assert.equal(notes[0]?.summary, "unused confidence capped pending corpus validation");
  });

  it("never raises confidence and adds no note when nothing was capped", async () => {
    const result = await withPolicy([
      finding("unused", "low", "a"),
      finding("unused", "medium", "b"),
    ]);
    assert.equal(result.findings.find((f) => f.dependency === "a")?.confidence, "low");
    assert.equal(result.findings.find((f) => f.dependency === "b")?.confidence, "medium");
    assert.ok(!result.findings.some((f) => f.rule === "unused-confidence-capped"));
  });
});

describe("analyseRepository", () => {
  describe("surface graph completeness (#114)", () => {
    const node = (name: string) => ({ name, version: "1.0.0", dependencies: [], dev: false });
    const graph = (project: ProjectRef, names: string[], incomplete: boolean): DependencyGraph => ({
      project,
      nodes: names.map(node),
      transitiveClosure: {},
      incomplete,
    });
    const surfaceFor = async (graphs: (project: ProjectRef) => DependencyGraph[]) => {
      const repo = await fixtureHandle(fixture);
      const adapter = mockAdapter({
        ecosystem: "js",
        confidence: 1,
        deps: ["a"],
        capabilities: ["dependencyGraph"],
        graphs,
      });
      return (await analyseRepository(repo, { adapters: [adapter] })).surface;
    };

    it("reads an empty incomplete graph (no lockfile) as none, not zero", async () => {
      assert.deepEqual(await surfaceFor((p) => [graph(p, [], true)]), [
        { ecosystem: "js", direct: 1, transitive: 0, graphs: "none" },
      ]);
    });

    it("reads no graphs at all as none", async () => {
      assert.deepEqual(await surfaceFor(() => []), [
        { ecosystem: "js", direct: 1, transitive: 0, graphs: "none" },
      ]);
    });

    it("reads a graph marked incomplete as partial", async () => {
      assert.deepEqual(await surfaceFor((p) => [graph(p, ["a", "b"], true)]), [
        { ecosystem: "js", direct: 1, transitive: 2, graphs: "partial" },
      ]);
    });

    it("reads a usable graph next to a project with no lockfile as partial", async () => {
      const other: ProjectRef = { path: "packages/lib", ecosystem: "js", packageManagers: [] };
      assert.deepEqual(await surfaceFor((p) => [graph(p, ["a"], false), graph(other, [], true)]), [
        { ecosystem: "js", direct: 1, transitive: 1, graphs: "partial" },
      ]);
    });

    it("reads a detected project with no graph returned as partial", async () => {
      const repo = await fixtureHandle(fixture);
      const adapter = mockAdapter({
        ecosystem: "js",
        confidence: 1,
        deps: ["a"],
        capabilities: ["dependencyGraph"],
        extraProject: { path: "packages/lib", ecosystem: "js", packageManagers: [] },
        graphs: (p) => [graph(p, ["a"], false)],
      });
      const result = await analyseRepository(repo, { adapters: [adapter] });
      assert.equal(result.surface[0]?.graphs, "partial");
    });

    it("reads a complete graph for every project as complete", async () => {
      assert.deepEqual(await surfaceFor((p) => [graph(p, ["a"], false)]), [
        { ecosystem: "js", direct: 1, transitive: 1, graphs: "complete" },
      ]);
    });

    it("reads an empty complete graph as a real zero", async () => {
      assert.deepEqual(await surfaceFor((p) => [graph(p, [], false)]), [
        { ecosystem: "js", direct: 1, transitive: 0, graphs: "complete" },
      ]);
    });
  });

  it("runs detected adapters over a fixture and assembles one result", async () => {
    const repo = await fixtureHandle(fixture);
    const js = mockAdapter({
      ecosystem: "javascript-typescript",
      deps: ["used", "unused"],
      capabilities: ["usageAnalysis", "dependencyGraph"],
    });
    const result = await analyseRepository(repo, { adapters: [js] });
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(
      result.dependencies.map((d) => d.name),
      ["unused", "used"],
    );
    assert.equal(result.usages.length, 1);
    assert.deepEqual(result.detected, [
      {
        ecosystem: "javascript-typescript",
        confidence: "high",
        evidence: [{ kind: "manifest-found", statement: "javascript-typescript manifest" }],
      },
    ]);
    assert.deepEqual(result.surface, [
      { ecosystem: "javascript-typescript", direct: 2, transitive: 2, graphs: "complete" },
    ]);
    assert.deepEqual(result.findings, []);
  });

  it("only runs adapters above the detection threshold", async () => {
    const repo = await fixtureHandle(fixture);
    const low = mockAdapter({ ecosystem: "python", confidence: 0.2, deps: ["requests"] });
    const result = await analyseRepository(repo, { adapters: [low] });
    assert.deepEqual(low.calls, ["detect"]);
    assert.deepEqual(result.detected, []);
    assert.deepEqual(result.dependencies, []);
    const strict = await analyseRepository(repo, {
      adapters: [mockAdapter({ ecosystem: "js", confidence: 0.9 })],
      detectionThreshold: 0.95,
    });
    assert.deepEqual(strict.detected, []);
  });

  it("skips missing capabilities without calling them", async () => {
    const repo = await fixtureHandle(fixture);
    const factsOnly = mockAdapter({ ecosystem: "rust", confidence: 1, deps: ["serde"] });
    let seen: ReadonlySet<string> | undefined;
    const result = await analyseRepository(repo, {
      adapters: [factsOnly],
      recommend: (input) => {
        seen = input.usageAnalysedEcosystems;
        return [];
      },
    });
    assert.deepEqual(factsOnly.calls, ["detect", "list"]);
    assert.deepEqual(result.surface, [
      { ecosystem: "rust", direct: 1, transitive: 0, graphs: "none" },
    ]);
    assert.equal(seen?.has("rust"), false);
  });

  it("isolates a failing adapter as an info finding", async () => {
    const repo = await fixtureHandle(fixture);
    const result = await analyseRepository(repo, {
      adapters: [
        mockAdapter({ ecosystem: "broken", failDetect: true }),
        mockAdapter({ ecosystem: "go", confidence: 1, deps: ["x"] }),
      ],
    });
    assert.deepEqual(
      result.dependencies.map((d) => d.name),
      ["x"],
    );
    const finding = result.findings.find((f) => f.summary.startsWith("broken"));
    assert.ok(finding);
    assert.equal(finding.kind, "info");
    assert.equal(finding.confidence, "low");
    assert.ok(!finding.summary.includes("\n"), "adapter error text is flattened");
    assert.ok(finding.limitations.length > 0);
  });

  it("keeps dependencies when usage analysis fails, without marking usage as analysed", async () => {
    const repo = await fixtureHandle(fixture);
    let seen: ReadonlySet<string> | undefined;
    const result = await analyseRepository(repo, {
      adapters: [
        mockAdapter({
          ecosystem: "js",
          confidence: 1,
          deps: ["used"],
          capabilities: ["usageAnalysis"],
          failUsage: true,
        }),
      ],
      recommend: (input) => {
        seen = input.usageAnalysedEcosystems;
        return [];
      },
    });
    assert.equal(result.dependencies.length, 1);
    assert.equal(result.usages.length, 0);
    assert.ok(result.findings.some((f) => f.summary.includes("usage analysis")));
    assert.equal(seen?.has("js"), false, "policy must not treat failed usage as 'no usage'");
  });

  it("times out a hanging adapter", async () => {
    const repo = await fixtureHandle(fixture);
    const result = await analyseRepository(repo, {
      adapters: [mockAdapter({ ecosystem: "slow", hangDetect: true })],
      adapterTimeoutMs: 20,
    });
    assert.ok(result.findings.some((f) => f.summary.includes("timed out during detection")));
  });

  it("does not preempt synchronous adapter work (pins current behaviour, see #90)", async () => {
    const repo = await fixtureHandle(fixture);
    const busy: EcosystemAdapter = {
      ...mockAdapter({ ecosystem: "busy", confidence: 1 }),
      async detect() {
        const end = Date.now() + 100;
        while (Date.now() < end) {
          // synchronous busy loop: never yields to the event loop
        }
        return { confidence: 1, projects: [], evidence: [{ kind: "k", statement: "s" }] };
      },
    };
    const started = Date.now();
    const result = await analyseRepository(repo, { adapters: [busy], adapterTimeoutMs: 10 });
    assert.ok(Date.now() - started >= 100, "the run waits for sync work to finish");
    assert.deepEqual(
      result.detected.map((d) => d.ecosystem),
      ["busy"],
      "sync work that returns is not reported as timed out",
    );
  });

  it("aborts the adapter's signal on timeout so cooperative adapters can stop", async () => {
    const repo = await fixtureHandle(fixture);
    let observed: AbortSignal | undefined;
    const cooperative: EcosystemAdapter = {
      ...mockAdapter({ ecosystem: "coop" }),
      async detect(ctx) {
        observed = ctx.signal;
        await new Promise((resolve) => ctx.signal?.addEventListener("abort", resolve));
        return { confidence: 0, projects: [], evidence: [] };
      },
    };
    const result = await analyseRepository(repo, { adapters: [cooperative], adapterTimeoutMs: 10 });
    assert.equal(observed?.aborted, true);
    assert.ok(result.findings.some((f) => f.summary.includes("timed out during detection")));
  });

  it("bounds concurrent usage analysis", async () => {
    const repo = await fixtureHandle(fixture);
    const names = Array.from({ length: 20 }, (_, i) => `dep${String(i).padStart(2, "0")}`);
    const base = mockAdapter({
      ecosystem: "js",
      confidence: 1,
      deps: names,
      capabilities: ["usageAnalysis"],
    });
    let inFlight = 0;
    let peak = 0;
    base.findUsage = async (_ctx, dep) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return [{ dependency: dep.name, file: "src/index.js", line: 1, form: "static", symbols: [] }];
    };
    const result = await analyseRepository(repo, { adapters: [base], usageConcurrency: 3 });
    assert.equal(peak, 3);
    assert.equal(result.usages.length, 20);
  });

  it("skips adapters built for an incompatible API version", async () => {
    const repo = await fixtureHandle(fixture);
    const old = mockAdapter({ ecosystem: "old", confidence: 1, apiVersion: "9.0.0" });
    const result = await analyseRepository(repo, { adapters: [old] });
    assert.deepEqual(old.calls, []);
    assert.ok(result.findings.some((f) => f.evidence[0]?.kind === "adapter-api-mismatch"));
  });

  it("passes facts to recommendation policy and isolates policy failure", async () => {
    const repo = await fixtureHandle(fixture);
    const adapters = [
      mockAdapter({
        ecosystem: "js",
        confidence: 1,
        deps: ["used", "unused"],
        capabilities: ["usageAnalysis"],
      }),
    ];
    const ok = await analyseRepository(repo, {
      adapters,
      recommend: ({ dependencies, usages, usageAnalysedEcosystems }) =>
        dependencies
          .filter((d) => usageAnalysedEcosystems.has(d.project.ecosystem))
          .filter((d) => !usages.some((u) => u.dependency === d.name))
          .map((d) => ({
            kind: "unused" as const,
            dependency: d.name,
            summary: `${d.name} is never imported`,
            recommendation: "Remove it.",
            evidence: [{ kind: "no-import-found", statement: "no imports" }],
            confidence: "high" as const,
            limitations: [],
            affectedFiles: [d.declaredIn],
          })),
    });
    assert.deepEqual(
      ok.findings.filter((f) => f.kind !== "info").map((f) => f.dependency),
      ["unused"],
    );
    const failed = await analyseRepository(repo, {
      adapters,
      recommend: () => {
        throw new Error("policy bug");
      },
    });
    assert.ok(failed.findings.some((f) => f.evidence[0]?.kind === "policy-error"));
    assert.equal(failed.dependencies.length, 2, "facts survive a policy failure");
  });

  it("drops non-plain policy findings instead of aborting on a sort tie", async () => {
    const repo = await fixtureHandle(fixture);
    const tied = (evidence: unknown) =>
      ({
        kind: "unused",
        dependency: "x",
        summary: "same",
        recommendation: "Remove it.",
        evidence: [evidence],
        confidence: "high",
        limitations: [],
        affectedFiles: [],
      }) as unknown as Finding;
    const result = await analyseRepository(repo, {
      adapters: [mockAdapter({ ecosystem: "js", confidence: 1, deps: ["x"] })],
      recommend: () => [
        tied({ kind: "a", statement: "plain" }),
        tied({ kind: "a", statement: "date", at: new Date(0) }),
        tied({ kind: "a", statement: "map", extra: new Map([["k", 1]]) }),
        tied({ kind: "a", statement: "nan", line: Number.NaN }),
      ],
    });
    const unused = result.findings.filter((f) => f.kind === "unused");
    assert.equal(unused.length, 1);
    assert.equal(unused[0]?.evidence[0]?.statement, "plain");
    assert.ok(
      result.findings.some((f) => f.summary.includes("3 finding(s) that are not plain data")),
    );
  });

  it("is deterministic regardless of adapter order and completion timing", async () => {
    const repo = await fixtureHandle(fixture);
    const make = () => [
      mockAdapter({ ecosystem: "b-eco", confidence: 1, deps: ["z", "a"], delayMs: 5 }),
      mockAdapter({ ecosystem: "a-eco", confidence: 1, deps: ["m"], delayMs: 1 }),
      mockAdapter({ ecosystem: "c-eco", failDetect: true }),
    ];
    const first = await analyseRepository(repo, { adapters: make() });
    const second = await analyseRepository(repo, { adapters: make().reverse() });
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.detected.map((d) => d.ecosystem),
      ["a-eco", "b-eco"],
    );
  });

  it("maps detection scores onto the confidence scale", () => {
    assert.equal(detectionConfidence(0.95), "high");
    assert.equal(detectionConfidence(0.6), "medium");
    assert.equal(detectionConfidence(0.1), "low");
  });
});

describe("head reads inside the engine (#113)", () => {
  const project: ProjectRef = { path: ".", ecosystem: "js", packageManagers: [] };
  const sniffer = (paths: string[], heads: (string | undefined)[]): EcosystemAdapter => ({
    ecosystem: "js",
    apiVersion: adapterApiVersion,
    capabilities: new Set(),
    async detect(ctx) {
      for (const p of paths) heads.push(await ctx.repository.readFileHead?.(p, 16));
      return { confidence: 1, projects: [project], evidence: [{ kind: "k", statement: "s" }] };
    },
    async listDirectDependencies() {
      return [];
    },
  });
  const tooLarge = Object.assign(new Error("too-large: yarn.lock"), { code: "too-large" });
  const bare: RepositoryHandle = {
    async listFiles() {
      return ["yarn.lock", "small.lock"];
    },
    async readFile(p) {
      if (p === "yarn.lock") throw tooLarge;
      if (p === "small.lock") return "__metadata:\n  version: 8\n";
      throw new Error(`not found: ${p}`);
    },
    async exists() {
      return true;
    },
  };

  it("gives a handle without readFileHead the fallback, and notes files over the ceiling", async () => {
    const heads: (string | undefined)[] = [];
    const result = await analyseRepository(bare, {
      adapters: [sniffer(["small.lock", "yarn.lock", "yarn.lock", "missing"], heads)],
    });
    assert.deepEqual(heads, ["__metadata:\n  ve", undefined, undefined, undefined]);
    const notes = result.findings.filter((f) => f.rule === "file-not-sniffed");
    // One note per file, none for plain not-found.
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0]?.affectedFiles, ["yarn.lock"]);
    // Treated as scan incompleteness (#154 cap-and-note).
    assert.ok(result.findings.some((f) => f.summary.startsWith("all verdicts in this result")));
  });

  it("notes each unsniffed file once per run, across adapters", async () => {
    const result = await analyseRepository(bare, {
      adapters: [sniffer(["yarn.lock"], []), { ...sniffer(["yarn.lock"], []), ecosystem: "py" }],
    });
    assert.equal(result.findings.filter((f) => f.rule === "file-not-sniffed").length, 1);
  });

  it("passes a handle that has readFileHead straight through, with no notes", async () => {
    const heads: (string | undefined)[] = [];
    const withHead: RepositoryHandle = { ...bare, readFileHead: async () => "own" };
    const result = await analyseRepository(withHead, {
      adapters: [sniffer(["yarn.lock"], heads)],
    });
    assert.deepEqual(heads, ["own"]);
    assert.ok(!result.findings.some((f) => f.rule === "file-not-sniffed"));
  });
});
