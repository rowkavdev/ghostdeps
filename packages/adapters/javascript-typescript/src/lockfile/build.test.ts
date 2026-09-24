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
    assert.deepEqual(res.graph.transitiveClosure, { a: [] });
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
    assert.deepEqual(res.graph.transitiveClosure, { a: [], added: [] });
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
    assert.deepEqual(res.graph.transitiveClosure, { shared: [], lodash: [] });
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
    assert.deepEqual(res.graph.transitiveClosure, { x: [] });
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
