import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseUsageResult, runAdapterContractTests } from "@ghostdeps/core";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "./adapter.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

const ctx = (name: string): AdapterContext => ({
  repository: fixtureHandle("js", name),
  network: { mode: "offline" },
});
const root: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };

describe("createJavaScriptTypeScriptAdapter wiring", () => {
  const adapter = createJavaScriptTypeScriptAdapter();

  it("declares dependencyGraph, usageAnalysis and referenceAnalysis, and implements them", () => {
    assert.deepEqual([...adapter.capabilities].sort(), [
      "dependencyGraph",
      "referenceAnalysis",
      "usageAnalysis",
    ]);
    assert.equal(typeof adapter.buildDependencyGraph, "function");
    assert.equal(typeof adapter.findUsage, "function");
  });

  it("buildDependencyGraph returns one graph per project from the lockfile", async () => {
    const graphs = await adapter.buildDependencyGraph!(ctx("lockfile-npm-v3"), [root]);
    assert.equal(graphs.length, 1);
    assert.ok(graphs[0]!.nodes.length > 0);
  });

  it("findUsage finds evidence through the adapter", async () => {
    const axios: Dependency = {
      name: "axios",
      constraint: "*",
      kind: "runtime",
      project: root,
      declaredIn: "package.json",
    };
    const { usages } = normaliseUsageResult(
      await adapter.findUsage!(ctx("usage-static-and-require"), axios),
    );
    assert.ok(usages.length > 0);
    assert.ok(usages.every((u) => u.file.length > 0 && u.line > 0));
  });
});

runAdapterContractTests(createJavaScriptTypeScriptAdapter(), ctx("lockfile-npm-v3"));
runAdapterContractTests(createJavaScriptTypeScriptAdapter(), ctx("usage-static-and-require"));

describe("reference analysis completeness (#132)", () => {
  const adapter = createJavaScriptTypeScriptAdapter();
  const dev = (name: string): Dependency => ({
    name,
    constraint: "*",
    kind: "dev",
    project: root,
    declaredIn: "package.json",
  });
  const report = async (fixture: string, name: string) =>
    normaliseUsageResult(await adapter.findUsage!(ctx(fixture), dev(name)));

  it("script-only dependency: via=script usage, analysis complete", async () => {
    const r = await report("refs-script-only", "typescript");
    assert.deepEqual(
      r.usages.map((u) => [u.via, u.file, u.symbols]),
      [["script", "package.json", ["tsc"]]],
    );
    assert.equal(r.referenceAnalysisComplete, true);
  });

  it("config-only dependencies: via=config usage, analysis complete", async () => {
    for (const [name, file] of [
      ["eslint-plugin-import", ".eslintrc.json"],
      ["@types/node", "tsconfig.json"],
    ] as const) {
      const r = await report("refs-config-only", name);
      assert.deepEqual(
        r.usages.map((u) => [u.via, u.file]),
        [["config", file]],
        name,
      );
      assert.equal(r.referenceAnalysisComplete, true, name);
    }
  });

  it("no evidence anywhere: no usage and complete, so the policy may say unused", async () => {
    const r = await report("basic-unused", "left-pad");
    assert.deepEqual(r.usages, []);
    assert.equal(r.referenceAnalysisComplete, true);
  });

  it("partial scans are never complete", async () => {
    // Non-literal dynamic import in the source scan.
    assert.equal((await report("usage-dynamic", "plugin-a")).referenceAnalysisComplete, false);
    // A JS config that imports a local module whose strings are not read.
    const js = await report("refs-partial-js-config", "eslint-plugin-foo");
    assert.deepEqual(js.usages, []);
    assert.equal(js.referenceAnalysisComplete, false);
  });

  it("JS configs read statically credit string-named plugins and stay complete (#149)", async () => {
    for (const name of ["eslint-config-airbnb", "eslint-plugin-react", "@babel/preset-env"]) {
      const r = await report("refs-static-js-config", name);
      assert.ok(
        r.usages.some((u) => u.via === "config"),
        JSON.stringify(r.usages),
      );
      assert.equal(r.referenceAnalysisComplete, true);
    }
    const unused = await report("refs-static-js-config", "left-pad");
    assert.deepEqual(unused.usages, []);
    assert.equal(unused.referenceAnalysisComplete, true);
  });

  it("a config importing a shared config package is complete only with a lockfile (#201 review)", async () => {
    const none = await report("refs-shared-config-no-lockfile", "globals");
    assert.deepEqual(none.usages, []);
    assert.equal(none.referenceAnalysisComplete, false);
    const locked = await report("refs-shared-config-lockfile", "globals");
    assert.deepEqual(locked.usages, []);
    assert.equal(locked.referenceAnalysisComplete, true);
    // yarn.lock records no peer edges: still incomplete.
    const yarn = await report("refs-shared-config-yarn-classic", "globals");
    assert.equal(yarn.referenceAnalysisComplete, false);
  });

  it("tsdown.config.ts credits unrun, the config loader tsdown falls back to", async () => {
    const r = await report("convention-tsdown-unrun", "unrun");
    assert.ok(
      r.usages.some((u) => u.via === "convention" && u.file === "tsdown.config.ts"),
      JSON.stringify(r.usages),
    );
  });

  it("pnpm: a script bin whose name differs from its package is a gap, never complete", async () => {
    const r = await report("refs-pnpm-bin-mismatch", "npm-check-updates");
    assert.equal(r.referenceAnalysisComplete, false);
  });
});

describe("real-repo import regressions (vite hand-check after #176)", () => {
  const adapter = createJavaScriptTypeScriptAdapter();
  const dep = (name: string): Dependency => ({
    name,
    constraint: "*",
    kind: "runtime",
    project: root,
    declaredIn: "package.json",
  });
  const cases = [
    ["refs-html-module-script", "vuex", "index.html"],
    ["refs-html-module-script", "normalize.css", "index.html"],
    ["refs-vue-sfc", "@iconify/vue", "src/Community.vue"],
    ["refs-root-dep-from-member", "execa", "packages/create-app/__tests__/cli.spec.ts"],
    ["refs-create-require", "core-js", "src/index.ts"],
    ["refs-create-require", "@types/pnpapi", "src/index.ts"],
  ] as const;
  for (const [fixture, name, file] of cases) {
    it(`${fixture}: ${name} has import usage in ${file} and the analysis is complete`, async () => {
      const r = normaliseUsageResult(await adapter.findUsage!(ctx(fixture), dep(name)));
      assert.ok(
        r.usages.some((u) => u.file === file),
        JSON.stringify(r.usages),
      );
      assert.equal(r.referenceAnalysisComplete, true);
    });
  }
});

describe("real-repo coverage regressions (validation pass after #164)", () => {
  const adapter = createJavaScriptTypeScriptAdapter();
  const dev = (name: string): Dependency => ({
    name,
    constraint: "*",
    kind: "dev",
    project: root,
    declaredIn: "package.json",
  });
  const cases = [
    ["refs-concurrently-args", "autocannon", "script"],
    ["refs-script-flag-value", "@jsumners/line-reporter", "script"],
    ["refs-script-flag-value", "tsx", "script"],
    ["refs-nested-tsconfig", "fastify-tsconfig", "config"],
    ["refs-workflow-only", "publint", "script"],
    ["convention-simple-git-hooks-key", "simple-git-hooks", "convention"],
    ["convention-size-limit-preset", "@size-limit/preset-small-lib", "convention"],
    ["refs-string-specifier", "regenerator-runtime", "convention"],
    ["refs-string-specifier", "systemjs", "convention"],
    ["convention-css-preprocessor-ext", "sugarss", "convention"],
    ["convention-css-preprocessor-ext", "sass", "convention"],
  ] as const;
  for (const [fixture, name, via] of cases) {
    it(`${fixture}: ${name} has via=${via} usage and the analysis is complete`, async () => {
      const r = normaliseUsageResult(await adapter.findUsage!(ctx(fixture), dev(name)));
      assert.ok(
        r.usages.some((u) => u.via === via),
        JSON.stringify(r.usages),
      );
      assert.equal(r.referenceAnalysisComplete, true);
    });
  }
});

describe("config-string capability notes through the adapter (#205)", () => {
  it("notes only dependencies that a config string alone credited", async () => {
    const adapter = createJavaScriptTypeScriptAdapter();
    const context: AdapterContext = {
      repository: memoryHandle({
        "package.json": JSON.stringify({
          devDependencies: { "string-only": "1", imported: "1", unused: "1" },
        }),
        "vite.config.ts": `export default { include: ["string-only", "imported"] };`,
        "src/index.ts": `import x from "imported";`,
      }),
      network: { mode: "offline" },
    };
    assert.deepEqual(await adapter.notes!(context, [root]), [
      {
        dependency: "string-only",
        statement:
          "credited by a string in vite.config.ts:1; JS/TS config files are read statically for package names, never run",
      },
    ]);
  });
});

describe("findUsage is computed once per dependency per run (#267 review)", () => {
  it("a repeat call does no new reads and returns an independent copy", async () => {
    const adapter = createJavaScriptTypeScriptAdapter();
    let reads = 0;
    const base = memoryHandle({
      "package.json": JSON.stringify({ dependencies: { imported: "1" } }),
      "src/index.ts": `import x from "imported";`,
    });
    const context: AdapterContext = {
      repository: {
        ...base,
        readFile: (path: string) => {
          reads += 1;
          return base.readFile(path);
        },
      },
      network: { mode: "offline" },
    };
    const d: Dependency = {
      name: "imported",
      constraint: "1",
      kind: "runtime",
      project: root,
      declaredIn: "package.json",
    };
    const first = normaliseUsageResult(await adapter.findUsage!(context, d));
    const after = reads;
    const second = normaliseUsageResult(await adapter.findUsage!(context, { ...d }));
    assert.equal(reads, after);
    assert.deepEqual(second, first);
    assert.notEqual(second.usages, first.usages);
  });
});
