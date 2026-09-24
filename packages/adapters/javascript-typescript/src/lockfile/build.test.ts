import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ProjectRef } from "@ghostdeps/core";
import { FIXTURES_ROOT, fixtureHandle, memoryHandle } from "../testing/fs-handle.js";
import { buildLockfileGraph } from "./build.js";

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
