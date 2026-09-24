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
import { addFootprints, MAX_FOOTPRINT_PACKAGES, normaliseRegistryOrigin } from "./footprint.js";

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

  it("charges each name at its smallest locked version, with name coverage", async () => {
    const provider = sizes({ "a@1.0.0": 100, "x@1.0.0": 10, "x@2.0.0": 20 });
    const out = Object.fromEntries(
      (await addFootprints(impact, [g], provider)).map((i) => [i.name, i]),
    );
    assert.deepEqual(out.a!.footprint, {
      approximate: true,
      basis: "npm unpackedSize",
      bytes: 110,
      coverage: { sized: 2, total: 2 },
    });
    // b is known but nothing about it was sized; c has no closure.
    assert.equal(out.b!.footprint, undefined);
    assert.equal(out.c!.footprint, undefined);
    // Counts are untouched.
    assert.equal(out.a!.transitive, 1);
  });

  it("reports partial coverage as a lower bound", async () => {
    const out = await addFootprints([entry("a", 1)], [g], sizes({ "a@1.0.0": 100 }));
    assert.deepEqual(out[0]!.footprint?.coverage, { sized: 1, total: 2 });
    assert.equal(out[0]!.footprint?.bytes, 100);
  });

  it("leaves out a name with any unsized locked version", async () => {
    const out = await addFootprints([entry("a", 1)], [g], sizes({ "a@1.0.0": 100, "x@2.0.0": 5 }));
    assert.deepEqual(out[0]!.footprint?.coverage, { sized: 1, total: 2 });
    assert.equal(out[0]!.footprint?.bytes, 100);
  });

  it("never charges a shared member for versions only another dependency pulls in (#288)", async () => {
    // The #283 review repro: a -> c, b -> c, c@1 and c@2 locked.
    const shared = graph([node("a"), node("b"), node("c", "1"), node("c", "2")], {
      a: ["a", "c"],
      b: ["b", "c"],
    });
    const out = await addFootprints(
      [entry("a", 1), entry("b", 1)],
      [shared],
      sizes({ "a@1.0.0": 1, "b@1.0.0": 1, "c@1": 1000, "c@2": 1000 }),
    );
    // Truth for a is at least 1001; never 2001.
    assert.deepEqual(
      out.map((i) => [i.name, i.footprint?.bytes, i.footprint?.coverage]),
      [
        ["a", 1001, { sized: 2, total: 2 }],
        ["b", 1001, { sized: 2, total: 2 }],
      ],
    );
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

describe("registry origin pass-through (#174 step 3)", () => {
  const withOrigin = (name: string, version: string, registryOrigin?: string) => ({
    ...node(name, version),
    ...(registryOrigin === undefined ? {} : { registryOrigin }),
  });
  const ask = async (graphs: DependencyGraph[], entries: DependencyImpact[]) => {
    const provider = sizes({});
    await addFootprints(entries, graphs, provider);
    return provider.calls[0]!.packages;
  };

  it("passes a validated origin and omits it when absent", async () => {
    const g1 = graph(
      [withOrigin("a", "1.0.0", "https://registry.npmjs.org"), withOrigin("x", "1.0.0")],
      { a: ["a", "x"] },
    );
    assert.deepEqual(await ask([g1], [entry("a", 1)]), [
      { name: "a", version: "1.0.0", origin: "https://registry.npmjs.org" },
      { name: "x", version: "1.0.0" },
    ]);
  });

  it("omits the origin when locked nodes disagree or one has none", async () => {
    const p2 = project("web");
    const g1 = graph([withOrigin("a", "1.0.0", "https://registry.npmjs.org")], { a: ["a"] });
    const g2 = graph([withOrigin("a", "1.0.0", "https://npm.acme.example")], { a: ["a"] }, p2);
    const g3 = graph([withOrigin("a", "1.0.0")], { a: ["a"] }, project("api"));
    assert.deepEqual(await ask([g1, g2], [entry("a", 0), entry("a", 0, p2)]), [
      { name: "a", version: "1.0.0" },
    ]);
    assert.deepEqual(await ask([g1, g3], [entry("a", 0)]), [{ name: "a", version: "1.0.0" }]);
  });

  it("accepts only a plain http(s) origin", () => {
    assert.equal(
      normaliseRegistryOrigin("https://registry.npmjs.org"),
      "https://registry.npmjs.org",
    );
    assert.equal(
      normaliseRegistryOrigin("https://registry.npmjs.org/"),
      "https://registry.npmjs.org",
    );
    assert.equal(normaliseRegistryOrigin("http://localhost:4873"), "http://localhost:4873");
    // Scheme and host are case-insensitive; core lowercases them.
    assert.equal(
      normaliseRegistryOrigin("HTTPS://Registry.npmjs.org"),
      "https://registry.npmjs.org",
    );
    for (const bad of [
      undefined,
      "",
      42,
      "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      "https://user:pw@registry.npmjs.org",
      "https://registry.npmjs.org?x=1",
      "https://registry.npmjs.org#x",
      "git+ssh://git@github.com",
      "file:///tmp",
      "registry.npmjs.org",
      `https://${"a".repeat(300)}.example`,
    ]) {
      assert.equal(normaliseRegistryOrigin(bad), undefined, String(bad));
    }
  });
});
