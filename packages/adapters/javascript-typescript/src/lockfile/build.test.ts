import { versionSatisfies } from "./yarn-workspace.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ProjectRef } from "@ghostdeps/core";
import { FIXTURES_ROOT, fixtureHandle, memoryHandle } from "../testing/fs-handle.js";
import { MAX_LOCKFILE_BYTES as CORE_MAX_LOCKFILE_BYTES } from "@ghostdeps/core";
import {
  MAX_LOCKFILE_BYTES,
  MAX_MISMATCH_EVIDENCE,
  buildDependencyGraph,
  buildLockfileGraph,
  lockfileNotes,
} from "./build.js";
import { MAX_NPMRC_BYTES } from "./origin.js";

const project = (p = ".", pm: string[] = []): ProjectRef => ({
  path: p,
  ecosystem: "javascript-typescript",
  packageManagers: pm.map((name) => ({ name })),
});
const ctx = (repository: AdapterContext["repository"]): AdapterContext => ({
  repository,
  network: { mode: "offline" },
});

interface Expected {
  graph: { transitive: Record<string, string[]>; nodes: number; devNodes: number };
}

async function checkFixture(name: string) {
  const expected = JSON.parse(
    await readFile(path.join(FIXTURES_ROOT, "js", name, "expected.json"), "utf8"),
  ) as Expected;
  const res = await buildLockfileGraph(ctx(fixtureHandle("js", name)), project());
  assert.equal(res.graph.incomplete, false);
  assert.deepEqual(res.graph.transitiveClosure, expected.graph.transitive);
  assert.equal(res.graph.nodes.length, expected.graph.nodes);
  assert.equal(res.graph.nodes.filter((n) => n.dev).length, expected.graph.devNodes);
  assert.deepEqual(
    res.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch"),
    [],
  );
  return res;
}

describe("buildLockfileGraph", () => {
  it("fixture js/lockfile-npm-v3: nested copies resolve by node_modules lookup", async () => {
    const res = await checkFixture("lockfile-npm-v3");
    const debugs = res.graph.nodes.filter((n) => n.name === "debug").map((n) => [n.version, n.dev]);
    assert.deepEqual(debugs.sort(), [
      ["2.6.9", true],
      ["4.3.4", false],
    ]);
  });

  for (const format of ["npm", "bun"] as const) {
    it(`${format}: records only an exact direct host's resolved peer edge (#395)`, async () => {
      const pkg = {
        dependencies: { "@vercel/analytics": "1", next: "1", "react-dom": "19" },
      };
      const packages =
        format === "npm"
          ? {
              "": pkg,
              "node_modules/@vercel/analytics": { version: "1.0.0", dependencies: { next: "1" } },
              "node_modules/next": { version: "1.0.0", peerDependencies: { "react-dom": "^19" } },
              "node_modules/react-dom": { version: "19.0.0" },
            }
          : {
              "@vercel/analytics": ["@vercel/analytics@1.0.0", "", { dependencies: { next: "1" } }],
              next: ["next@1.0.0", "", { peerDependencies: { "react-dom": "^19" } }],
              "react-dom": ["react-dom@19.0.0", "", {}],
            };
      const lock =
        format === "npm"
          ? { lockfileVersion: 3, packages }
          : { lockfileVersion: 1, workspaces: { "": { ...pkg, name: "example" } }, packages };
      const res = await buildLockfileGraph(
        ctx(
          memoryHandle({
            "package.json": JSON.stringify(pkg),
            [format === "npm" ? "package-lock.json" : "bun.lock"]: JSON.stringify(lock),
          }),
        ),
        project(),
      );
      assert.equal(res.graph.incomplete, false);
      assert.deepEqual(res.graph.directPeers?.next, ["react-dom"]);
      assert.deepEqual(res.graph.directPeers?.["@vercel/analytics"], []);
      assert.ok(res.graph.transitiveClosure["@vercel/analytics"]?.includes("react-dom"));
    });
  }

  it("unresolved npm peer keeps a direct dependency out of unused without inventing a satisfied edge", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { host: "1", peer: "1" } }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { host: "1", peer: "1" } },
              "node_modules/host": { version: "1.0.0", peerDependencies: { peer: "^2" } },
            },
          }),
        }),
      ),
      project(),
    );
    assert.deepEqual(res.graph.directPeers?.host, []);
    assert.deepEqual(res.graph.unresolvedDirectPeers?.host, ["peer"]);
  });

  it("fixture js/lockfile-pnpm-v9: peer suffixes and npm: aliases resolve", async () => {
    const res = await checkFixture("lockfile-pnpm-v9");
    const reactDom = res.graph.nodes.find((n) => n.name === "react-dom");
    assert.equal(reactDom?.version, "18.2.0");
  });

  it("fixture js/lockfile-yarn-classic: multi-pattern entries and npm: aliases", async () => {
    const res = await checkFixture("lockfile-yarn-classic");
    const chalks = res.graph.nodes.filter((n) => n.name === "chalk").map((n) => n.version);
    assert.deepEqual(chalks.sort(), ["2.4.2", "4.1.2"]);
  });

  it("fixture js/lockfile-yarn-berry: workspace entry gives the direct edges", async () => {
    await checkFixture("lockfile-yarn-berry");
  });

  it("yarn classic: stale lockfile (range not locked) is reported", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { a: "^2.0.0" } }),
          "yarn.lock": 'a@^1.0.0:\n  version "1.0.0"\n',
        }),
      ),
      project(),
    );
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-manifest-mismatch"));
    assert.deepEqual(res.graph.transitiveClosure, {});
  });

  it("fixture js/lockfile-bun: trailing commas and nested copies under scoped packages", async () => {
    const res = await checkFixture("lockfile-bun");
    const ms = res.graph.nodes.filter((n) => n.name === "ms").map((n) => n.version);
    assert.deepEqual(ms.sort(), ["2.0.0", "2.1.2"]);
  });

  it("bun.lockb alone is reported as unsupported, not parsed", async () => {
    const res = await buildLockfileGraph(
      ctx(memoryHandle({ "package.json": "{}", "bun.lockb": "\u0000binary" })),
      project(),
    );
    assert.equal(res.graph.incomplete, true);
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-unsupported"));
  });

  it("a workspace member under a root bun.lockb reports it as unsupported", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "bun.lockb": "\u0000binary",
          "packages/a/package.json": "{}",
        }),
      ),
      project("packages/a"),
    );
    assert.equal(res.lockfile, "bun.lockb");
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-unsupported"));
  });

  it("fixture js/basic-unused: no lockfile gives an incomplete graph, never resolution", async () => {
    const res = await buildLockfileGraph(ctx(fixtureHandle("js", "basic-unused")), project());
    assert.equal(res.graph.incomplete, true);
    assert.deepEqual(res.graph.nodes, []);
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-missing"));
  });

  it("reports manifest/lockfile mismatches both ways", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { a: "1", added: "1" } }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { a: "1", removed: "1" } },
              "node_modules/a": { version: "1.0.0" },
              "node_modules/removed": { version: "1.0.0" },
            },
          }),
        }),
      ),
      project(),
    );
    const statements = res.evidence
      .filter((e) => e.kind === "lockfile-manifest-mismatch")
      .map((e) => e.statement);
    assert.equal(statements.length, 2);
    assert.ok(statements.some((s) => s.includes("added")));
    assert.ok(statements.some((s) => s.includes("removed")));
    assert.deepEqual(res.graph.transitiveClosure, { a: [] });
  });

  it("npm workspaces: member deps resolve through the root lockfile and links", async () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { workspaces: ["packages/*"] },
        "packages/app": { name: "app", dependencies: { lib: "*", chalk: "^5" } },
        "packages/lib": { name: "lib", version: "1.0.0", dependencies: { ms: "^2" } },
        "node_modules/app": { link: true, resolved: "packages/app" },
        "node_modules/lib": { link: true, resolved: "packages/lib" },
        "node_modules/ms": { version: "2.1.3" },
        "node_modules/chalk": { version: "5.3.0" },
        "packages/app/node_modules/chalk": { version: "4.1.2", dependencies: { ms: "*" } },
      },
    };
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": "{}",
          "package-lock.json": JSON.stringify(lock),
          "packages/app/package.json": JSON.stringify({ dependencies: { lib: "*", chalk: "^4" } }),
        }),
      ),
      project("packages/app"),
    );
    assert.deepEqual(res.lockfile, "package-lock.json");
    assert.deepEqual(res.graph.transitiveClosure, { lib: ["ms"], chalk: ["ms"] });
    assert.equal(res.graph.nodes.find((n) => n.name === "chalk")?.version, "4.1.2");
  });

  it("npm lockfileVersion 1 nested trees", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { a: "1" } }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 1,
            dependencies: {
              a: { version: "1.0.0", requires: { b: "1" } },
              b: {
                version: "1.0.0",
                requires: { c: "1" },
                dependencies: { c: { version: "2.0.0" } },
              },
              c: { version: "1.0.0" },
            },
          }),
        }),
      ),
      project(),
    );
    assert.deepEqual(res.graph.transitiveClosure, { a: ["b", "c"] });
    assert.equal(res.graph.nodes.find((n) => n.name === "c")?.version, "2.0.0");
  });

  it("pnpm v6 workspace importers and link: versions", async () => {
    const lock = [
      "lockfileVersion: '6.0'",
      "importers:",
      "  packages/web:",
      "    dependencies:",
      "      shared:",
      "        specifier: workspace:*",
      "        version: link:../shared",
      "      lodash:",
      "        specifier: ^4.17.0",
      "        version: 4.17.21",
      "packages:",
      "  /lodash@4.17.21:",
      "    resolution: {integrity: sha512-x}",
      "    dev: false",
    ].join("\n");
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "pnpm-lock.yaml": lock,
          "packages/web/package.json": JSON.stringify({
            dependencies: { shared: "workspace:*", lodash: "^4.17.0" },
          }),
        }),
      ),
      project("packages/web", ["pnpm"]),
    );
    assert.deepEqual(res.graph.transitiveClosure, { lodash: [] });
    assert.deepEqual(
      res.graph.nodes.map((n) => [n.name, n.version]),
      [["lodash", "4.17.21"]],
    );
    assert.deepEqual(
      res.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch"),
      [],
    );
  });

  it("cycles terminate", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { a: "1" } }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { a: "1" } },
              "node_modules/a": { version: "1.0.0", dependencies: { b: "1" } },
              "node_modules/b": { version: "1.0.0", dependencies: { a: "1" } },
            },
          }),
        }),
      ),
      project(),
    );
    assert.deepEqual(res.graph.transitiveClosure, { a: ["b"] });
  });

  it("malformed and unsupported lockfiles degrade to incomplete graphs with evidence", async () => {
    for (const [file, text, kind] of [
      ["package-lock.json", "{ not json", "lockfile-malformed"],
      ["pnpm-lock.yaml", "lockfileVersion: '5.4'\n", "lockfile-unsupported"],
      ["pnpm-lock.yaml", "a: &x [*x, *x]\nb: [: :\n", "lockfile-malformed"],
      ["yarn.lock", '  version "1"\n', "lockfile-malformed"],
    ] as const) {
      const res = await buildLockfileGraph(
        ctx(memoryHandle({ "package.json": "{}", [file]: text })),
        project(),
      );
      assert.equal(res.graph.incomplete, true, file + kind);
      assert.ok(
        res.evidence.some((e) => e.kind === kind),
        `${kind}: ${JSON.stringify(res.evidence)}`,
      );
    }
  });

  it("YAML alias bombs are refused, not expanded", async () => {
    const lines = ["lockfileVersion: '9.0'", "a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 12; i++) {
      lines.push(
        `a${i}: &a${i} [${Array(10)
          .fill(`*a${i - 1}`)
          .join(", ")}]`,
      );
    }
    const res = await buildLockfileGraph(
      ctx(memoryHandle({ "package.json": "{}", "pnpm-lock.yaml": lines.join("\n") })),
      project(),
    );
    assert.equal(res.graph.incomplete, true);
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-malformed"));
  });

  for (const shape of ["all direct deps at the chain head", "direct deps spread along the chain"]) {
    it(`adversarial graph (${shape}) stops at the work budget instead of going quadratic`, async () => {
      const N = 20_000;
      const D = 2_000;
      const packages: Record<string, unknown> = {};
      for (let i = 0; i < N; i++) {
        packages[`node_modules/p${i}`] = {
          version: "1.0.0",
          dependencies: i + 1 < N ? { [`p${i + 1}`]: "1" } : {},
        };
      }
      const direct: Record<string, string> = {};
      for (let j = 0; j < D; j++) {
        // Each direct dep is an alias-like package pointing into the chain.
        const target = shape.startsWith("all") ? "p0" : `p${j}`;
        packages[`node_modules/d${j}`] = { version: "1.0.0", dependencies: { [target]: "1" } };
        direct[`d${j}`] = "1";
      }
      packages[""] = { dependencies: direct };
      const started = performance.now();
      const res = await buildLockfileGraph(
        ctx(
          memoryHandle({
            "package.json": JSON.stringify({ dependencies: direct }),
            "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages }),
          }),
        ),
        project(),
      );
      const elapsed = performance.now() - started;
      assert.equal(res.graph.incomplete, true);
      assert.ok(res.evidence.some((e) => e.kind === "graph-budget-exceeded"));
      assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
    });
  }

  it("a dependency named __proto__ is kept as an own key, never lost or used as a prototype", async () => {
    const lock = `{"lockfileVersion":3,"packages":{"":{"dependencies":{"__proto__":"1","a":"1"}},"node_modules/__proto__":{"version":"1.0.0","dependencies":{"a":"1"}},"node_modules/a":{"version":"1.0.0"}}}`;
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": `{"dependencies":{"__proto__":"1","a":"1"}}`,
          "package-lock.json": lock,
        }),
      ),
      project(),
    );
    assert.deepEqual(Object.keys(res.graph.transitiveClosure).sort(), ["__proto__", "a"]);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(res.graph.transitiveClosure, "__proto__")?.value,
      ["a"],
    );
    assert.equal(Object.getPrototypeOf(res.graph.transitiveClosure), Object.prototype);
  });

  it("a project directory named __proto__ does not read Object.prototype as a lockfile entry", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
          "__proto__/package.json": JSON.stringify({ dependencies: { x: "1" } }),
        }),
      ),
      project("__proto__"),
    );
    assert.deepEqual(res.graph.transitiveClosure, {});
  });

  it("huge lockfile (30,000 packages) parses within the 5 s budget", async () => {
    const N = 30_000;
    const packages: Record<string, unknown> = { "": { dependencies: { p0: "1" } } };
    for (let i = 0; i < N; i++) {
      const deps: Record<string, string> = {};
      if (i + 1 < N) deps[`p${i + 1}`] = "1";
      if (i + 2 < N) deps[`p${i + 2}`] = "1";
      packages[`node_modules/p${i}`] = { version: "1.0.0", dependencies: deps };
    }
    const text = JSON.stringify({ lockfileVersion: 3, packages });
    const started = performance.now();
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { p0: "1" } }),
          "package-lock.json": text,
        }),
      ),
      project(),
    );
    const elapsed = performance.now() - started;
    assert.equal(res.graph.transitiveClosure.p0?.length, N - 1);
    assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
  });
});

describe("lockfile hardening (#91)", () => {
  it("re-exports core's single lockfile ceiling", () => {
    assert.equal(MAX_LOCKFILE_BYTES, CORE_MAX_LOCKFILE_BYTES);
  });

  it("caps lockfile-manifest-mismatch evidence per graph and summarises the rest", async () => {
    const extra = 9;
    const declared: Record<string, string> = {};
    for (let i = 0; i < MAX_MISMATCH_EVIDENCE + extra; i++) declared[`missing-${i}`] = "1";
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: declared }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            // Stale lockfile: every declared dep is missing from the root entry.
            packages: { "": {} },
          }),
        }),
      ),
      project(),
    );
    const mismatches = res.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch");
    assert.equal(mismatches.length, MAX_MISMATCH_EVIDENCE);
    const summary = res.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch-summary");
    assert.equal(summary.length, 1);
    assert.match(summary[0]!.statement, new RegExp(`^${extra} more`));
  });
});

describe("shared workspace lockfile is parsed once per run (#170)", () => {
  /** A pnpm v9 monorepo: `members` workspace packages, one root lockfile shared by all. */
  function monorepo(members: number): Record<string, string> {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "root", private: true }),
    };
    const lock = ["lockfileVersion: '9.0'", "importers:", "  .: {}"];
    for (let i = 0; i < members; i++) {
      lock.push(
        `  packages/p${i}:`,
        "    dependencies:",
        "      dep-a:",
        "        specifier: ^1.0.0",
        "        version: 1.0.0",
      );
      files[`packages/p${i}/package.json`] = JSON.stringify({
        name: `p${i}`,
        dependencies: { "dep-a": "^1.0.0" },
      });
    }
    lock.push(
      "packages:",
      "  dep-a@1.0.0:",
      "    resolution: {integrity: sha512-a}",
      "  dep-b@1.0.0:",
      "    resolution: {integrity: sha512-b}",
      "snapshots:",
      "  dep-a@1.0.0:",
      "    dependencies:",
      "      dep-b: 1.0.0",
      "  dep-b@1.0.0: {}",
    );
    files["pnpm-lock.yaml"] = lock.join("\n");
    return files;
  }

  it("300 members sharing pnpm-lock.yaml read and parse it exactly once", async () => {
    const files = monorepo(300);
    const base = memoryHandle(files);
    const reads = new Map<string, number>();
    const context = ctx({
      ...base,
      readFile: (p: string) => {
        reads.set(p, (reads.get(p) ?? 0) + 1);
        return base.readFile(p);
      },
    });
    const projects = Array.from({ length: 300 }, (_, i) => project(`packages/p${i}`, ["pnpm"]));
    const started = Date.now();
    const graphs = await buildDependencyGraph(context, projects);
    const elapsed = Date.now() - started;
    assert.equal(reads.get("pnpm-lock.yaml"), 1);
    assert.equal(graphs.length, 300);
    for (const g of graphs) {
      assert.equal(g.incomplete, false);
      assert.deepEqual(g.transitiveClosure, { "dep-a": ["dep-b"] });
    }
    // Loose bound: a per-project re-parse of a lockfile this size is what #170 caught.
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
  });

  it("per-importer results stay independent when the parsed lockfile is shared", async () => {
    const files = monorepo(2);
    files["packages/p1/package.json"] = JSON.stringify({
      name: "p1",
      dependencies: { "dep-a": "^1.0.0", missing: "^1.0.0" },
    });
    const context = ctx(memoryHandle(files));
    const a = await buildLockfileGraph(context, project("packages/p0", ["pnpm"]));
    const b = await buildLockfileGraph(context, project("packages/p1", ["pnpm"]));
    const again = await buildLockfileGraph(context, project("packages/p0", ["pnpm"]));
    const mismatches = (r: typeof a) =>
      r.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch").length;
    assert.equal(mismatches(a), 0);
    assert.ok(mismatches(b) >= 1);
    assert.equal(mismatches(again), 0);
    assert.deepEqual(again.graph, a.graph);
  });

  it("a malformed shared lockfile is reported for every member without re-parsing", async () => {
    const files = monorepo(3);
    files["pnpm-lock.yaml"] = "lockfileVersion: '9.0'\nimporters: [unclosed";
    const base = memoryHandle(files);
    let reads = 0;
    const context = ctx({
      ...base,
      readFile: (p: string) => {
        if (p === "pnpm-lock.yaml") reads++;
        return base.readFile(p);
      },
    });
    for (let i = 0; i < 3; i++) {
      const res = await buildLockfileGraph(context, project(`packages/p${i}`, ["pnpm"]));
      assert.ok(
        res.evidence.some((e) => e.kind === "lockfile-malformed" && e.file === "pnpm-lock.yaml"),
      );
      assert.equal(res.graph.incomplete, true);
    }
    assert.equal(reads, 1);
  });
});

describe("registryOrigin from lockfile evidence (#174 step 3)", () => {
  const origins = (nodes: { name: string; version: string; registryOrigin?: string }[]) =>
    Object.fromEntries(nodes.map((n) => [`${n.name}@${n.version}`, n.registryOrigin ?? null]));
  const manifest = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

  it("package-lock v3: resolved registry tarballs only; hostile resolved values stay absent", async () => {
    const pkg = (name: string, resolved?: unknown) => ({
      version: "1.0.0",
      ...(resolved === undefined ? {} : { resolved }),
    });
    const entries: Record<string, unknown> = {
      "": { dependencies: {} },
      "node_modules/ok": pkg("ok", "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz"),
      "node_modules/@acme/ui": pkg(
        "@acme/ui",
        "https://NPM.Acme.example:8443/@acme/ui/-/ui-1.0.0.tgz",
      ),
      "node_modules/creds": pkg("creds", "https://u:p@registry.npmjs.org/creds/-/creds-1.0.0.tgz"),
      "node_modules/query": pkg("query", "https://registry.npmjs.org/query/-/query-1.0.0.tgz?t=1"),
      "node_modules/frag": pkg("frag", "https://registry.npmjs.org/frag/-/frag-1.0.0.tgz#x"),
      "node_modules/git": pkg("git", "git+ssh://git@github.com/a/git.git#abc"),
      "node_modules/file": pkg("file", "file:../file-1.0.0.tgz"),
      "node_modules/badurl": pkg("badurl", "https://exa mple.com/badurl/-/badurl-1.0.0.tgz"),
      "node_modules/nonstr": pkg("nonstr", { href: "https://registry.npmjs.org" }),
      "node_modules/codeload": pkg("codeload", "https://codeload.github.com/a/codeload/tar.gz/abc"),
      "node_modules/missing": pkg("missing"),
    };
    const names = Object.keys(entries)
      .filter((k) => k)
      .map((k) => k.slice("node_modules/".length));
    (entries[""] as { dependencies: Record<string, string> }).dependencies = Object.fromEntries(
      names.map((n) => [n, "1.0.0"]),
    );
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": manifest(Object.fromEntries(names.map((n) => [n, "1.0.0"]))),
          "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: entries }),
        }),
      ),
      project(),
    );
    assert.deepEqual(origins(res.graph.nodes), {
      "@acme/ui@1.0.0": "https://npm.acme.example:8443",
      "badurl@1.0.0": null,
      "codeload@1.0.0": null,
      "creds@1.0.0": null,
      "file@1.0.0": null,
      "frag@1.0.0": null,
      "git@1.0.0": null,
      "missing@1.0.0": null,
      "nonstr@1.0.0": null,
      "ok@1.0.0": "https://registry.npmjs.org",
      "query@1.0.0": null,
    });
  });

  it("package-lock v1 nested entries use resolved too", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": manifest({ a: "1.0.0", b: "1.0.0" }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 1,
            dependencies: {
              a: { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
              b: { version: "1.0.0", resolved: "http://127.0.0.1:4873/b/-/b-1.0.0.tgz?x" },
            },
          }),
        }),
      ),
      project(),
    );
    assert.deepEqual(origins(res.graph.nodes), {
      "a@1.0.0": "https://registry.npmjs.org",
      "b@1.0.0": null,
    });
  });

  it("yarn classic: resolved with its #sha1 fragment; hostile values absent; Berry absent", async () => {
    const classic = [
      "ok@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://registry.yarnpkg.com/ok/-/ok-1.0.0.tgz#0123abcd"',
      "",
      "creds@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://tok@registry.yarnpkg.com/creds/-/creds-1.0.0.tgz#0123"',
      "",
      "gh@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://codeload.github.com/a/gh/tar.gz/abc"',
      "",
      "ssh@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "git+ssh://git@github.com/a/ssh.git#abc"',
      "",
      "q@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://registry.yarnpkg.com/q/-/q-1.0.0.tgz?x=1#0123"',
      "",
    ].join("\n");
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": manifest({
            ok: "^1.0.0",
            creds: "^1.0.0",
            gh: "^1.0.0",
            ssh: "^1.0.0",
            q: "^1.0.0",
          }),
          "yarn.lock": classic,
        }),
      ),
      project(),
    );
    assert.deepEqual(origins(res.graph.nodes), {
      "creds@1.0.0": null,
      "gh@1.0.0": null,
      "ok@1.0.0": "https://registry.yarnpkg.com",
      "q@1.0.0": null,
      "ssh@1.0.0": null,
    });

    const berry = [
      "__metadata:",
      "  version: 8",
      "",
      '"ok@npm:^1.0.0":',
      "  version: 1.0.0",
      '  resolution: "ok@npm:1.0.0"',
      '  resolved: "https://registry.yarnpkg.com/ok/-/ok-1.0.0.tgz"',
      "",
      '"app@workspace:.":',
      "  version: 0.0.0",
      '  resolution: "app@workspace:."',
      "  dependencies:",
      "    ok: ^1.0.0",
      "",
    ].join("\n");
    const b = await buildLockfileGraph(
      ctx(memoryHandle({ "package.json": manifest({ ok: "^1.0.0" }), "yarn.lock": berry })),
      project(),
    );
    assert.deepEqual(origins(b.graph.nodes), { "ok@1.0.0": null });
  });

  const pnpmLock = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      '@acme/ui': {specifier: 1.0.0, version: 1.0.0}",
    "      '@dup/x': {specifier: 1.0.0, version: 1.0.0}",
    "      '@tar/x': {specifier: 1.0.0, version: 1.0.0}",
    "      '@git/x': {specifier: 1.0.0, version: 1.0.0}",
    "      left-pad: {specifier: 1.3.0, version: 1.3.0}",
    "  packages/web:",
    "    dependencies:",
    "      '@acme/ui': {specifier: 1.0.0, version: 1.0.0}",
    "packages:",
    "  '@acme/ui@1.0.0': {resolution: {integrity: sha512-a}}",
    "  '@dup/x@1.0.0': {resolution: {integrity: sha512-b}}",
    "  '@tar/x@1.0.0': {resolution: {integrity: sha512-c, tarball: 'https://u:p@t.example/@tar/x/-/x-1.0.0.tgz'}}",
    "  '@git/x@1.0.0': {resolution: {type: git, repo: 'https://github.com/g/x', commit: abc}}",
    "  left-pad@1.3.0: {resolution: {integrity: sha512-d}}",
    "snapshots:",
    "  '@acme/ui@1.0.0': {}",
    "  '@dup/x@1.0.0': {}",
    "  '@tar/x@1.0.0': {}",
    "  '@git/x@1.0.0': {}",
    "  left-pad@1.3.0: {}",
    "",
  ].join("\n");

  it("pnpm: only a scoped .npmrc binding that unambiguously matches; bare registry= is not evidence", async () => {
    const npmrc = [
      "registry=https://registry.npmjs.org/",
      "@acme:registry=https://npm.acme.example/",
      "@dup:registry=https://a.example/",
      "@dup:registry=https://b.example/",
      "@git:registry=https://registry.npmjs.org/",
      "//npm.acme.example/:_authToken=secret",
    ].join("\n");
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": manifest({
            "@acme/ui": "1.0.0",
            "@dup/x": "1.0.0",
            "@tar/x": "1.0.0",
            "@git/x": "1.0.0",
            "left-pad": "1.3.0",
          }),
          "pnpm-lock.yaml": pnpmLock,
          ".npmrc": npmrc,
        }),
      ),
      project(".", ["pnpm"]),
    );
    assert.deepEqual(origins(res.graph.nodes), {
      "@acme/ui@1.0.0": "https://npm.acme.example",
      "@dup/x@1.0.0": null,
      // An explicit tarball wins over .npmrc, and here it carries credentials.
      "@tar/x@1.0.0": null,
      "@git/x@1.0.0": null,
      "left-pad@1.3.0": null,
    });
    assert.ok(!JSON.stringify(res).includes("secret"));
  });

  it("pnpm: no .npmrc, or a member .npmrc that contradicts the root, means absent", async () => {
    const files = {
      "package.json": manifest({}),
      "packages/web/package.json": manifest({ "@acme/ui": "1.0.0" }),
      "pnpm-lock.yaml": pnpmLock,
    };
    const none = await buildLockfileGraph(
      ctx(memoryHandle(files)),
      project("packages/web", ["pnpm"]),
    );
    assert.deepEqual(origins(none.graph.nodes), { "@acme/ui@1.0.0": null });

    const contradicted = await buildLockfileGraph(
      ctx(
        memoryHandle({
          ...files,
          ".npmrc": "@acme:registry=https://npm.acme.example/",
          "packages/web/.npmrc": "@acme:registry=https://registry.npmjs.org/",
        }),
      ),
      project("packages/web", ["pnpm"]),
    );
    assert.deepEqual(origins(contradicted.graph.nodes), { "@acme/ui@1.0.0": null });

    const agreed = await buildLockfileGraph(
      ctx(
        memoryHandle({
          ...files,
          ".npmrc": "@acme:registry=https://npm.acme.example/",
          "packages/web/.npmrc": "@acme:registry=https://npm.acme.example",
        }),
      ),
      project("packages/web", ["pnpm"]),
    );
    assert.deepEqual(origins(agreed.graph.nodes), { "@acme/ui@1.0.0": "https://npm.acme.example" });
  });

  it("pnpm: an oversize .npmrc is ignored", async () => {
    const res = await buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": manifest({ "@acme/ui": "1.0.0" }),
          "pnpm-lock.yaml": pnpmLock,
          ".npmrc": `@acme:registry=https://npm.acme.example/\n#${"x".repeat(MAX_NPMRC_BYTES)}`,
        }),
      ),
      project(".", ["pnpm"]),
    );
    assert.equal(res.graph.nodes.find((n) => n.name === "@acme/ui")?.registryOrigin, undefined);
  });
});

describe("buildLockfileGraph: non-object package.json (#566)", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } });
  for (const text of ["null", "[]", "42", "{"]) {
    it(`reports manifest-unreadable for package.json = ${text}`, async () => {
      const res = await buildLockfileGraph(
        ctx(memoryHandle({ "package.json": text, "package-lock.json": lock })),
        project(".", ["npm"]),
      );
      assert.deepEqual(
        res.evidence.filter((e) => e.kind === "manifest-unreadable").map((e) => e.file),
        ["package.json"],
      );
    });
  }
});

it("Yarn classic graph uses the effective optional override constraint", async () => {
  const res = await buildLockfileGraph(
    ctx(
      memoryHandle({
        "package.json": JSON.stringify({
          dependencies: { shared: "1" },
          optionalDependencies: { shared: "2" },
        }),
        "yarn.lock":
          'shared@2:\n  version "2.0.0"\n  dependencies:\n    leaf "1"\nleaf@1:\n  version "1.0.0"\n',
      }),
    ),
    project(".", ["yarn"]),
  );
  assert.equal(res.graph.incomplete, false);
  assert.deepEqual(res.graph.transitiveClosure.shared, ["leaf"]);
});

it("npm missing workspace importer stays incomplete despite hoisted packages", async () => {
  const res = await buildLockfileGraph(
    ctx(
      memoryHandle({
        "package.json": '{"workspaces":["packages/*"]}',
        "packages/app/package.json": '{"dependencies":{"shared":"1"}}',
        "package-lock.json": JSON.stringify({
          lockfileVersion: 3,
          packages: { "": {}, "node_modules/shared": { version: "1.0.0" } },
        }),
      }),
    ),
    project("packages/app", ["npm"]),
  );
  assert.equal(res.graph.incomplete, true);
  assert.ok(res.evidence.some((e) => e.kind === "lockfile-manifest-mismatch"));
});

describe("lockfileNotes: structural lockfile problems (#864)", () => {
  const notesFor = async (repository: AdapterContext["repository"], pm = "npm") =>
    (await lockfileNotes(ctx(repository), [project(".", [pm])])).map((n) => n.statement);

  it("discloses a malformed lockfile", async () => {
    const notes = await notesFor(memoryHandle({ "package.json": "{}", "package-lock.json": "{" }));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /package-lock\.json could not be parsed/);
  });

  it("discloses an unreadable lockfile", async () => {
    const files = { "package.json": "{}", "package-lock.json": "{}" };
    const base = memoryHandle(files);
    const repository = {
      ...base,
      readFile: (p: string) =>
        p === "package-lock.json" ? Promise.reject(new Error("EACCES")) : base.readFile(p),
    };
    assert.deepEqual(await notesFor(repository), ["could not read package-lock.json"]);
  });

  it("discloses an oversize lockfile", async () => {
    const big = JSON.stringify({ lockfileVersion: 3, pad: "x".repeat(MAX_LOCKFILE_BYTES) });
    const notes = await notesFor(memoryHandle({ "package.json": "{}", "package-lock.json": big }));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /exceeds \d+ bytes and was not parsed/);
  });

  it("discloses an unsupported bun.lockb", async () => {
    const notes = await notesFor(
      memoryHandle({ "package.json": "{}", "bun.lockb": "\u0000binary" }),
      "bun",
    );
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /bun\.lockb/);
  });

  it("discloses a version 1 npm lockfile used for a workspace member", async () => {
    const lock = JSON.stringify({ lockfileVersion: 1, dependencies: {} });
    const notes = (
      await lockfileNotes(
        ctx(memoryHandle({ "package-lock.json": lock, "packages/a/package.json": "{}" })),
        [project("packages/a", ["npm"])],
      )
    ).map((n) => n.statement);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /lockfileVersion 1/);
  });

  it("reports a shared lockfile problem once across workspace projects", async () => {
    const repository = memoryHandle({
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
      "package-lock.json": "{",
    });
    const notes = await lockfileNotes(ctx(repository), [
      project("packages/a", ["npm"]),
      project("packages/b", ["npm"]),
    ]);
    assert.equal(notes.length, 1);
  });

  it("adds no note for a clean lockfile", async () => {
    const repository = fixtureHandle("js", "lockfile-npm-v3");
    assert.deepEqual(await notesFor(repository), []);
  });
});

describe("buildLockfileGraph: two-document pnpm lockfile (#894)", () => {
  const env = [
    "---",
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    configDependencies: {}",
    "    packageManagerDependencies:",
    "      pnpm:",
    "        specifier: 12.3.4",
    "        version: 12.3.4",
    "packages:",
    "  pnpm@12.3.4:",
    "    resolution: {integrity: sha512-env}",
    "snapshots:",
    "  pnpm@12.3.4: {}",
  ];
  const projectDoc = [
    "---",
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      lodash:",
    "        specifier: ^4.17.0",
    "        version: 4.17.21",
    "packages:",
    "  lodash@4.17.21:",
    "    resolution: {integrity: sha512-x}",
    "snapshots:",
    "  lodash@4.17.21: {}",
  ];
  const build = (lines: string[]) =>
    buildLockfileGraph(
      ctx(
        memoryHandle({
          "pnpm-lock.yaml": lines.join("\n"),
          "package.json": JSON.stringify({ dependencies: { lodash: "^4.17.0" } }),
        }),
      ),
      project(".", ["pnpm"]),
    );

  it("reads the project graph from the last document", async () => {
    const res = await build([...env, ...projectDoc]);
    assert.deepEqual(
      res.evidence.filter((e) => e.kind === "lockfile-malformed"),
      [],
    );
    assert.deepEqual(
      res.graph.nodes.map((n) => [n.name, n.version]),
      [["lodash", "4.17.21"]],
    );
  });

  it("still reads a single document that starts with ---", async () => {
    const res = await build(projectDoc);
    assert.deepEqual(
      res.graph.nodes.map((n) => [n.name, n.version]),
      [["lodash", "4.17.21"]],
    );
  });

  it("reports more than two documents as malformed", async () => {
    const res = await build([...env, ...env, ...projectDoc]);
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-malformed"));
  });

  it("reports a syntax error in any document as malformed", async () => {
    const res = await build([
      ...env,
      "---",
      "lockfileVersion: '9.0'",
      "importers: [",
      ...projectDoc.slice(1),
    ]);
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-malformed"));
  });
});

describe("buildLockfileGraph: pnpm workspace membership gates stale importers (#894)", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .: {}",
    "  packages/a:",
    "    dependencies:",
    "      lodash:",
    "        specifier: ^4.17.0",
    "        version: 4.17.21",
    "packages:",
    "  lodash@4.17.21:",
    "    resolution: {integrity: sha512-x}",
    "snapshots:",
    "  lodash@4.17.21: {}",
  ].join("\n");
  const manifest = JSON.stringify({ dependencies: { lodash: "^4.17.0" } });
  const build = (dir: string, workspace: string | undefined) =>
    buildLockfileGraph(
      ctx(
        memoryHandle({
          "pnpm-lock.yaml": lock,
          "package.json": "{}",
          [`${dir}/package.json`]: manifest,
          ...(workspace === undefined ? {} : { "pnpm-workspace.yaml": workspace }),
        }),
      ),
      project(dir, ["pnpm"]),
    );
  const kinds = (res: Awaited<ReturnType<typeof build>>) => res.evidence.map((e) => e.kind);

  it("does not call a non-member stale", async () => {
    const res = await build("templates/x", "packages:\n  - packages/*\n");
    assert.deepEqual(
      kinds(res).filter((k) => k.startsWith("lockfile-")),
      ["lockfile-not-workspace-member"],
    );
    assert.equal(res.graph.incomplete, true);
  });

  it("still flags a real member that has no importer", async () => {
    const res = await build("packages/b", "packages:\n  - packages/*\n");
    assert.ok(kinds(res).includes("lockfile-manifest-mismatch"));
    assert.equal(res.graph.incomplete, true);
  });

  it("builds a member that has an importer", async () => {
    const res = await build("packages/a", "packages:\n  - packages/*\n");
    assert.deepEqual(
      res.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch"),
      [],
    );
    assert.equal(res.graph.nodes.length, 1);
  });

  for (const [name, workspace] of [
    ["missing", undefined],
    ["malformed", "packages: [\n"],
    ["without a packages list", "catalog: {}\n"],
    ["with an unsupported glob", "packages:\n  - 'packages/{a,b}'\n"],
  ] as const) {
    it(`reports a limitation, not a stale claim, when the workspace file is ${name}`, async () => {
      const res = await build("packages/b", workspace);
      assert.ok(kinds(res).includes("lockfile-workspace-unverified"));
      assert.ok(!kinds(res).includes("lockfile-manifest-mismatch"));
      assert.equal(res.graph.incomplete, true);
    });
  }
});

describe("npm lockfile: reachable dependencies with no package entry", () => {
  const graphFor = (packages: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { a: "1" } }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { a: "1" } },
              "node_modules/a": { version: "1.0.0", ...extra },
              ...packages,
            },
          }),
        }),
      ),
      project(),
    );

  it("marks the graph incomplete when a reachable package requires an unlocked dependency", async () => {
    const res = await graphFor({}, { dependencies: { missing: "^1" } });
    assert.equal(res.graph.incomplete, true);
    const note = res.evidence.find((e) => e.kind === "lockfile-unresolved-reachable");
    assert.match(note?.statement ?? "", /missing/);
    assert.match(note?.statement ?? "", /package-lock\.json/);
  });

  it("keeps optional dependencies and optional peers complete when they are not locked", async () => {
    const res = await graphFor(
      {},
      {
        dependencies: { both: "1" },
        optionalDependencies: { both: "1", fsevents: "2" },
        peerDependencies: { react: "18", plugin: "1" },
        peerDependenciesMeta: { react: { optional: true } },
      },
    );
    assert.equal(res.graph.incomplete, false);
    assert.ok(!res.evidence.some((e) => e.kind === "lockfile-unresolved-reachable"));
  });

  it("ignores an unlocked dependency of a package no direct dependency reaches", async () => {
    const res = await graphFor({
      "node_modules/orphan": { version: "1.0.0", dependencies: { ghost: "1" } },
    });
    assert.equal(res.graph.incomplete, false);
  });

  it("resolves a transitive dependency hoisted to the root", async () => {
    const res = await graphFor(
      { "node_modules/b": { version: "1.0.0" } },
      { dependencies: { b: "1" } },
    );
    assert.equal(res.graph.incomplete, false);
  });

  it("surfaces the unlocked reachable dependency as a run note", async () => {
    const notes = await lockfileNotes(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({ dependencies: { a: "1" } }),
          "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { a: "1" } },
              "node_modules/a": { version: "1.0.0", dependencies: { missing: "^1" } },
            },
          }),
        }),
      ),
      [project()],
    );
    assert.ok(notes.some((n) => /missing/.test(n.statement)));
  });
});

describe("yarn classic lockfile: reachable dependencies with no lock entry", () => {
  const graphFor = (
    lock: string,
    manifest: Record<string, unknown> = { dependencies: { a: "^1" } },
  ) =>
    buildLockfileGraph(
      ctx(memoryHandle({ "package.json": JSON.stringify(manifest), "yarn.lock": lock })),
      project(),
    );
  const entry = (extra: string) => `a@^1:\n  version "1.0.0"\n${extra}`;

  it("marks the graph incomplete when a reachable package requires an unlocked dependency", async () => {
    const res = await graphFor(entry('  dependencies:\n    missing "^1"\n'));
    assert.equal(res.graph.incomplete, true);
    const note = res.evidence.find((e) => e.kind === "lockfile-unresolved-reachable");
    assert.match(note?.statement ?? "", /missing/);
    assert.match(note?.statement ?? "", /yarn\.lock/);
  });

  it("keeps an unlocked optional dependency complete, including one repeated in dependencies", async () => {
    for (const extra of [
      '  optionalDependencies:\n    missing "^1"\n',
      '  dependencies:\n    missing "^1"\n  optionalDependencies:\n    missing "^1"\n',
    ]) {
      const res = await graphFor(entry(extra));
      assert.equal(res.graph.incomplete, false);
      assert.ok(!res.evidence.some((e) => e.kind === "lockfile-unresolved-reachable"));
    }
  });

  it("ignores an unlocked dependency of a package no direct dependency reaches", async () => {
    const res = await graphFor(
      `${entry("")}\norphan@^1:\n  version "1.0.0"\n  dependencies:\n    ghost "^1"\n`,
    );
    assert.equal(res.graph.incomplete, false);
  });

  it("still links a locked dependency and stays complete", async () => {
    const res = await graphFor(
      `${entry('  dependencies:\n    b "^1"\n')}\nb@^1:\n  version "1.0.0"\n`,
    );
    assert.equal(res.graph.incomplete, false);
    assert.deepEqual(res.graph.transitiveClosure.a, ["b"]);
  });

  it("stays complete on a real yarn 1.22.22 lockfile with resolutions, aliases, url, git and workspaces", async () => {
    const res = await graphFor(REAL_YARN_CLASSIC_LOCK, JSON.parse(REAL_YARN_CLASSIC_MANIFEST));
    assert.equal(res.graph.incomplete, false);
    assert.ok(!res.evidence.some((e) => e.kind === "lockfile-unresolved-reachable"));
    // braces is overridden by resolutions but still reached through micromatch.
    assert.ok(res.graph.transitiveClosure.micromatch?.includes("braces"));
    // Removing a locked entry the real graph reaches is detected.
    const broken = REAL_YARN_CLASSIC_LOCK.replace(/^fill-range@[^\n]*\n(?: {2}.*\n)+\n/m, "");
    assert.notEqual(broken, REAL_YARN_CLASSIC_LOCK);
    const res2 = await graphFor(broken, JSON.parse(REAL_YARN_CLASSIC_MANIFEST));
    assert.equal(res2.graph.incomplete, true);
    assert.match(
      res2.evidence.find((e) => e.kind === "lockfile-unresolved-reachable")?.statement ?? "",
      /fill-range/,
    );
  });
});

const REAL_YARN_CLASSIC_MANIFEST = String.raw`{"name":"root","version":"1.0.0","private":true,"workspaces":["pkgs/*"],
 "dependencies":{"micromatch":"^4.0.5","num":"npm:is-number@^7.0.0","tiny":"https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz","gitdep":"github:sindresorhus/is-plain-obj#v4.1.0"},
 "optionalDependencies":{"fsevents":"^2.3.3"},
 "resolutions":{"braces":"3.0.3"}}`;

// Generated by yarn 1.22.22 (root with workspaces a and b, resolutions, an npm:
// alias, a tarball URL, a GitHub dependency and an optional dependency).
const REAL_YARN_CLASSIC_LOCK = String.raw`# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


braces@3.0.3, braces@^3.0.3:
  version "3.0.3"
  resolved "https://registry.yarnpkg.com/braces/-/braces-3.0.3.tgz#490332f40919452272d55a8480adc0c441358789"
  integrity sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==
  dependencies:
    fill-range "^7.1.1"

fill-range@^7.1.1:
  version "7.1.1"
  resolved "https://registry.yarnpkg.com/fill-range/-/fill-range-7.1.1.tgz#44265d3cac07e3ea7dc247516380643754a05292"
  integrity sha512-YsGpe3WHLK8ZYi4tWDg2Jy3ebRz2rXowDxnld4bkQB00cc/1Zw9AWnC0i9ztDJitivtQvaI9KaLyKrc+hBW0yg==
  dependencies:
    to-regex-range "^5.0.1"

fsevents@^2.3.3:
  version "2.3.3"
  resolved "https://registry.yarnpkg.com/fsevents/-/fsevents-2.3.3.tgz#cac6407785d03675a2a5e1a5305c697b347d90d6"
  integrity sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==

"gitdep@github:sindresorhus/is-plain-obj#v4.1.0":
  version "4.1.0"
  resolved "https://codeload.github.com/sindresorhus/is-plain-obj/tar.gz/68e8cc77bb1bbd0bf7d629d3574b6ca70289b2cc"

is-number@^7.0.0:
  version "7.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"
  integrity sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==

left-pad@^1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e"
  integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==

micromatch@^4.0.5:
  version "4.0.8"
  resolved "https://registry.yarnpkg.com/micromatch/-/micromatch-4.0.8.tgz#d66fa18f3a47076789320b9b1af32bd86d9fa202"
  integrity sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA==
  dependencies:
    braces "^3.0.3"
    picomatch "^2.3.1"

ms@^2.1.3:
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2"
  integrity sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==

"num@npm:is-number@^7.0.0":
  version "7.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"
  integrity sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==

picomatch@^2.3.1:
  version "2.3.2"
  resolved "https://registry.yarnpkg.com/picomatch/-/picomatch-2.3.2.tgz#5a942915e26b372dc0f0e6753149a16e6b1c5601"
  integrity sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==

"tiny@https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz":
  version "7.0.0"
  resolved "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"

to-regex-range@^5.0.1:
  version "5.0.1"
  resolved "https://registry.yarnpkg.com/to-regex-range/-/to-regex-range-5.0.1.tgz#1648c44aae7c8d988a326018ed72f5b4dd0392e4"
  integrity sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ==
  dependencies:
    is-number "^7.0.0"
`;

describe("yarn classic lockfile: dependencies fulfilled by a local workspace", () => {
  // Real yarn 1.22.22 output: root workspaces ["pkgs/*"], pkgs/b is b@1.0.0, and the
  // file: tarball parent-review depends on b@1.0.0. Yarn symlinks b and writes no entry.
  const LOCK = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#54569e1bf4ccc274c36847949eb71ea1ae84cfdb"
  dependencies:
    b "1.0.0"
`;
  const graphFor = (files: Record<string, string>) =>
    buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({
            name: "root",
            private: true,
            workspaces: ["pkgs/*"],
            dependencies: { "parent-review": "file:./parent-review.tgz" },
          }),
          "yarn.lock": LOCK,
          ...files,
        }),
      ),
      project(),
    );
  const bManifest = (version: string) => JSON.stringify({ name: "b", version });

  it("exempts a matching workspace member", async () => {
    const res = await graphFor({ "pkgs/b/package.json": bManifest("1.0.0") });
    assert.equal(res.graph.incomplete, false);
    assert.ok(!res.evidence.some((e) => e.kind === "lockfile-unresolved-reachable"));
  });

  it("flags a workspace whose version does not satisfy the requested range", async () => {
    const res = await graphFor({ "pkgs/b/package.json": bManifest("2.0.0") });
    assert.equal(res.graph.incomplete, true);
    assert.match(
      res.evidence.find((e) => e.kind === "lockfile-unresolved-reachable")?.statement ?? "",
      /\bb\b/,
    );
  });

  it("flags a same-name directory outside the workspaces globs", async () => {
    const res = await graphFor({ "other/b/package.json": bManifest("1.0.0") });
    assert.equal(res.graph.incomplete, true);
    assert.ok(res.evidence.some((e) => e.kind === "lockfile-unresolved-reachable"));
  });

  it("flags when no workspace provides the package", async () => {
    const res = await graphFor({});
    assert.equal(res.graph.incomplete, true);
  });
});

describe("yarn classic lockfile: workspace fulfilment that cannot be proven", () => {
  // Each lock is real yarn 1.22.22 output where `b` is symlinked to pkgs/b and has no entry.
  const LOCKS = {
    build: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#32b51d08dca6dd8d2044c5ba9e0db4a118979256"
  dependencies:
    b "1.2.3+build"
`,
    caretBuild: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#df2fef45f42003925d0c1008557f4f01a6ed307a"
  dependencies:
    b "^1.2.3+build"
`,
    prerelease: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#2b28071793a27bd4611d5b8c817e16e5b9eb2aa7"
  dependencies:
    b ">=1.2.3-beta.1 <1.2.3"
`,
    stableVsPrereleaseRange: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#7b93667561d5c66ffce0c4e515d19ce3b64b987a"
  dependencies:
    b ">=1.0.0-beta"
`,
    prereleaseAlternative: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#4ebfa8cf23d13b8e35a60264b6ae1848c05ae272"
  dependencies:
    b "^1.0.0 || >=1.2.3-beta.1 <1.2.3"
`,
    brace: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#54569e1bf4ccc274c36847949eb71ea1ae84cfdb"
  dependencies:
    b "1.0.0"
`,
    packagesForm: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"parent-review@file:./parent-review.tgz":
  version "1.0.0"
  resolved "file:./parent-review.tgz#54569e1bf4ccc274c36847949eb71ea1ae84cfdb"
  dependencies:
    b "1.0.0"
`,
  };
  const run = (
    lock: string,
    workspaces: unknown,
    bVersion: string,
    extra: Record<string, string> = {},
  ) =>
    buildLockfileGraph(
      ctx(
        memoryHandle({
          "package.json": JSON.stringify({
            name: "root",
            private: true,
            workspaces,
            dependencies: { "parent-review": "file:./parent-review.tgz" },
          }),
          "yarn.lock": lock,
          "pkgs/b/package.json": JSON.stringify({ name: "b", version: bVersion }),
          ...extra,
        }),
      ),
      project(),
    );
  const kinds = (r: Awaited<ReturnType<typeof run>>) => r.evidence.map((e) => e.kind);

  it("treats build metadata on either side as equal, like semver", async () => {
    for (const lock of [LOCKS.build, LOCKS.caretBuild]) {
      const res = await run(lock, ["pkgs/*"], "1.2.3");
      assert.equal(res.graph.incomplete, false);
      assert.deepEqual(kinds(res), []);
    }
  });

  it("reports a limitation, not a missing entry, for prerelease ranges or versions", async () => {
    for (const [lock, version] of [
      [LOCKS.prerelease, "1.2.3-beta.2"],
      [LOCKS.stableVsPrereleaseRange, "1.2.3"],
      [LOCKS.prereleaseAlternative, "1.2.3-beta.2"],
    ] as const) {
      const res = await run(lock, ["pkgs/*"], version);
      assert.equal(res.graph.incomplete, true);
      assert.deepEqual(kinds(res), ["lockfile-workspace-unverified"]);
      assert.match(res.evidence[0]?.statement ?? "", /\bb\b/);
    }
  });

  it("reports a limitation when a brace glob leaves workspace membership unproven", async () => {
    const res = await run(LOCKS.brace, ["pkgs/{a,b}"], "1.0.0");
    assert.equal(res.graph.incomplete, true);
    assert.deepEqual(kinds(res), ["lockfile-workspace-unverified"]);
  });

  it("matches workspaces before applying the manifest cap", async () => {
    const outside: Record<string, string> = {};
    for (let i = 0; i < 2_100; i++) {
      outside[`other/p${i}/package.json`] = JSON.stringify({ name: `p${i}`, version: "1.0.0" });
    }
    const res = await run(LOCKS.packagesForm, { packages: ["pkgs/*"] }, "1.0.0", outside);
    assert.equal(res.graph.incomplete, false);
    assert.deepEqual(kinds(res), []);
  });

  it("reports a limitation when more workspace candidates exist than can be read", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 2_100; i++) {
      many[`pkgs/p${i}/package.json`] = JSON.stringify({ name: `p${i}`, version: "1.0.0" });
    }
    const res = await run(LOCKS.packagesForm, ["pkgs/*"], "9.9.9", many);
    assert.deepEqual(kinds(res), ["lockfile-workspace-unverified"]);
  });

  it("still names a missing entry when no workspace can explain it", async () => {
    const res = await run(LOCKS.packagesForm, ["pkgs/*"], "2.0.0");
    assert.deepEqual(kinds(res), ["lockfile-unresolved-reachable"]);
  });
});

describe("versionSatisfies", () => {
  it("answers only for the strict stable grammar and otherwise says unknown", () => {
    const yes: [string, string][] = [
      ["1.0.0", "1.0.0"],
      ["1.2.3", "^1.0.0"],
      ["0.2.3", "^0.2.0"],
      ["1.2.9", "~1.2.3"],
      ["1.9.9", "1.x"],
      ["5.0.0", "*"],
      ["1.5.0", ">=1.2.3 <2"],
      ["3.1.0", "^1.0.0 || ^3.0.0"],
      ["1.5.0", "1.2.3 - 2.3.4"],
      ["1.2.3", "1.2.3+build"],
      ["1.2.3+build", "^1.2.3"],
    ];
    const no: [string, string][] = [
      ["2.0.0", "1.0.0"],
      ["2.0.0", "^1.0.0"],
      ["0.3.0", "^0.2.0"],
      ["1.3.0", "~1.2.3"],
      ["1.0.0", ">*"],
    ];
    const unknown: [string, string][] = [
      ["1.0.0", "latest"],
      ["1.0.0", "file:../b"],
      ["1.0.0", "workspace:^"],
      ["1.0.0-beta.1", "^1.0.0"],
      ["1.2.3", ">=1.0.0-beta"],
      ["1.2.3", "01.2.3"],
      ["9007199254740993.0.0", "*"],
      ["1.0.0", "<9007199254740993.0.0"],
      ["1.0.0", "<9007199254740991.0.0"],
      ["1.0.0", "^1.0.99999999999999999999"],
      ["1.2.3", "1.x.3"],
      ["1.2.3", "*.1"],
      ["1.2.3", "1.2.3 || latest"],
      ["1.2.3", "^1.0.0 || file:x"],
      ["1.2.3", "1.2.3+"],
      ["1.2.3", "1.2.3+.."],
      ["1.2.3", "1.2.3+a..b"],
      ["1.2.3", "1.2.3+a_b"],
      ["1.2.3", "^1.2.3+"],
      ["1.2.3", "1.x+build"],
      ["1.2.3+", "1.2.3"],
      ["1.2.3+..", "*"],
      ["1.2.3+a.", "^1.0.0"],
      ["01.2.3", "*"],
      ["not-a-version", "*"],
    ];
    for (const [v, r] of yes) assert.equal(versionSatisfies(v, r), "yes", `${v} ${r}`);
    for (const [v, r] of no) assert.equal(versionSatisfies(v, r), "no", `${v} ${r}`);
    for (const [v, r] of unknown) assert.equal(versionSatisfies(v, r), "unknown", `${v} ${r}`);
  });
});

// Real yarn 4.9.2 output for a root with workspaces, resolutions, an npm: alias, file:, link:,
// portal:, git and https descriptors, an optional dependency and the builtin typescript patch.
const REAL_YARN_BERRY_LOCK = String.raw`# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"@isaacs/fs-minipass@npm:^4.0.0":
  version: 4.0.1
  resolution: "@isaacs/fs-minipass@npm:4.0.1"
  dependencies:
    minipass: "npm:^7.0.4"
  checksum: 10c0/c25b6dc1598790d5b55c0947a9b7d111cfa92594db5296c3b907e2f533c033666f692a3939eadac17b1c7c40d362d0b0635dc874cbfe3e70db7c2b07cc97a5d2
  languageName: node
  linkType: hard

"a@workspace:pkgs/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:pkgs/a"
  dependencies:
    b: "workspace:^"
    left-pad: "npm:^1.3.0"
  peerDependencies:
    react: "*"
  peerDependenciesMeta:
    react:
      optional: true
  languageName: unknown
  linkType: soft

"abbrev@npm:^5.0.0":
  version: 5.0.0
  resolution: "abbrev@npm:5.0.0"
  checksum: 10c0/8e88f5c798ea4562d28c5a3e9ad69e3879890bc5d695d8f2dffb8609be4c890aacc8f80ef4553fdd2c6a62d70c2ce8bc57b38074e383beb7487bdafa9ed42ea5
  languageName: node
  linkType: hard

"anymatch@npm:~3.1.2":
  version: 3.1.3
  resolution: "anymatch@npm:3.1.3"
  dependencies:
    normalize-path: "npm:^3.0.0"
    picomatch: "npm:^2.0.4"
  checksum: 10c0/57b06ae984bc32a0d22592c87384cd88fe4511b1dd7581497831c56d41939c8a001b28e7b853e1450f2bf61992dfcaa8ae2d0d161a0a90c4fb631ef07098fbac
  languageName: node
  linkType: hard

"b@workspace:^, b@workspace:pkgs/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:pkgs/b"
  dependencies:
    ms: "npm:^2.1.3"
  languageName: unknown
  linkType: soft

"binary-extensions@npm:^2.0.0":
  version: 2.3.0
  resolution: "binary-extensions@npm:2.3.0"
  checksum: 10c0/75a59cafc10fb12a11d510e77110c6c7ae3f4ca22463d52487709ca7f18f69d886aa387557cc9864fbdb10153d0bdb4caacabf11541f55e89ed6e18d12ece2b5
  languageName: node
  linkType: hard

"braces@npm:3.0.3":
  version: 3.0.3
  resolution: "braces@npm:3.0.3"
  dependencies:
    fill-range: "npm:^7.1.1"
  checksum: 10c0/7c6dfd30c338d2997ba77500539227b9d1f85e388a5f43220865201e407e076783d0881f2d297b9f80951b4c957fcf0b51c1d2d24227631643c3f7c284b0aa04
  languageName: node
  linkType: hard

"chokidar@npm:^3.6.0":
  version: 3.6.0
  resolution: "chokidar@npm:3.6.0"
  dependencies:
    anymatch: "npm:~3.1.2"
    braces: "npm:~3.0.2"
    fsevents: "npm:~2.3.2"
    glob-parent: "npm:~5.1.2"
    is-binary-path: "npm:~2.1.0"
    is-glob: "npm:~4.0.1"
    normalize-path: "npm:~3.0.0"
    readdirp: "npm:~3.6.0"
  dependenciesMeta:
    fsevents:
      optional: true
  checksum: 10c0/8361dcd013f2ddbe260eacb1f3cb2f2c6f2b0ad118708a343a5ed8158941a39cb8fb1d272e0f389712e74ee90ce8ba864eece9e0e62b9705cb468a2f6d917462
  languageName: node
  linkType: hard

"chownr@npm:^3.0.0":
  version: 3.0.0
  resolution: "chownr@npm:3.0.0"
  checksum: 10c0/43925b87700f7e3893296c8e9c56cc58f926411cce3a6e5898136daaf08f08b9a8eb76d37d3267e707d0dcc17aed2e2ebdf5848c0c3ce95cf910a919935c1b10
  languageName: node
  linkType: hard

"env-paths@npm:^2.2.0":
  version: 2.2.1
  resolution: "env-paths@npm:2.2.1"
  checksum: 10c0/285325677bf00e30845e330eec32894f5105529db97496ee3f598478e50f008c5352a41a30e5e72ec9de8a542b5a570b85699cd63bd2bc646dbcb9f311d83bc4
  languageName: node
  linkType: hard

"exponential-backoff@npm:^3.1.1":
  version: 3.1.3
  resolution: "exponential-backoff@npm:3.1.3"
  checksum: 10c0/77e3ae682b7b1f4972f563c6dbcd2b0d54ac679e62d5d32f3e5085feba20483cf28bd505543f520e287a56d4d55a28d7874299941faf637e779a1aa5994d1267
  languageName: node
  linkType: hard

"fdir@npm:^6.5.0":
  version: 6.5.0
  resolution: "fdir@npm:6.5.0"
  peerDependencies:
    picomatch: ^3 || ^4
  peerDependenciesMeta:
    picomatch:
      optional: true
  checksum: 10c0/e345083c4306b3aed6cb8ec551e26c36bab5c511e99ea4576a16750ddc8d3240e63826cc624f5ae17ad4dc82e68a253213b60d556c11bfad064b7607847ed07f
  languageName: node
  linkType: hard

"fill-range@npm:^7.1.1":
  version: 7.1.1
  resolution: "fill-range@npm:7.1.1"
  dependencies:
    to-regex-range: "npm:^5.0.1"
  checksum: 10c0/b75b691bbe065472f38824f694c2f7449d7f5004aa950426a2c28f0306c60db9b880c0b0e4ed819997ffb882d1da02cfcfc819bddc94d71627f5269682edf018
  languageName: node
  linkType: hard

"fl@file:./local::locator=root%40workspace%3A.":
  version: 1.0.0
  resolution: "fl@file:./local#./local::hash=8f3a16&locator=root%40workspace%3A."
  checksum: 10c0/365e82f28f5fd2e2c9636b7bc396ffd2b220e514bae1c7360f0989880a3902a25993ea80aa251fbc995e3b8abd5ec87071827690fb56a91e4b7e6c226238314e
  languageName: node
  linkType: hard

"fsevents@npm:^2.3.3, fsevents@npm:~2.3.2":
  version: 2.3.3
  resolution: "fsevents@npm:2.3.3"
  dependencies:
    node-gyp: "npm:latest"
  checksum: 10c0/a1f0c44595123ed717febbc478aa952e47adfc28e2092be66b8ab1635147254ca6cfe1df792a8997f22716d4cbafc73309899ff7bfac2ac3ad8cf2e4ecc3ec60
  conditions: os=darwin
  languageName: node
  linkType: hard

"fsevents@patch:fsevents@npm%3A^2.3.3#optional!builtin<compat/fsevents>, fsevents@patch:fsevents@npm%3A~2.3.2#optional!builtin<compat/fsevents>":
  version: 2.3.3
  resolution: "fsevents@patch:fsevents@npm%3A2.3.3#optional!builtin<compat/fsevents>::version=2.3.3&hash=df0bf1"
  dependencies:
    node-gyp: "npm:latest"
  conditions: os=darwin
  languageName: node
  linkType: hard

"gitdep@github:sindresorhus/is-plain-obj#v4.1.0":
  version: 4.1.0
  resolution: "gitdep@https://github.com/sindresorhus/is-plain-obj.git#commit=3b33a59bd31fdee17acebeb0f9e39b6eca007719"
  checksum: 10c0/823487e55e347fd292dfa6247d7ae81ac526f1d5e199d7184d53a5399c0cecb512d4244eaf37d29ded648df0428f4e875f251ccd578036e7ec04f870b18414f1
  languageName: node
  linkType: hard

"glob-parent@npm:5.1.2":
  version: 5.1.2
  resolution: "glob-parent@npm:5.1.2"
  dependencies:
    is-glob: "npm:^4.0.1"
  checksum: 10c0/cab87638e2112bee3f839ef5f6e0765057163d39c66be8ec1602f3823da4692297ad4e972de876ea17c44d652978638d2fd583c6713d0eb6591706825020c9ee
  languageName: node
  linkType: hard

"graceful-fs@npm:^4.2.6":
  version: 4.2.11
  resolution: "graceful-fs@npm:4.2.11"
  checksum: 10c0/386d011a553e02bc594ac2ca0bd6d9e4c22d7fa8cfbfc448a6d148c59ea881b092db9dbe3547ae4b88e55f1b01f7c4a2ecc53b310c042793e63aa44cf6c257f2
  languageName: node
  linkType: hard

"is-binary-path@npm:~2.1.0":
  version: 2.1.0
  resolution: "is-binary-path@npm:2.1.0"
  dependencies:
    binary-extensions: "npm:^2.0.0"
  checksum: 10c0/a16eaee59ae2b315ba36fad5c5dcaf8e49c3e27318f8ab8fa3cdb8772bf559c8d1ba750a589c2ccb096113bb64497084361a25960899cb6172a6925ab6123d38
  languageName: node
  linkType: hard

"is-extglob@npm:^2.1.1":
  version: 2.1.1
  resolution: "is-extglob@npm:2.1.1"
  checksum: 10c0/5487da35691fbc339700bbb2730430b07777a3c21b9ebaecb3072512dfd7b4ba78ac2381a87e8d78d20ea08affb3f1971b4af629173a6bf435ff8a4c47747912
  languageName: node
  linkType: hard

"is-glob@npm:^4.0.1, is-glob@npm:~4.0.1":
  version: 4.0.3
  resolution: "is-glob@npm:4.0.3"
  dependencies:
    is-extglob: "npm:^2.1.1"
  checksum: 10c0/17fb4014e22be3bbecea9b2e3a76e9e34ff645466be702f1693e8f1ee1adac84710d0be0bd9f967d6354036fd51ab7c2741d954d6e91dae6bb69714de92c197a
  languageName: node
  linkType: hard

"is-number@npm:^7.0.0, num@npm:is-number@^7.0.0":
  version: 7.0.0
  resolution: "is-number@npm:7.0.0"
  checksum: 10c0/b4686d0d3053146095ccd45346461bc8e53b80aeb7671cc52a4de02dbbf7dc0d1d2a986e2fe4ae206984b4d34ef37e8b795ebc4f4295c978373e6575e295d811
  languageName: node
  linkType: hard

"isexe@npm:^4.0.0":
  version: 4.0.0
  resolution: "isexe@npm:4.0.0"
  checksum: 10c0/5884815115bceac452877659a9c7726382531592f43dc29e5d48b7c4100661aed54018cb90bd36cb2eaeba521092570769167acbb95c18d39afdccbcca06c5ce
  languageName: node
  linkType: hard

"left-pad@npm:^1.3.0":
  version: 1.3.0
  resolution: "left-pad@npm:1.3.0"
  checksum: 10c0/3fb59c76e281a2f5c810ad71dbbb8eba8b10c6cf94733dc7f27b8c516a5376cacea53543e76f6ae477d866c8954b27f1e15ca349424c2542474eb5bb1d2b6955
  languageName: node
  linkType: hard

"lnk@link:./local::locator=root%40workspace%3A.":
  version: 0.0.0-use.local
  resolution: "lnk@link:./local::locator=root%40workspace%3A."
  languageName: node
  linkType: soft

"loc@portal:./local::locator=root%40workspace%3A.":
  version: 0.0.0-use.local
  resolution: "loc@portal:./local::locator=root%40workspace%3A."
  languageName: node
  linkType: soft

"micromatch@npm:^4.0.5":
  version: 4.0.8
  resolution: "micromatch@npm:4.0.8"
  dependencies:
    braces: "npm:^3.0.3"
    picomatch: "npm:^2.3.1"
  checksum: 10c0/166fa6eb926b9553f32ef81f5f531d27b4ce7da60e5baf8c021d043b27a388fb95e46a8038d5045877881e673f8134122b59624d5cecbd16eb50a42e7a6b5ca8
  languageName: node
  linkType: hard

"minipass@npm:^7.0.4, minipass@npm:^7.1.2":
  version: 7.1.3
  resolution: "minipass@npm:7.1.3"
  checksum: 10c0/539da88daca16533211ea5a9ee98dc62ff5742f531f54640dd34429e621955e91cc280a91a776026264b7f9f6735947629f920944e9c1558369e8bf22eb33fbb
  languageName: node
  linkType: hard

"minizlib@npm:^3.1.0":
  version: 3.1.0
  resolution: "minizlib@npm:3.1.0"
  dependencies:
    minipass: "npm:^7.1.2"
  checksum: 10c0/5aad75ab0090b8266069c9aabe582c021ae53eb33c6c691054a13a45db3b4f91a7fb1bd79151e6b4e9e9a86727b522527c0a06ec7d45206b745d54cd3097bcec
  languageName: node
  linkType: hard

"ms@npm:^2.1.3":
  version: 2.1.3
  resolution: "ms@npm:2.1.3"
  checksum: 10c0/d924b57e7312b3b63ad21fc5b3dc0af5e78d61a1fc7cfb5457edaf26326bf62be5307cc87ffb6862ef1c2b33b0233cdb5d4f01c4c958cc0d660948b65a287a48
  languageName: node
  linkType: hard

"node-gyp@npm:latest":
  version: 13.1.0
  resolution: "node-gyp@npm:13.1.0"
  dependencies:
    env-paths: "npm:^2.2.0"
    exponential-backoff: "npm:^3.1.1"
    graceful-fs: "npm:^4.2.6"
    nopt: "npm:^10.0.0"
    proc-log: "npm:^7.0.0"
    semver: "npm:^7.3.5"
    tar: "npm:^7.5.7"
    tinyglobby: "npm:^0.2.12"
    undici: "npm:^8.4.1"
    which: "npm:^7.0.0"
  bin:
    node-gyp: bin/node-gyp.js
  checksum: 10c0/c6693e52e0e111b21f5cd8ff303b41b51f40338adcc79ac5c6a02399eba7039d50dc816dcafcc485870291a641f7cb75db8887a9bdd0de537fe635a3a81cba5b
  languageName: node
  linkType: hard

"nopt@npm:^10.0.0":
  version: 10.0.1
  resolution: "nopt@npm:10.0.1"
  dependencies:
    abbrev: "npm:^5.0.0"
  bin:
    nopt: bin/nopt.js
  checksum: 10c0/980d89257f9587f3e1f77877ddbf905d6aa3b738ec33e49a4fa1a059a0dd82eb28063982b150654a7ae9de386f2ead60e56172db7d37cf56de545f7392a2a26a
  languageName: node
  linkType: hard

"normalize-path@npm:^3.0.0, normalize-path@npm:~3.0.0":
  version: 3.0.0
  resolution: "normalize-path@npm:3.0.0"
  checksum: 10c0/e008c8142bcc335b5e38cf0d63cfd39d6cf2d97480af9abdbe9a439221fd4d749763bab492a8ee708ce7a194bb00c9da6d0a115018672310850489137b3da046
  languageName: node
  linkType: hard

"picomatch@npm:^2.0.4, picomatch@npm:^2.2.1, picomatch@npm:^2.3.1":
  version: 2.3.2
  resolution: "picomatch@npm:2.3.2"
  checksum: 10c0/a554d1709e59be97d1acb9eaedbbc700a5c03dbd4579807baed95100b00420bc729335440ef15004ae2378984e2487a7c1cebd743cfdb72b6fa9ab69223c0d61
  languageName: node
  linkType: hard

"picomatch@npm:^4.0.4":
  version: 4.0.7
  resolution: "picomatch@npm:4.0.7"
  checksum: 10c0/beb6ae02c43ae44e84883b90830196d9046b1726ead292adcf7f57945e0bb0d992d68563d87e03b484b6f3c9a5c6defda7523477f047d7f0e663f126cc01787f
  languageName: node
  linkType: hard

"proc-log@npm:^7.0.0":
  version: 7.0.0
  resolution: "proc-log@npm:7.0.0"
  checksum: 10c0/b89c2d862604f35fec795477b0c7e376feab3ba0d4f4d291c4e959567442697cf451ac557d0623c1cc38af45a78128b983410f397a10c5d3a67f76c33de4754b
  languageName: node
  linkType: hard

"readdirp@npm:~3.6.0":
  version: 3.6.0
  resolution: "readdirp@npm:3.6.0"
  dependencies:
    picomatch: "npm:^2.2.1"
  checksum: 10c0/6fa848cf63d1b82ab4e985f4cf72bd55b7dcfd8e0a376905804e48c3634b7e749170940ba77b32804d5fe93b3cc521aa95a8d7e7d725f830da6d93f3669ce66b
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    chokidar: "npm:^3.6.0"
    fl: "file:./local"
    fsevents: "npm:^2.3.3"
    gitdep: "github:sindresorhus/is-plain-obj#v4.1.0"
    lnk: "link:./local"
    loc: "portal:./local"
    micromatch: "npm:^4.0.5"
    num: "npm:is-number@^7.0.0"
    tiny: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz"
    typescript: "npm:^5.4.0"
  dependenciesMeta:
    fsevents:
      optional: true
  languageName: unknown
  linkType: soft

"semver@npm:^7.3.5":
  version: 7.8.5
  resolution: "semver@npm:7.8.5"
  bin:
    semver: bin/semver.js
  checksum: 10c0/b1f3127a5be8125a94f37188b361c212466c292c6910adce3ec106cff5dc211ccaedc4739c11bb70fda59d6fc1f040a9bca289f4e093451521a2372e5231fe0c
  languageName: node
  linkType: hard

"tar@npm:^7.5.7":
  version: 7.5.22
  resolution: "tar@npm:7.5.22"
  dependencies:
    "@isaacs/fs-minipass": "npm:^4.0.0"
    chownr: "npm:^3.0.0"
    minipass: "npm:^7.1.2"
    minizlib: "npm:^3.1.0"
    yallist: "npm:^5.0.0"
  checksum: 10c0/1311f6be85a8157ac4c9147bae43e13923d2a1aae15e4aa1bd5239e4e03d2cf53cfe103dde7f35832fbb4c938b042856bc8e9a0afd29abd05e2d1608788c4fea
  languageName: node
  linkType: hard

"tiny@https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz":
  version: 7.0.0
  resolution: "tiny@https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz"
  checksum: 10c0/dac29d0c91d4e860f64fe57ffb52a8c57784158a0b7f9da8bad6289e25a99e775bfb1d4d438a3fe5373dc72414908ef9053de7250dc00a2e826830dcaa426896
  languageName: node
  linkType: hard

"tinyglobby@npm:^0.2.12":
  version: 0.2.17
  resolution: "tinyglobby@npm:0.2.17"
  dependencies:
    fdir: "npm:^6.5.0"
    picomatch: "npm:^4.0.4"
  checksum: 10c0/7f7bb0f197c88bc4b20c231e0deca4240ca3bf313a88f5a7fee93a872b84966a4d50220947c0455ad07a60b3b360961c5b7fd979222aeb716a9f99b412002e4c
  languageName: node
  linkType: hard

"to-regex-range@npm:^5.0.1":
  version: 5.0.1
  resolution: "to-regex-range@npm:5.0.1"
  dependencies:
    is-number: "npm:^7.0.0"
  checksum: 10c0/487988b0a19c654ff3e1961b87f471702e708fa8a8dd02a298ef16da7206692e8552a0250e8b3e8759270f62e9d8314616f6da274734d3b558b1fc7b7724e892
  languageName: node
  linkType: hard

"typescript@npm:^5.4.0":
  version: 5.9.3
  resolution: "typescript@npm:5.9.3"
  bin:
    tsc: bin/tsc
    tsserver: bin/tsserver
  checksum: 10c0/6bd7552ce39f97e711db5aa048f6f9995b53f1c52f7d8667c1abdc1700c68a76a308f579cd309ce6b53646deb4e9a1be7c813a93baaf0a28ccd536a30270e1c5
  languageName: node
  linkType: hard

"typescript@patch:typescript@npm%3A^5.4.0#optional!builtin<compat/typescript>":
  version: 5.9.3
  resolution: "typescript@patch:typescript@npm%3A5.9.3#optional!builtin<compat/typescript>::version=5.9.3&hash=5786d5"
  bin:
    tsc: bin/tsc
    tsserver: bin/tsserver
  checksum: 10c0/ad09fdf7a756814dce65bc60c1657b40d44451346858eea230e10f2e95a289d9183b6e32e5c11e95acc0ccc214b4f36289dcad4bf1886b0adb84d711d336a430
  languageName: node
  linkType: hard

"undici@npm:^8.4.1":
  version: 8.11.2
  resolution: "undici@npm:8.11.2"
  checksum: 10c0/106f6991178fb7562fd90cdec7993c5f807a9428682306091f0c4b27fc474ec291f868e29972c6252988bf061ad193df943b3b99e775be157a28d92bbb95699d
  languageName: node
  linkType: hard

"which@npm:^7.0.0":
  version: 7.0.0
  resolution: "which@npm:7.0.0"
  dependencies:
    isexe: "npm:^4.0.0"
  bin:
    node-which: bin/which.js
  checksum: 10c0/ca0b54f198f78bbc4b7c02e34bda8d335cb352e0adb4cbca1c37b1a957af3a879a82c4c27ca6525bc942f548d8b64f816ef6528360af9f3de55ffb9b979b620d
  languageName: node
  linkType: hard

"yallist@npm:^5.0.0":
  version: 5.0.0
  resolution: "yallist@npm:5.0.0"
  checksum: 10c0/a499c81ce6d4a1d260d4ea0f6d49ab4da09681e32c3f0472dee16667ed69d01dae63a3b81745a24bd78476ec4fcf856114cb4896ace738e01da34b2c42235416
  languageName: node
  linkType: hard
`;
const REAL_YARN_BERRY_MANIFEST = String.raw`{
 "name": "root",
 "version": "1.0.0",
 "private": true,
 "packageManager": "yarn@4.9.2",
 "workspaces": [
  "pkgs/*"
 ],
 "dependencies": {
  "chokidar": "^3.6.0",
  "fl": "file:./local",
  "gitdep": "github:sindresorhus/is-plain-obj#v4.1.0",
  "lnk": "link:./local",
  "loc": "portal:./local",
  "micromatch": "^4.0.5",
  "num": "npm:is-number@^7.0.0",
  "tiny": "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
  "typescript": "^5.4.0"
 },
 "optionalDependencies": {
  "fsevents": "^2.3.3"
 },
 "resolutions": {
  "braces": "3.0.3",
  "glob-parent": "5.1.2"
 }
}
`;

describe("yarn berry lockfile: reachable dependencies with no lock entry", () => {
  const manifest = JSON.parse(REAL_YARN_BERRY_MANIFEST) as {
    dependencies: Record<string, string>;
  };
  // file:, link: and portal: descriptors carry a ::locator suffix that the direct-dependency
  // lookup does not match yet (separate from this rule), so the complete-graph checks leave
  // them out and a separate check shows they never produce missing-entry evidence.
  const withoutLocal = {
    ...manifest,
    dependencies: Object.fromEntries(
      Object.entries(manifest.dependencies).filter(([n]) => !["fl", "lnk", "loc"].includes(n)),
    ),
  };
  const noLocal = (lock: string) => lock.replace(/^ {4}(?:fl|lnk|loc): .*\n/gm, "");
  const graphFor = (lock: string, man: unknown = withoutLocal) =>
    buildLockfileGraph(
      ctx(memoryHandle({ "package.json": JSON.stringify(man), "yarn.lock": lock })),
      project(),
    );
  const missing = (res: Awaited<ReturnType<typeof graphFor>>) =>
    res.evidence.find((e) => e.kind === "lockfile-unresolved-reachable");
  // Drop every non-workspace entry for `name`.
  const without = (name: string) =>
    REAL_YARN_BERRY_LOCK.replace(
      new RegExp(`^"${name}@(?!workspace)[^\\n]*\\n(?: {2}.*\\n)+\\n`, "gm"),
      "",
    );

  it("stays complete on a real yarn 4.9.2 lock with resolutions, alias, git, https and patch descriptors", async () => {
    const res = await graphFor(noLocal(REAL_YARN_BERRY_LOCK));
    assert.equal(res.graph.incomplete, false);
    assert.equal(missing(res), undefined);
    // micromatch asks for braces ^3.0.3, which resolutions rewrites to 3.0.3: no exact
    // descriptor, but the name is locked, so it is not a miss.
  });

  it("never reports file:, link:, portal:, workspace: or patch: descriptors as missing entries", async () => {
    const res = await graphFor(REAL_YARN_BERRY_LOCK, manifest);
    assert.equal(missing(res), undefined);
  });

  it("marks the graph incomplete when a reachable dependency's name has no entry at all", async () => {
    const broken = noLocal(without("picomatch"));
    assert.notEqual(broken, REAL_YARN_BERRY_LOCK);
    const res = await graphFor(broken);
    assert.equal(res.graph.incomplete, true);
    assert.match(missing(res)?.statement ?? "", /picomatch/);
  });

  it("does not judge a name that still has an entry under another descriptor", async () => {
    const partial = REAL_YARN_BERRY_LOCK.replace(
      /^"picomatch@npm:\^4\.0\.4":\n(?: {2}.*\n)+\n/m,
      "",
    );
    assert.notEqual(partial, REAL_YARN_BERRY_LOCK);
    assert.equal(missing(await graphFor(partial)), undefined);
  });

  it("exempts a dependency that dependenciesMeta flags optional", async () => {
    const broken = noLocal(without("readdirp"));
    assert.match(missing(await graphFor(broken))?.statement ?? "", /readdirp/);
    // chokidar already flags fsevents; add readdirp next to it.
    const flagged = broken.replace(
      /^("chokidar@npm:[^\n]*\n(?: {2}.*\n)*? {2}dependenciesMeta:\n)/m,
      "$1    readdirp:\n      optional: true\n",
    );
    assert.notEqual(flagged, broken);
    assert.equal(missing(await graphFor(flagged)), undefined);
  });
});

// Real bun 1.4.3 text lock (lockfileVersion 2): workspaces, an npm: alias, a file: dependency,
// an override, a workspace optional dependency that was never installed, and an auto-installed peer.
const REAL_BUN_LOCK = String.raw`{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "dependencies": {
        "fl": "file:./lfl",
        "micromatch": "^4.0.5",
        "num": "npm:is-number@^7.0.0",
        "wsa": "workspace:*",
      },
    },
    "pkgs/a": {
      "name": "wsa",
      "version": "1.0.0",
      "dependencies": {
        "ms": "^2.1.3",
        "wsb": "workspace:*",
      },
      "peerDependencies": {
        "react": "*",
      },
    },
    "pkgs/b": {
      "name": "wsb",
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^7.0.0",
      },
      "optionalDependencies": {
        "nonexistent-optional-pkg-xyz": "^1.0.0",
      },
    },
  },
  "overrides": {
    "braces": "3.0.3",
  },
  "packages": {
    "braces": ["braces@3.0.3", "", { "dependencies": { "fill-range": "^7.1.1" } }, "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA=="],

    "fill-range": ["fill-range@7.1.1", "", { "dependencies": { "to-regex-range": "^5.0.1" } }, "sha512-YsGpe3WHLK8ZYi4tWDg2Jy3ebRz2rXowDxnld4bkQB00cc/1Zw9AWnC0i9ztDJitivtQvaI9KaLyKrc+hBW0yg=="],

    "fl": ["fl@file:lfl", { "dependencies": { "is-odd": "^3.0.1" } }],

    "is-number": ["is-number@7.0.0", "", {}, "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=="],

    "is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA=="],

    "micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3.0.3", "picomatch": "^2.3.1" } }, "sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA=="],

    "ms": ["ms@2.1.3", "", {}, "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=="],

    "num": ["is-number@7.0.0", "", {}, "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=="],

    "picomatch": ["picomatch@2.3.2", "", {}, "sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA=="],

    "react": ["react@19.3.0", "", {}, "sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog=="],

    "to-regex-range": ["to-regex-range@5.0.1", "", { "dependencies": { "is-number": "^7.0.0" } }, "sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ=="],

    "wsa": ["wsa@workspace:pkgs/a"],

    "wsb": ["wsb@workspace:pkgs/b"],

    "is-odd/is-number": ["is-number@6.0.0", "", {}, "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg=="],
  }
}
`;

describe("bun lockfile: reachable dependencies with no package entry", () => {
  const manifest = {
    name: "root",
    dependencies: {
      micromatch: "^4.0.5",
      num: "npm:is-number@^7.0.0",
      fl: "file:./lfl",
    },
  };
  // A direct workspace: dependency is left without a package id (and so incomplete) by the
  // existing direct-dependency path, separately from this rule, so the root drops it here.
  const noRootWorkspace = (lock: string) => lock.replace(/^ {8}"wsa": "workspace:\*",\n/m, "");
  const graphFor = (lock: string, man: unknown = manifest) =>
    buildLockfileGraph(
      ctx(memoryHandle({ "package.json": JSON.stringify(man), "bun.lock": noRootWorkspace(lock) })),
      project(),
    );
  const missing = (res: Awaited<ReturnType<typeof graphFor>>) =>
    res.evidence.find((e) => e.kind === "lockfile-unresolved-reachable");
  const drop = (name: string) =>
    REAL_BUN_LOCK.replace(new RegExp(`^    "${name}": \\[.*\\n\\n`, "m"), "");
  const tuple = (meta: Record<string, unknown>) =>
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { name: "app", dependencies: { a: "^1" } } },
      packages: { a: ["a@1.0.0", "", meta, "sha512-demo"] },
    });
  const minimal = (meta: Record<string, unknown>) =>
    graphFor(tuple(meta), { name: "app", dependencies: { a: "^1" } });

  it("stays complete on a real bun lock with workspaces, alias, file:, override and a missing workspace optional", async () => {
    const res = await graphFor(REAL_BUN_LOCK);
    assert.equal(res.graph.incomplete, false);
    assert.equal(missing(res), undefined);
  });

  it("marks the graph incomplete when a reachable package's dependency has no package entry", async () => {
    const broken = drop("fill-range");
    assert.notEqual(broken, REAL_BUN_LOCK);
    const res = await graphFor(broken);
    assert.equal(res.graph.incomplete, true);
    assert.match(missing(res)?.statement ?? "", /fill-range/);
  });

  it("flags a required dependency of a package, not an optional one or a peer", async () => {
    const res = await minimal({ dependencies: { missing: "^1" } });
    assert.equal(res.graph.incomplete, true);
    assert.match(missing(res)?.statement ?? "", /missing/);
    const optional = await minimal({ optionalDependencies: { missing: "^1" } });
    assert.equal(optional.graph.incomplete, false);
    assert.equal(missing(optional), undefined);
    const both = await minimal({
      dependencies: { missing: "^1" },
      optionalDependencies: { missing: "^1" },
    });
    assert.equal(missing(both), undefined);
    const peer = await minimal({ peerDependencies: { missing: "^1" } });
    assert.equal(missing(peer), undefined);
  });

  it("ignores a missing dependency of a package no direct dependency reaches", async () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { name: "app", dependencies: { a: "^1" } } },
      packages: {
        a: ["a@1.0.0", "", {}, "sha512-demo"],
        orphan: ["orphan@1.0.0", "", { dependencies: { ghost: "^1" } }, "sha512-demo"],
      },
    });
    const res = await graphFor(lock, { name: "app", dependencies: { a: "^1" } });
    assert.equal(res.graph.incomplete, false);
  });

  it("resolves a dependency through a nested copy or the hoisted one and stays complete", async () => {
    const res = await graphFor(REAL_BUN_LOCK);
    // is-odd needs is-number ^6, held at the nested key is-odd/is-number.
    assert.equal(missing(res), undefined);
  });
});

// Real pnpm lockfiles for the same project (workspace link:, file:, npm: alias, an override):
// pnpm 12 writes v9.0 and pnpm 8 writes v6.0.
const REAL_PNPM_V9_LOCK = String.raw`lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      chokidar:
        specifier: ^3.6.0
        version: 3.6.0
      fl:
        specifier: file:./lfl
        version: file:lfl
      micromatch:
        specifier: ^4.0.5
        version: 4.0.8
      num:
        specifier: npm:is-number@^7.0.0
        version: is-number@7.0.0
      wsa:
        specifier: workspace:*
        version: link:pkgs/a

  pkgs/a:
    dependencies:
      ms:
        specifier: ^2.1.3
        version: 2.1.3

packages:

  anymatch@3.1.3:
    resolution: {integrity: sha512-KMReFUr0B4t+D+OBkjR3KYqvocp2XaSzO55UcB6mgQMd3KbcE+mWTyvVV7D/zsdEbNnV6acZUutkiHQXvTr1Rw==}
    engines: {node: '>= 8'}

  binary-extensions@2.3.0:
    resolution: {integrity: sha512-Ceh+7ox5qe7LJuLHoY0feh3pHuUDHAcRUeyL2VYghZwfpkNIy/+8Ocg0a3UuSoYzavmylwuLWQOf3hl0jjMMIw==}
    engines: {node: '>=8'}

  braces@3.0.3:
    resolution: {integrity: sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==}
    engines: {node: '>=8'}

  chokidar@3.6.0:
    resolution: {integrity: sha512-7VT13fmjotKpGipCW9JEQAusEPE+Ei8nl6/g4FBAmIm0GOOLMua9NDDo/DWp0ZAxCr3cPq5ZpBqmPAQgDda2Pw==}
    engines: {node: '>= 8.10.0'}

  fill-range@7.1.1:
    resolution: {integrity: sha512-YsGpe3WHLK8ZYi4tWDg2Jy3ebRz2rXowDxnld4bkQB00cc/1Zw9AWnC0i9ztDJitivtQvaI9KaLyKrc+hBW0yg==}
    engines: {node: '>=8'}

  fl@file:lfl:
    resolution: {directory: lfl, type: directory}

  fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  glob-parent@5.1.2:
    resolution: {integrity: sha512-AOIgSQCepiJYwP3ARnGx+5VnTu2HBYdzbGP45eLw1vr3zB3vZLeyed1sC9hnbcOc9/SrMyM5RPQrkGz4aS9Zow==}
    engines: {node: '>= 6'}

  is-binary-path@2.1.0:
    resolution: {integrity: sha512-ZMERYes6pDydyuGidse7OsHxtbI7WVeUEozgR/g7rd0xUimYNlvZRE/K2MgZTjWy725IfelLeVcEM97mmtRGXw==}
    engines: {node: '>=8'}

  is-extglob@2.1.1:
    resolution: {integrity: sha512-SbKbANkN603Vi4jEZv49LeVJMn4yGwsbzZworEoyEiutsN3nJYdbO36zfhGJ6QEDpOZIFkDtnq5JRxmvl3jsoQ==}
    engines: {node: '>=0.10.0'}

  is-glob@4.0.3:
    resolution: {integrity: sha512-xelSayHH36ZgE7ZWhli7pW34hNbNl8Ojv5KVmkJD4hBdD3th8Tfk9vYasLM+mXWOZhFkgZfxhLSnrwRr4elSSg==}
    engines: {node: '>=0.10.0'}

  is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}

  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

  is-odd@3.0.1:
    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}
    engines: {node: '>=4'}

  micromatch@4.0.8:
    resolution: {integrity: sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA==}
    engines: {node: '>=8.6'}

  ms@2.1.3:
    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}

  normalize-path@3.0.0:
    resolution: {integrity: sha512-6eZs5Ls3WtCisHWp9S2GUy8dqkpGi4BVSz3GaqiE6ezub0512ESztXUwUB6C6IKbQkY2Pnb/mD4WYojCRwcwLA==}
    engines: {node: '>=0.10.0'}

  picomatch@2.3.2:
    resolution: {integrity: sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==}
    engines: {node: '>=8.6'}

  readdirp@3.6.0:
    resolution: {integrity: sha512-hOS089on8RduqdbhvQ5Z37A0ESjsqz6qnRcffsMU3495FuTdqSm+7bhJ29JvIOsBDEEnan5DPu9t3To9VRlMzA==}
    engines: {node: '>=8.10.0'}

  to-regex-range@5.0.1:
    resolution: {integrity: sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ==}
    engines: {node: '>=8.0'}

snapshots:

  anymatch@3.1.3:
    dependencies:
      normalize-path: 3.0.0
      picomatch: 2.3.2

  binary-extensions@2.3.0: {}

  braces@3.0.3:
    dependencies:
      fill-range: 7.1.1

  chokidar@3.6.0:
    dependencies:
      anymatch: 3.1.3
      braces: 3.0.3
      glob-parent: 5.1.2
      is-binary-path: 2.1.0
      is-glob: 4.0.3
      normalize-path: 3.0.0
      readdirp: 3.6.0
    optionalDependencies:
      fsevents: 2.3.3

  fill-range@7.1.1:
    dependencies:
      to-regex-range: 5.0.1

  fl@file:lfl:
    dependencies:
      is-odd: 3.0.1

  fsevents@2.3.3:
    optional: true

  glob-parent@5.1.2:
    dependencies:
      is-glob: 4.0.3

  is-binary-path@2.1.0:
    dependencies:
      binary-extensions: 2.3.0

  is-extglob@2.1.1: {}

  is-glob@4.0.3:
    dependencies:
      is-extglob: 2.1.1

  is-number@6.0.0: {}

  is-number@7.0.0: {}

  is-odd@3.0.1:
    dependencies:
      is-number: 6.0.0

  micromatch@4.0.8:
    dependencies:
      braces: 3.0.3
      picomatch: 2.3.2

  ms@2.1.3: {}

  normalize-path@3.0.0: {}

  picomatch@2.3.2: {}

  readdirp@3.6.0:
    dependencies:
      picomatch: 2.3.2

  to-regex-range@5.0.1:
    dependencies:
      is-number: 7.0.0
`;
const REAL_PNPM_V6_LOCK = String.raw`lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  braces: 3.0.3

importers:

  .:
    dependencies:
      chokidar:
        specifier: ^3.6.0
        version: 3.6.0
      fl:
        specifier: file:./lfl
        version: file:lfl
      micromatch:
        specifier: ^4.0.5
        version: 4.0.8
      num:
        specifier: npm:is-number@^7.0.0
        version: /is-number@7.0.0
      wsa:
        specifier: workspace:*
        version: link:pkgs/a

  pkgs/a:
    dependencies:
      ms:
        specifier: ^2.1.3
        version: 2.1.3

packages:

  /anymatch@3.1.3:
    resolution: {integrity: sha512-KMReFUr0B4t+D+OBkjR3KYqvocp2XaSzO55UcB6mgQMd3KbcE+mWTyvVV7D/zsdEbNnV6acZUutkiHQXvTr1Rw==}
    engines: {node: '>= 8'}
    dependencies:
      normalize-path: 3.0.0
      picomatch: 2.3.2
    dev: false

  /binary-extensions@2.3.0:
    resolution: {integrity: sha512-Ceh+7ox5qe7LJuLHoY0feh3pHuUDHAcRUeyL2VYghZwfpkNIy/+8Ocg0a3UuSoYzavmylwuLWQOf3hl0jjMMIw==}
    engines: {node: '>=8'}
    dev: false

  /braces@3.0.3:
    resolution: {integrity: sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==}
    engines: {node: '>=8'}
    dependencies:
      fill-range: 7.1.1
    dev: false

  /chokidar@3.6.0:
    resolution: {integrity: sha512-7VT13fmjotKpGipCW9JEQAusEPE+Ei8nl6/g4FBAmIm0GOOLMua9NDDo/DWp0ZAxCr3cPq5ZpBqmPAQgDda2Pw==}
    engines: {node: '>= 8.10.0'}
    dependencies:
      anymatch: 3.1.3
      braces: 3.0.3
      glob-parent: 5.1.2
      is-binary-path: 2.1.0
      is-glob: 4.0.3
      normalize-path: 3.0.0
      readdirp: 3.6.0
    optionalDependencies:
      fsevents: 2.3.3
    dev: false

  /fill-range@7.1.1:
    resolution: {integrity: sha512-YsGpe3WHLK8ZYi4tWDg2Jy3ebRz2rXowDxnld4bkQB00cc/1Zw9AWnC0i9ztDJitivtQvaI9KaLyKrc+hBW0yg==}
    engines: {node: '>=8'}
    dependencies:
      to-regex-range: 5.0.1
    dev: false

  /fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]
    requiresBuild: true
    dev: false
    optional: true

  /glob-parent@5.1.2:
    resolution: {integrity: sha512-AOIgSQCepiJYwP3ARnGx+5VnTu2HBYdzbGP45eLw1vr3zB3vZLeyed1sC9hnbcOc9/SrMyM5RPQrkGz4aS9Zow==}
    engines: {node: '>= 6'}
    dependencies:
      is-glob: 4.0.3
    dev: false

  /is-binary-path@2.1.0:
    resolution: {integrity: sha512-ZMERYes6pDydyuGidse7OsHxtbI7WVeUEozgR/g7rd0xUimYNlvZRE/K2MgZTjWy725IfelLeVcEM97mmtRGXw==}
    engines: {node: '>=8'}
    dependencies:
      binary-extensions: 2.3.0
    dev: false

  /is-extglob@2.1.1:
    resolution: {integrity: sha512-SbKbANkN603Vi4jEZv49LeVJMn4yGwsbzZworEoyEiutsN3nJYdbO36zfhGJ6QEDpOZIFkDtnq5JRxmvl3jsoQ==}
    engines: {node: '>=0.10.0'}
    dev: false

  /is-glob@4.0.3:
    resolution: {integrity: sha512-xelSayHH36ZgE7ZWhli7pW34hNbNl8Ojv5KVmkJD4hBdD3th8Tfk9vYasLM+mXWOZhFkgZfxhLSnrwRr4elSSg==}
    engines: {node: '>=0.10.0'}
    dependencies:
      is-extglob: 2.1.1
    dev: false

  /is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}
    dev: false

  /is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}
    dev: false

  /is-odd@3.0.1:
    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}
    engines: {node: '>=4'}
    dependencies:
      is-number: 6.0.0
    dev: false

  /micromatch@4.0.8:
    resolution: {integrity: sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA==}
    engines: {node: '>=8.6'}
    dependencies:
      braces: 3.0.3
      picomatch: 2.3.2
    dev: false

  /ms@2.1.3:
    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}
    dev: false

  /normalize-path@3.0.0:
    resolution: {integrity: sha512-6eZs5Ls3WtCisHWp9S2GUy8dqkpGi4BVSz3GaqiE6ezub0512ESztXUwUB6C6IKbQkY2Pnb/mD4WYojCRwcwLA==}
    engines: {node: '>=0.10.0'}
    dev: false

  /picomatch@2.3.2:
    resolution: {integrity: sha512-V7+vQEJ06Z+c5tSye8S+nHUfI51xoXIXjHQ99cQtKUkQqqO1kO/KCJUfZXuB47h/YBlDhah2H3hdUGXn8ie0oA==}
    engines: {node: '>=8.6'}
    dev: false

  /readdirp@3.6.0:
    resolution: {integrity: sha512-hOS089on8RduqdbhvQ5Z37A0ESjsqz6qnRcffsMU3495FuTdqSm+7bhJ29JvIOsBDEEnan5DPu9t3To9VRlMzA==}
    engines: {node: '>=8.10.0'}
    dependencies:
      picomatch: 2.3.2
    dev: false

  /to-regex-range@5.0.1:
    resolution: {integrity: sha512-65P7iz6X5yEr1cwcgvQxbbIw7Uk3gOy5dIdtZ4rDveLqhrdJP+Li/Hx6tyK0NEb+2GCyneCMJiGqrADCSNk8sQ==}
    engines: {node: '>=8.0'}
    dependencies:
      is-number: 7.0.0
    dev: false

  file:lfl:
    resolution: {directory: lfl, type: directory}
    name: fl
    dependencies:
      is-odd: 3.0.1
    dev: false
`;

describe("pnpm lockfile: reachable dependencies with no package entry", () => {
  const manifest = {
    name: "root",
    dependencies: {
      chokidar: "^3.6.0",
      micromatch: "^4.0.5",
      num: "npm:is-number@^7.0.0",
      wsa: "workspace:*",
      fl: "file:./lfl",
    },
  };
  const graphFor = (lock: string, man: unknown = manifest) =>
    buildLockfileGraph(
      ctx(memoryHandle({ "package.json": JSON.stringify(man), "pnpm-lock.yaml": lock })),
      project(),
    );
  const missing = (res: Awaited<ReturnType<typeof graphFor>>) =>
    res.evidence.find((e) => e.kind === "lockfile-unresolved-reachable");
  // Remove one package block; for v9 only the snapshots copy, which holds the edges.
  const drop = (lock: string, key: string) => {
    const at = lock.indexOf("\nsnapshots:");
    const head = at < 0 ? "" : lock.slice(0, at);
    const body = at < 0 ? lock : lock.slice(at);
    return (
      head +
      body.replace(new RegExp(`^  ${key.replace(/[.+/]/g, "\\$&")}:\\n(?: {4}.*\\n)+\\n?`, "m"), "")
    );
  };
  const minimal = (version: 6 | 9, meta: string, extra = "") => {
    const key = version === 6 ? "/a@1.0.0" : "a@1.0.0";
    const table = version === 6 ? "packages" : "snapshots";
    return graphFor(
      `lockfileVersion: '${version}.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: ^1\n        version: 1.0.0\n${table}:\n  '${key}':\n${meta}${extra}`,
      { name: "app", dependencies: { a: "^1" } },
    );
  };

  for (const [label, lock, key] of [
    ["v9", REAL_PNPM_V9_LOCK, "fill-range@7.1.1"],
    ["v6", REAL_PNPM_V6_LOCK, "/fill-range@7.1.1"],
  ] as const) {
    it(`${label}: a real lock with a workspace link, file:, alias and override has no missing-entry evidence`, async () => {
      assert.equal(missing(await graphFor(lock)), undefined);
    });

    it(`${label}: the same lock is complete once the direct link:/file: roots are set aside`, async () => {
      // A direct link:/file: root gets no package id (separate from this rule), so the
      // complete-graph check leaves those two roots out.
      const trimmed = lock.replace(/^ {6}(?:fl|wsa):\n {8}specifier: .*\n {8}version: .*\n/gm, "");
      assert.notEqual(trimmed, lock);
      const deps = Object.fromEntries(
        Object.entries(manifest.dependencies).filter(([n]) => n !== "fl" && n !== "wsa"),
      );
      const res = await graphFor(trimmed, { name: "root", dependencies: deps });
      assert.equal(missing(res), undefined);
      assert.equal(res.graph.incomplete, false);
    });

    it(`${label}: removing a reachable package entry marks the graph incomplete by name`, async () => {
      const broken = drop(lock, key);
      assert.notEqual(broken, lock);
      const res = await graphFor(broken);
      assert.equal(res.graph.incomplete, true);
      assert.match(missing(res)?.statement ?? "", /fill-range/);
    });
  }

  for (const version of [6, 9] as const) {
    it(`v${version}: a required dependency with no entry flags; optional, both-listed, link: and file: do not`, async () => {
      const flagged = await minimal(version, "    dependencies:\n      missing: 1.0.0\n");
      assert.equal(flagged.graph.incomplete, true);
      assert.match(missing(flagged)?.statement ?? "", /missing/);
      for (const meta of [
        "    optionalDependencies:\n      missing: 1.0.0\n",
        "    dependencies:\n      missing: 1.0.0\n    optionalDependencies:\n      missing: 1.0.0\n",
        "    dependencies:\n      missing: link:../missing\n",
        "    dependencies:\n      missing: file:../missing\n",
      ]) {
        const res = await minimal(version, meta);
        assert.equal(missing(res), undefined, meta);
        assert.equal(res.graph.incomplete, false, meta);
      }
    });
  }
});
