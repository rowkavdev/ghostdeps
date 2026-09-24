import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { createDefaultPolicy } from "../recommend/index.js";
import type {
  Dependency,
  DependencyGraph,
  DependencyImpact,
  PackageMetadataProvider,
  PackageVersionRef,
  ProjectRef,
  RepositoryHandle,
} from "../types/index.js";
import { analyseRepository } from "./analyse.js";
import { addFootprints, MAX_FOOTPRINT_PACKAGES } from "./footprint.js";

const project = (path: string, ecosystem = "npm"): ProjectRef => ({
  path,
  ecosystem,
  packageManagers: [],
});
const node = (name: string, version = "1.0.0") => ({ name, version, dependencies: [], dev: false });
const graph = (
  nodes: ReturnType<typeof node>[],
  closure: Record<string, string[]>,
  p: ProjectRef = project("."),
): DependencyGraph => ({ project: p, nodes, transitiveClosure: closure, incomplete: false });
const entry = (
  name: string,
  transitive: number | null,
  p: ProjectRef = project("."),
): DependencyImpact => ({
  ecosystem: p.ecosystem,
  project: p.path,
  name,
  graph: "complete",
  transitive,
  exclusive: null,
});
const sizes = (
  map: Record<string, number>,
  basis = "npm unpackedSize",
): PackageMetadataProvider & {
  calls: { ecosystem: string; packages: readonly PackageVersionRef[] }[];
} => {
  const calls: { ecosystem: string; packages: readonly PackageVersionRef[] }[] = [];
  return {
    calls,
    async installSizes(request) {
      calls.push(request);
      return {
        basis,
        sizes: request.packages
          .filter((p) => Object.hasOwn(map, `${p.name}@${p.version}`))
          .map((p) => ({ ...p, bytes: map[`${p.name}@${p.version}`]! })),
      };
    },
  };
};

// a -> x (two locked versions), b -> nothing sized; c has no closure entry.
const g = graph([node("a"), node("x", "1.0.0"), node("x", "2.0.0"), node("b"), node("c")], {
  a: ["a", "x"],
  b: ["b"],
});
const impact = [entry("a", 1), entry("b", 0), entry("c", null)];

describe("addFootprints (#59 slice B)", () => {
  it("returns entries unchanged without a provider", async () => {
    const out = await addFootprints(impact, [g], undefined);
    assert.deepEqual(out, impact);
    assert.ok(out.every((i) => !("footprint" in i)));
  });

  it("sums the dependency and every locked closure version, with coverage", async () => {
    const provider = sizes({ "a@1.0.0": 100, "x@1.0.0": 10, "x@2.0.0": 20 });
    const out = Object.fromEntries(
      (await addFootprints(impact, [g], provider)).map((i) => [i.name, i]),
    );
    assert.deepEqual(out.a!.footprint, {
      approximate: true,
      basis: "npm unpackedSize",
      bytes: 130,
      coverage: { sized: 3, total: 3 },
    });
    // b is known but nothing about it was sized; c has no closure.
    assert.equal(out.b!.footprint, undefined);
    assert.equal(out.c!.footprint, undefined);
    // Counts are untouched.
    assert.equal(out.a!.transitive, 1);
  });

  it("reports partial coverage as a lower bound", async () => {
    const out = await addFootprints([entry("a", 1)], [g], sizes({ "a@1.0.0": 100 }));
    assert.deepEqual(out[0]!.footprint?.coverage, { sized: 1, total: 3 });
    assert.equal(out[0]!.footprint?.bytes, 100);
  });

  it("asks once per ecosystem with deduplicated, sorted versions", async () => {
    const p2 = project("web");
    const g2 = graph([node("x", "2.0.0"), node("d")], { d: ["d", "x"] }, p2);
    const provider = sizes({});
    await addFootprints([...impact, entry("d", 1, p2)], [g, g2], provider);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(
      provider.calls[0]!.packages.map((p) => `${p.name}@${p.version}`),
      ["a@1.0.0", "b@1.0.0", "d@1.0.0", "x@1.0.0", "x@2.0.0"],
    );
  });

  it("leaves footprint absent when the provider fails, times out or answers badly", async () => {
    const cases: PackageMetadataProvider[] = [
      {
        installSizes: async () => {
          throw new Error("offline");
        },
      },
      {
        installSizes: () => {
          throw new Error("sync");
        },
      },
      { installSizes: () => new Promise(() => {}) },
      { installSizes: async () => undefined },
      {
        installSizes: async () => ({
          basis: "",
          sizes: [{ name: "a", version: "1.0.0", bytes: 1 }],
        }),
      },
      { installSizes: async () => ({ basis: "b", sizes: "nope" as never }) },
      {
        installSizes: async () => ({
          basis: "b",
          sizes: [
            { name: "a", version: "1.0.0", bytes: -1 },
            { name: "a", version: "1.0.0", bytes: 1.5 },
            { name: "a", version: "9.9.9", bytes: 5 },
            { name: "zzz", version: "1.0.0", bytes: 5 },
            null as never,
          ],
        }),
      },
    ];
    for (const provider of cases) {
      const out = await addFootprints(impact, [g], provider, 20);
      assert.ok(out.every((i) => i.footprint === undefined));
    }
  });

  it("skips an ecosystem past the package cap", async () => {
    const many = Array.from({ length: MAX_FOOTPRINT_PACKAGES + 1 }, (_, i) => node(`p${i}`));
    const big = graph([node("a"), ...many], { a: ["a", ...many.map((n) => n.name)] });
    const provider = sizes({ "a@1.0.0": 1 });
    const out = await addFootprints([entry("a", many.length)], [big], provider);
    assert.equal(provider.calls.length, 0);
    assert.equal(out[0]!.footprint, undefined);
  });
});

describe("footprint in the analysis result (#59 slice B)", () => {
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
  const dep = (name: string): Dependency => ({
    name,
    constraint: "^1",
    kind: "runtime",
    project: p,
    declaredIn: "package.json",
  });
  const adapter: EcosystemAdapter = {
    ecosystem: "mock",
    apiVersion: adapterApiVersion,
    capabilities: new Set(["usageAnalysis", "referenceAnalysis", "dependencyGraph"]),
    async detect() {
      return { confidence: 0.9, projects: [p], evidence: [] };
    },
    async listDirectDependencies() {
      return [dep("a"), dep("b")];
    },
    async buildDependencyGraph() {
      return [graph([node("a"), node("x"), node("b")], { a: ["a", "x"], b: ["b"] }, p)];
    },
    async findUsage() {
      return { usages: [], referenceAnalysisComplete: true };
    },
  };

  it("adds footprints from the provider and changes no finding", async () => {
    const without = await analyseRepository(handle, {
      adapters: [adapter],
      recommend: createDefaultPolicy(),
    });
    const withSizes = await analyseRepository(handle, {
      adapters: [adapter],
      recommend: createDefaultPolicy(),
      metadata: sizes({ "a@1.0.0": 7, "x@1.0.0": 3 }, "mock size"),
    });
    assert.deepEqual(
      withSizes.impact?.map((i) => [i.name, i.footprint?.bytes]),
      [
        ["a", 10],
        ["b", undefined],
      ],
    );
    assert.deepEqual(withSizes.findings, without.findings);
    assert.ok(without.impact?.every((i) => i.footprint === undefined));
  });
});
