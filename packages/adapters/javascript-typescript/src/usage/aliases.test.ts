import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryHandle } from "../testing/fs-handle.js";
import { AliasResolver, MAX_CONFIG_BYTES, MAX_EXTENDS_DEPTH, joinPath } from "./aliases.js";

const resolver = (files: Record<string, string>) =>
  new AliasResolver(memoryHandle(files), Object.keys(files));

async function internal(files: Record<string, string>, fromDir: string, spec: string) {
  const r = resolver(files);
  const configFile = r.nearestConfig(fromDir);
  assert.ok(configFile, "expected a config");
  const config = await r.configFor(configFile);
  assert.ok(config);
  return r.isInternal(spec, config);
}

describe("joinPath", () => {
  it("normalises and refuses to escape the root", () => {
    assert.equal(joinPath("a/b", "../c/./d"), "a/c/d");
    assert.equal(joinPath(".", "./src"), "src");
    assert.equal(joinPath("a", "../.."), undefined);
  });
});

describe("AliasResolver", () => {
  const base = {
    "tsconfig.json": `{
      // comments and trailing commas are fine
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@app/*": ["src/*"], "utils": ["src/utils/index.ts"], },
      },
    }`,
    "src/db/client.ts": "",
    "src/utils/index.ts": "",
    "src/lib/log.ts": "",
  };

  it("wildcard and exact paths entries resolving to repo files are internal", async () => {
    assert.equal(await internal(base, "src", "@app/db/client"), true);
    assert.equal(await internal(base, "src", "utils"), true);
  });

  it("baseUrl-relative bare specifiers resolving to repo files are internal", async () => {
    assert.equal(await internal(base, "src", "src/lib/log"), true);
  });

  it("an alias whose target does not exist does not hide package usage", async () => {
    assert.equal(await internal(base, "src", "@app/missing"), false);
    assert.equal(await internal(base, "src", "lodash"), false);
  });

  it("a catch-all node_modules fallback never marks packages internal", async () => {
    const files = {
      "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"*":["types/*","node_modules/*"]}}}`,
      "types/legacy.d.ts": "",
      "node_modules/react/index.js": "",
    };
    assert.equal(await internal(files, ".", "react"), false);
    assert.equal(await internal(files, ".", "legacy"), true);
  });

  it("paths without baseUrl resolve relative to the config that defines them", async () => {
    const files = {
      "packages/web/tsconfig.json": `{"compilerOptions":{"paths":{"~ui/*":["./ui/*"]}}}`,
      "packages/web/ui/button.tsx": "",
    };
    assert.equal(await internal(files, "packages/web/src", "~ui/button"), true);
  });

  it("follows relative extends (with or without .json); nearest config wins", async () => {
    const files = {
      "tsconfig.base.json": `{"compilerOptions":{"baseUrl":".","paths":{"@shared/*":["shared/*"]}}}`,
      "shared/x.ts": "",
      "apps/a/tsconfig.json": `{"extends":"../../tsconfig.base","compilerOptions":{}}`,
      "apps/b/tsconfig.json": `{"extends":["@tsconfig/node20/tsconfig.json","../../tsconfig.base.json"],"compilerOptions":{"paths":{"@b/*":["./src/*"]}}}`,
      "apps/b/src/y.ts": "",
    };
    assert.equal(await internal(files, "apps/a", "@shared/x"), true);
    // b's own paths replace the base's (TS semantics), and resolve against the base's baseUrl.
    assert.equal(await internal(files, "apps/b", "@shared/x"), false);
    assert.equal(await internal(files, "apps/b", "@b/y"), false);
    assert.equal(await internal(files, "apps/b", "apps/b/src/y"), true);
  });

  it("merges every local base in an extends array, later entries per option (#862)", async () => {
    // base.json sets baseUrl "."; config/paths.json sets paths pkg -> src/pkg.ts.
    // Real TS 5.9.3 merges both bases: the substitution resolves against the
    // merged root baseUrl, not against config/.
    const files = {
      "tsconfig.json": `{"extends":["./base.json","./config/paths.json"],"compilerOptions":{}}`,
      "base.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "config/paths.json": `{"compilerOptions":{"paths":{"pkg":["src/pkg.ts"]}}}`,
      "config/src/pkg.ts": "",
      "node_modules/pkg/index.js": "",
    };
    // src/pkg.ts does not exist at the root baseUrl, so pkg stays a package.
    assert.equal(await internal(files, ".", "pkg"), false);
    // With the target at the root baseUrl the merged alias does apply.
    assert.equal(await internal({ ...files, "src/pkg.ts": "" }, ".", "pkg"), true);
  });

  it("merges a shared base reached through a diamond of extends (#862)", async () => {
    const files = {
      "tsconfig.json": `{"extends":["./b.json","./c.json"],"compilerOptions":{}}`,
      "b.json": `{"extends":"./d.json"}`,
      "c.json": `{"extends":"./d.json","compilerOptions":{"paths":{"@c/*":["src/*"]}}}`,
      "d.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "src/x.ts": "",
      "lib/y.ts": "",
    };
    // c's paths resolve against d's baseUrl, inherited through both arms.
    assert.equal(await internal(files, ".", "@c/x"), true);
    assert.equal(await internal(files, ".", "lib/y"), true);
  });

  it("a shared base repeated across many arms counts once (#862)", async () => {
    // 17 arms each extending shared.json, then last.json with baseUrl: 19
    // distinct bases, so nothing is capped. Real tsc 5.9.3 retains last's
    // baseUrl and resolves pkg internally.
    const files: Record<string, string> = {
      "tsconfig.json": `{"extends":[${Array.from({ length: 17 }, (_, i) => `"./arm${i}.json"`).join(",")},"./last.json"],"compilerOptions":{}}`,
      "shared.json": "{}",
      "last.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "pkg/index.ts": "",
    };
    for (let i = 0; i < 17; i++) files[`arm${i}.json`] = `{"extends":"./shared.json"}`;
    const r = resolver(files);
    const config = await r.configFor("tsconfig.json");
    assert.ok(config);
    assert.equal(r.isInternal("pkg", config), true);
    assert.deepEqual(r.limitations, []);
  });

  it("a cycle beside a repeated shared base keeps the distinct-base cache (#862)", async () => {
    // cycle.json extends itself: the cycle is cut and noted, but the acyclic
    // arms must keep their cache - 20 distinct bases, so nothing is capped.
    const files: Record<string, string> = {
      "tsconfig.json": `{"extends":["./cycle.json",${Array.from({ length: 17 }, (_, i) => `"./arm${i}.json"`).join(",")},"./last.json"],"compilerOptions":{}}`,
      "cycle.json": `{"extends":"./cycle.json"}`,
      "shared.json": "{}",
      "last.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "pkg/index.ts": "",
    };
    for (let i = 0; i < 17; i++) files[`arm${i}.json`] = `{"extends":"./shared.json"}`;
    const r = resolver(files);
    const config = await r.configFor("tsconfig.json");
    assert.ok(config);
    assert.equal(r.isInternal("pkg", config), true);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [["tsconfig-extends-cycle", "tsconfig.json"]],
    );
  });

  it("a cycle below a shared base does not leak across paths (#862)", async () => {
    // b3 <-> b4: b4's merged baseUrl depends on the path taken, so no merge
    // whose subtree touched the cycle may be cached. An uncached active-stack
    // traversal ends with baseUrl d1 from the root's last base b2.
    const files: Record<string, string> = {
      "tsconfig.json": `{"extends":["./b0.json","./b1.json","./b2.json"],"compilerOptions":{}}`,
      "b0.json": `{"extends":["./b1.json","./b2.json"]}`,
      "b1.json": `{"extends":"./b4.json","compilerOptions":{"baseUrl":"d1"}}`,
      "b2.json": `{"extends":["./b3.json","./b0.json"]}`,
      "b3.json": `{"extends":"./b4.json","compilerOptions":{"baseUrl":"d3"}}`,
      "b4.json": `{"extends":"./b3.json"}`,
    };
    const r = resolver(files);
    const config = await r.configFor("tsconfig.json");
    assert.ok(config);
    assert.equal(config.baseUrl, "d1");
    assert.ok(r.limitations.some((e) => e.kind === "tsconfig-extends-cycle"));
  });

  it("a base reached deep then shallow is not served a depth-truncated cache (#862)", async () => {
    // b0->...->b6->shared reaches shared at the depth cap, where its own base
    // last is cut; the direct root->shared visit must still merge last.
    const files: Record<string, string> = {
      "tsconfig.json": `{"extends":["./b0.json","./shared.json"],"compilerOptions":{}}`,
      "shared.json": `{"extends":"./last.json"}`,
      "last.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "pkg/index.ts": "",
    };
    for (let i = 0; i < 7; i++)
      files[`b${i}.json`] = `{"extends":"./${i === 6 ? "shared" : `b${i + 1}`}.json"}`;
    const r = resolver(files);
    const config = await r.configFor("tsconfig.json");
    assert.ok(config);
    assert.equal(r.isInternal("pkg", config), true);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [["tsconfig-extends-too-deep", "tsconfig.json"]],
    );
  });

  it("bounds extends branching: too many bases fail closed with a limitation (#862)", async () => {
    const files: Record<string, string> = {
      "tsconfig.json": `{"extends":[${Array.from({ length: 33 }, (_, i) => `"./b${i}.json"`).join(",")}],"compilerOptions":{}}`,
      "pkg/index.ts": "",
    };
    for (let i = 0; i < 33; i++)
      files[`b${i}.json`] = i === 32 ? `{"compilerOptions":{"baseUrl":"."}}` : "{}";
    const r = resolver(files);
    const config = await r.configFor("tsconfig.json");
    assert.ok(config);
    // The 33rd base carries baseUrl: past the breadth cap it is not read, so
    // pkg is not internal and the run records the exhaustion.
    assert.equal(r.isInternal("pkg", config), false);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [["tsconfig-extends-too-broad", "tsconfig.json"]],
    );
  });

  it("cached extends merges match an uncached reference on random small graphs (#862)", async () => {
    // Deterministic PRNG: a failure prints its graph and reproduces exactly.
    const mulberry32 = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    interface Node {
      extends: string[];
      baseUrl?: string;
    }
    // The uncached active-stack traversal every cached run must agree with.
    // Entries are "./"-relative to root-level files, like the fixtures.
    const reference = (
      graph: Record<string, Node>,
      file: string,
      stack: readonly string[],
    ): string | undefined => {
      if (stack.includes(file)) return undefined;
      if (stack.length > MAX_EXTENDS_DEPTH) return undefined;
      const node = graph[file];
      if (!node) return undefined;
      let merged: string | undefined;
      for (const base of node.extends) {
        const b = reference(graph, base.slice(2), [...stack, file]);
        if (b !== undefined) merged = b;
      }
      if (node.baseUrl !== undefined) merged = node.baseUrl;
      return merged;
    };
    const rand = mulberry32(862);
    for (let g = 0; g < 1000; g++) {
      const graph: Record<string, Node> = {};
      const files: Record<string, string> = {};
      const emit = (name: string, bases: string[], baseUrl?: string) => {
        const node: Node = { extends: bases };
        if (baseUrl !== undefined) node.baseUrl = baseUrl;
        graph[name] = node;
        files[name] = JSON.stringify({
          ...(bases.length ? { extends: bases } : {}),
          ...(baseUrl !== undefined ? { compilerOptions: { baseUrl } } : {}),
        });
      };
      if (rand() < 0.5) {
        // Chain mode: a spine longer than MAX_EXTENDS_DEPTH plus random
        // cross-links, so some visits hit the depth cap and others do not.
        const m = 9 + Math.floor(rand() * 5); // 9..13 nodes
        const cnames = Array.from({ length: m }, (_, i) => `c${i}.json`);
        const cpick = (): string => `./${cnames[Math.floor(rand() * m)]!}`;
        for (let i = 0; i < m; i++) {
          const bases: string[] = [];
          if (i + 1 < m) bases.push(`./c${i + 1}.json`);
          if (rand() < 0.4) bases.push(cpick());
          emit(cnames[i]!, bases, rand() < 0.5 ? `d-c${i}` : undefined);
        }
        const roots = [`./${cnames[0]!}`];
        if (rand() < 0.6) roots.push(cpick()); // shallow revisit of a chain node
        emit("tsconfig.json", roots, rand() < 0.3 ? "d-root" : undefined);
      } else {
        const count = 2 + Math.floor(rand() * 6); // 2..7 bases, caps never trip
        const names = Array.from({ length: count }, (_, i) => `n${i}.json`);
        const pick = (): string =>
          rand() < 0.15 ? "./missing.json" : `./${names[Math.floor(rand() * count)]!}`;
        for (const name of [...names, "tsconfig.json"]) {
          emit(
            name,
            Array.from({ length: Math.floor(rand() * 4) }, pick),
            rand() < 0.5 ? `d-${name}` : undefined,
          );
        }
      }
      const expected = reference(graph, "tsconfig.json", []);
      const r = resolver(files);
      const config = await r.configFor("tsconfig.json");
      assert.equal(config?.baseUrl, expected, `graph ${g}: ${JSON.stringify(graph)}`);
    }
  });

  it("follows extends into a workspace package (#145): subpath, bare name, tsconfig field", async () => {
    const files = {
      "package.json": `{"name":"root","private":true}`,
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/base.json": `{"compilerOptions":{"baseUrl":".","paths":{"@ui/*":["../ui/src/*"]}}}`,
      "packages/tsconfig/tsconfig.json": `{"compilerOptions":{"paths":{"@bare/*":["../ui/src/*"]}}}`,
      "packages/fielded/package.json": `{"name":"fielded","tsconfig":"conf/main.json"}`,
      "packages/fielded/conf/main.json": `{"compilerOptions":{"paths":{"@f/*":["../../ui/src/*"]}}}`,
      "packages/ui/package.json": `{"name":"ui"}`,
      "packages/ui/src/button.ts": "",
      "apps/sub/tsconfig.json": `{"extends":"@repo/typescript-config/base.json"}`,
      "apps/noext/tsconfig.json": `{"extends":"@repo/typescript-config/base"}`,
      "apps/bare/tsconfig.json": `{"extends":"@repo/typescript-config"}`,
      "apps/field/tsconfig.json": `{"extends":"fielded"}`,
    };
    assert.equal(await internal(files, "apps/sub", "@ui/button"), true);
    assert.equal(await internal(files, "apps/noext", "@ui/button"), true);
    assert.equal(await internal(files, "apps/bare", "@bare/button"), true);
    assert.equal(await internal(files, "apps/field", "@f/button"), true);
    const r = resolver(files);
    await r.configFor("apps/sub/tsconfig.json");
    assert.deepEqual(r.limitations, []);
  });

  it("a workspace package without the named file is a limitation; node_modules bases stay silent", async () => {
    const files = {
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/other.json": "{}",
      "apps/a/tsconfig.json": `{"extends":"@repo/typescript-config/missing.json"}`,
      "apps/b/tsconfig.json": `{"extends":"@tsconfig/node20/tsconfig.json"}`,
      "apps/c/tsconfig.json": `{"extends":"@repo/typescript-config/../../apps/b/tsconfig.json"}`,
    };
    const r = resolver(files);
    for (const f of ["apps/a/tsconfig.json", "apps/b/tsconfig.json", "apps/c/tsconfig.json"])
      await r.configFor(f);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [
        ["tsconfig-extends-unresolved", "apps/a/tsconfig.json"],
        ["tsconfig-extends-unresolved", "apps/c/tsconfig.json"],
      ],
    );
  });

  it("two packages with the same name are ambiguous: not followed, a limitation", async () => {
    const files = {
      "fixtures/copy/package.json": `{"name":"@repo/typescript-config"}`,
      "fixtures/copy/base.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/base.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "apps/a/tsconfig.json": `{"extends":"@repo/typescript-config/base.json"}`,
    };
    const r = resolver(files);
    const config = await r.configFor("apps/a/tsconfig.json");
    assert.equal(config?.baseUrl, undefined);
    assert.deepEqual(
      r.limitations.map((e) => [e.kind, e.file]),
      [["tsconfig-extends-ambiguous", "apps/a/tsconfig.json"]],
    );
    assert.deepEqual([...r.packageBases], []);
  });

  it("records node_modules extends bases for the run note, never as limitations", async () => {
    const files = {
      "packages/tsconfig/package.json": `{"name":"@repo/typescript-config"}`,
      "packages/tsconfig/base.json": "{}",
      "tsconfig.base.json": "{}",
      "apps/a/tsconfig.json": `{"extends":["@tsconfig/node20/tsconfig.json","@repo/typescript-config/base.json"]}`,
      "apps/b/tsconfig.json": `{"extends":["fastify-tsconfig","../../tsconfig.base.json"]}`,
      "apps/c/tsconfig.json": `{"extends":"../../node_modules/@tsconfig/strictest/tsconfig.json"}`,
    };
    const r = resolver(files);
    for (const f of ["apps/a/tsconfig.json", "apps/b/tsconfig.json", "apps/c/tsconfig.json"])
      await r.configFor(f);
    assert.deepEqual([...r.packageBases].sort(), [
      "@tsconfig/node20",
      "@tsconfig/strictest",
      "fastify-tsconfig",
    ]);
    assert.deepEqual(r.limitations, []);
  });

  it("memoises isInternal per config and specifier (#145)", async () => {
    const files = {
      "tsconfig.json": `{"compilerOptions":{"baseUrl":"."}}`,
      "src/a.ts": "",
    };
    const r = resolver(files);
    const config = (await r.configFor("tsconfig.json"))!;
    assert.equal(r.isInternal("src/a", config), true);
    // A later file-set change can't be seen, which proves the answer is cached.
    (r as unknown as { files: Set<string> }).files.delete("src/a.ts");
    assert.equal(r.isInternal("src/a", config), true);
    assert.equal(r.isInternal("src/b", config), false);
  });

  it("extends cycles and oversize or malformed configs become limitations, never throws", async () => {
    const files = {
      "a/tsconfig.json": `{"extends":"../b/tsconfig.json"}`,
      "b/tsconfig.json": `{"extends":"../a/tsconfig.json"}`,
      "big/tsconfig.json": " ".repeat(MAX_CONFIG_BYTES + 1),
      "bad/tsconfig.json": `{"compilerOptions": `,
    };
    const r = resolver(files);
    for (const f of ["a/tsconfig.json", "big/tsconfig.json", "bad/tsconfig.json"]) {
      await r.configFor(f);
    }
    const kinds = r.limitations.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["tsconfig-extends-cycle", "tsconfig-malformed", "tsconfig-too-large"]);
  });

  it("uses own keys only: prototype-named keys never match or pollute", async () => {
    const files = {
      "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"__proto__":{"polluted":true},"constructor":["nope/*"]}}}`,
      "src/p.ts": "",
    };
    assert.equal(await internal(files, ".", "constructor"), false);
    assert.equal(await internal(files, ".", "toString"), false);
    assert.equal(await internal(files, ".", "__proto__"), false);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("jsconfig.json is honoured and nearestConfig stops at the project root", () => {
    const r = resolver({ "jsconfig.json": "{}", "pkg/src/a.js": "" });
    assert.equal(r.nearestConfig("pkg/src"), "jsconfig.json");
    assert.equal(r.nearestConfig("pkg/src", "pkg"), undefined);
  });
});

describe("AliasResolver node_modules extends (#276)", () => {
  it("reads an installed base package: tsconfig field, paths merging, no run note", async () => {
    const files = {
      "node_modules/@tsconfig/node20/package.json": `{"name":"@tsconfig/node20","tsconfig":"tsconfig.json"}`,
      "node_modules/@tsconfig/node20/tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"@base/*":["../../../src/base/*"]}}}`,
      "src/base/util.ts": "",
      "tsconfig.json": `{"extends":"@tsconfig/node20","compilerOptions":{}}`,
    };
    assert.equal(await internal(files, ".", "@base/util"), true);
    const r = resolver(files);
    await r.configFor("tsconfig.json");
    assert.deepEqual([...r.packageBases], []);
    assert.deepEqual(r.limitations, []);
  });

  it("resolves exports subpaths, exact and single-star", async () => {
    const files = {
      "node_modules/expo/package.json": `{"name":"expo","exports":{"./tsconfig.base":"./tsconfig.base.json","./bases/*":"./configs/*.json"}}`,
      "node_modules/expo/tsconfig.base.json": `{"compilerOptions":{"paths":{"@expo/*":["../../src/e/*"]}}}`,
      "node_modules/expo/configs/strict.json": `{"compilerOptions":{"paths":{"@strict/*":["../../../src/s/*"]}}}`,
      "src/e/a.ts": "",
      "src/s/b.ts": "",
      "apps/a/tsconfig.json": `{"extends":"expo/tsconfig.base"}`,
      "apps/b/tsconfig.json": `{"extends":"expo/bases/strict"}`,
    };
    assert.equal(await internal(files, "apps/a", "@expo/a"), true);
    assert.equal(await internal(files, "apps/b", "@strict/b"), true);
    const r = resolver(files);
    await r.configFor("apps/a/tsconfig.json");
    await r.configFor("apps/b/tsconfig.json");
    assert.deepEqual([...r.packageBases], []);
  });

  it("exports encapsulation is final: an unexported base is not read", async () => {
    const files = {
      "node_modules/expo/package.json": `{"name":"expo","exports":{"./public":"./public.json"}}`,
      "node_modules/expo/public.json": `{"compilerOptions":{"paths":{"@pub/*":["../../src/p/*"]}}}`,
      "node_modules/expo/internal.json": `{"compilerOptions":{"paths":{"@hidden/*":["../../src/h/*"]}}}`,
      "src/h/secret.ts": "",
      "tsconfig.json": `{"extends":"expo/internal"}`,
    };
    // TypeScript would error on this extends; the base must not be read, so
    // its alias cannot mark the import internal.
    assert.equal(await internal(files, ".", "@hidden/secret"), false);
    const r = resolver(files);
    await r.configFor("tsconfig.json");
    assert.deepEqual([...r.packageBases], ["expo"]);
  });

  it("a bare name resolves <name>.json before the directory tsconfig.json", async () => {
    const files = {
      "node_modules/pkg.json": `{"compilerOptions":{"paths":{"@file/*":["../src/f/*"]}}}`,
      "node_modules/pkg/package.json": `{"name":"pkg"}`,
      "node_modules/pkg/tsconfig.json": `{"compilerOptions":{"paths":{"@dir/*":["../src/d/*"]}}}`,
      "src/f/a.ts": "",
      "src/d/b.ts": "",
      "tsconfig.json": `{"extends":"pkg"}`,
    };
    assert.equal(await internal(files, ".", "@file/a"), true);
    assert.equal(await internal(files, ".", "@dir/b"), false);
  });

  it("a config in a nested app resolves a base installed at the root", async () => {
    const files = {
      "node_modules/fastify-tsconfig/tsconfig.json": `{"compilerOptions":{"paths":{"@root/*":["../../src/*"]}}}`,
      "src/lib/x.ts": "",
      "apps/web/tsconfig.json": `{"extends":"fastify-tsconfig"}`,
    };
    assert.equal(await internal(files, "apps/web", "@root/lib/x"), true);
    const r = resolver(files);
    await r.configFor("apps/web/tsconfig.json");
    assert.deepEqual([...r.packageBases], []);
  });

  it("a relative extends into node_modules is read when the file is listed", async () => {
    const files = {
      "node_modules/@tsconfig/strictest/tsconfig.json": `{"compilerOptions":{"paths":{"@st/*":["../../../src/st/*"]}}}`,
      "src/st/y.ts": "",
      "apps/c/tsconfig.json": `{"extends":"../../node_modules/@tsconfig/strictest/tsconfig.json"}`,
    };
    assert.equal(await internal(files, "apps/c", "@st/y"), true);
    const r = resolver(files);
    await r.configFor("apps/c/tsconfig.json");
    assert.deepEqual([...r.packageBases], []);
  });

  it("an installed base's alias targets inside node_modules still never mark packages internal", async () => {
    const files = {
      "node_modules/base/tsconfig.json": `{"compilerOptions":{"baseUrl":"..","paths":{"*":["node_modules/*"]}}}`,
      "node_modules/base/package.json": `{"name":"base"}`,
      "node_modules/react/index.js": "",
      "tsconfig.json": `{"extends":"base"}`,
    };
    assert.equal(await internal(files, ".", "react"), false);
  });

  it("a base package absent from node_modules keeps the run note", async () => {
    const files = {
      "node_modules/other/package.json": `{"name":"other"}`,
      "node_modules/other/tsconfig.json": "{}",
      "tsconfig.json": `{"extends":"@tsconfig/node20/tsconfig.json"}`,
    };
    const r = resolver(files);
    await r.configFor("tsconfig.json");
    assert.deepEqual([...r.packageBases], ["@tsconfig/node20"]);
  });

  it("a chained base inside node_modules can itself extend", async () => {
    const files = {
      "node_modules/outer/package.json": `{"name":"outer"}`,
      "node_modules/outer/tsconfig.json": `{"extends":"../inner/base.json","compilerOptions":{"paths":{"@o/*":["../../src/o/*"]}}}`,
      "node_modules/inner/base.json": `{"compilerOptions":{"paths":{"@i/*":["../../src/i/*"]}}}`,
      "src/o/a.ts": "",
      "src/i/b.ts": "",
      "tsconfig.json": `{"extends":"outer"}`,
    };
    assert.equal(await internal(files, ".", "@o/a"), true);
    // paths are inherited but never merged: the nearer config's paths win.
    assert.equal(await internal(files, ".", "@i/b"), false);
  });
});

describe("AliasResolver node_modules exports forms (#553 review)", () => {
  it("a root string export covers the bare name, and no subpath", async () => {
    const files = {
      "node_modules/pkgroot/package.json": `{"name":"pkgroot","exports":"./base.json"}`,
      "node_modules/pkgroot/base.json": `{"compilerOptions":{"paths":{"@rs/*":["../../src/rs/*"]}}}`,
      "node_modules/pkgroot/other.json": `{"compilerOptions":{"paths":{"@ro/*":["../../src/ro/*"]}}}`,
      "src/rs/a.ts": "",
      "src/ro/b.ts": "",
      "apps/a/tsconfig.json": `{"extends":"pkgroot"}`,
      "apps/b/tsconfig.json": `{"extends":"pkgroot/other"}`,
    };
    assert.equal(await internal(files, "apps/a", "@rs/a"), true);
    // A root string export exports nothing but ".": the subpath base is unread.
    assert.equal(await internal(files, "apps/b", "@ro/b"), false);
    const r = resolver(files);
    await r.configFor("apps/a/tsconfig.json");
    await r.configFor("apps/b/tsconfig.json");
    assert.deepEqual([...r.packageBases], ["pkgroot"]);
  });

  it("conditional exports resolve in object order over TypeScript's conditions", async () => {
    const files = {
      "node_modules/pkgcond/package.json": `{"name":"pkgcond","exports":{
        ".": {"types":"./t.json","default":"./d.json"},
        "./ord": {"default":"./od.json","types":"./ot.json"},
        "./mod": {"import":"./i.json","require":"./r.json"},
        "./web": {"browser":"./b.json","default":"./wd.json"},
        "./sub": {"node":"./n.json","default":"./sd.json"}
      }}`,
      "node_modules/pkgcond/t.json": `{"compilerOptions":{"paths":{"@t/*":["../../src/t/*"]}}}`,
      "node_modules/pkgcond/d.json": `{"compilerOptions":{"paths":{"@d/*":["../../src/d/*"]}}}`,
      "node_modules/pkgcond/od.json": `{"compilerOptions":{"paths":{"@od/*":["../../src/od/*"]}}}`,
      "node_modules/pkgcond/ot.json": `{"compilerOptions":{"paths":{"@ot/*":["../../src/ot/*"]}}}`,
      "node_modules/pkgcond/i.json": `{"compilerOptions":{"paths":{"@i/*":["../../src/i/*"]}}}`,
      "node_modules/pkgcond/r.json": `{"compilerOptions":{"paths":{"@r/*":["../../src/r/*"]}}}`,
      "node_modules/pkgcond/b.json": `{"compilerOptions":{"paths":{"@b/*":["../../src/b/*"]}}}`,
      "node_modules/pkgcond/wd.json": `{"compilerOptions":{"paths":{"@wd/*":["../../src/wd/*"]}}}`,
      "node_modules/pkgcond/n.json": `{"compilerOptions":{"paths":{"@n/*":["../../src/n/*"]}}}`,
      "node_modules/pkgcond/sd.json": `{"compilerOptions":{"paths":{"@sd/*":["../../src/sd/*"]}}}`,
      "src/t/a.ts": "",
      "src/od/a.ts": "",
      "src/r/a.ts": "",
      "src/wd/a.ts": "",
      "src/n/a.ts": "",
      "apps/t/tsconfig.json": `{"extends":"pkgcond"}`,
      "apps/ord/tsconfig.json": `{"extends":"pkgcond/ord"}`,
      "apps/mod/tsconfig.json": `{"extends":"pkgcond/mod"}`,
      "apps/web/tsconfig.json": `{"extends":"pkgcond/web"}`,
      "apps/sub/tsconfig.json": `{"extends":"pkgcond/sub"}`,
    };
    // All shapes match TypeScript 5.9.3 on the same synthetic packages.
    assert.equal(await internal(files, "apps/t", "@t/a"), true, "types first wins over default");
    assert.equal(await internal(files, "apps/ord", "@od/a"), true, "default listed first wins");
    assert.equal(await internal(files, "apps/mod", "@r/a"), true, "require beats import");
    assert.equal(await internal(files, "apps/web", "@wd/a"), true, "browser is skipped");
    assert.equal(await internal(files, "apps/sub", "@n/a"), true, "node first wins over default");
    const r = resolver(files);
    for (const c of ["t", "ord", "mod", "web", "sub"]) await r.configFor(`apps/${c}/tsconfig.json`);
    assert.deepEqual([...r.packageBases], []);
  });

  it("a conditional wildcard target substitutes the capture", async () => {
    const files = {
      "node_modules/w/package.json": `{"name":"w","exports":{"./c/*":{"default":"./w/*.json"}}}`,
      "node_modules/w/w/deep.json": `{"compilerOptions":{"paths":{"@cw/*":["../../../src/cw/*"]}}}`,
      "src/cw/a.ts": "",
      "tsconfig.json": `{"extends":"w/c/deep"}`,
    };
    assert.equal(await internal(files, ".", "@cw/a"), true);
  });

  it("resolution memoisation stops at the cap: the 1,001st base is not read", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1001; i++) {
      files[`node_modules/pkg${i}/tsconfig.json`] =
        `{"compilerOptions":{"paths":{"@p${i}/*":["../../src/p${i}/*"]}}}`;
      files[`src/p${i}/a.ts`] = "";
      files[`cfg${i}/tsconfig.json`] = `{"extends":"pkg${i}"}`;
    }
    const r = resolver(files);
    const configs: Awaited<ReturnType<typeof r.configFor>>[] = [];
    for (let i = 0; i < 1001; i++) configs.push(await r.configFor(`cfg${i}/tsconfig.json`));
    assert.equal(r.isInternal("@p0/a", configs[0]!), true);
    assert.equal(r.isInternal("@p1000/a", configs[1000]!), false);
    assert.deepEqual([...r.packageBases], ["pkg1000"]);
  });
});
