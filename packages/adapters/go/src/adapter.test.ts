import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runAdapterContractTests } from "@ghostdeps/core";
import type { AdapterContext } from "@ghostdeps/core";
import { createGoAdapter } from "./adapter.js";
import { FIXTURES_ROOT, fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

interface Expected {
  detection: { minConfidence: number; projects: string[] };
  dependencies: {
    name: string;
    kind: string;
    constraint: string;
    declaredIn: string;
    specifier?: { type: string; detail?: string };
  }[];
  graph?: { incomplete: boolean; nodes: string[]; indirect: string[] };
}

const FIXTURES = [
  "single-module",
  "multi-module",
  "vendored",
  "replace-exclude",
  "import-forms",
  "malformed-gomod",
];

const ctx = (name: string): AdapterContext => ({
  repository: fixtureHandle("go", name),
  network: { mode: "offline" },
});
const expected = (name: string): Expected =>
  JSON.parse(readFileSync(path.join(FIXTURES_ROOT, "go", name, "expected.json"), "utf8"));

describe("Go adapter against fixtures/go", () => {
  const adapter = createGoAdapter();
  for (const name of FIXTURES) {
    it(`${name}: detection and direct dependencies match expected.json`, async () => {
      const exp = expected(name);
      const detection = await adapter.detect(ctx(name));
      assert.ok(detection.confidence >= exp.detection.minConfidence);
      assert.deepEqual(
        detection.projects.map((p) => p.path).sort(),
        [...exp.detection.projects].sort(),
      );
      const deps = await adapter.listDirectDependencies(ctx(name), detection.projects);
      const got = deps
        .map((d) => ({
          name: d.name,
          kind: d.kind,
          constraint: d.constraint,
          declaredIn: d.declaredIn,
          ...(d.specifier ? { specifier: d.specifier } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const want = [...exp.dependencies].sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(got, want);
    });

    it(`${name}: graph lists every required module, marked incomplete`, async () => {
      const exp = expected(name);
      const detection = await adapter.detect(ctx(name));
      const graphs = await adapter.buildDependencyGraph!(ctx(name), detection.projects);
      assert.equal(graphs.length, detection.projects.length);
      assert.ok(graphs.every((g) => g.incomplete));
      assert.ok(graphs.every((g) => g.nodes.every((n) => n.dependencies.length === 0)));
      if (exp.graph) {
        const root = graphs.find((g) => g.project.path === ".")!;
        assert.deepEqual(
          root.nodes.map((n) => n.name),
          exp.graph.nodes,
        );
        const direct = new Set(exp.dependencies.map((d) => d.name));
        for (const ind of exp.graph.indirect) assert.ok(!direct.has(ind));
      }
    });
  }

  it("states the edgeless graph as evidence", async () => {
    const detection = await adapter.detect(ctx("single-module"));
    assert.ok(detection.evidence.some((e) => e.kind === "graph-edges-unavailable"));
  });

  it("states malformed go.mod lines as evidence with file and line", async () => {
    const detection = await adapter.detect(ctx("malformed-gomod"));
    const bad = detection.evidence.filter((e) => e.kind === "manifest-malformed");
    assert.deepEqual(
      bad.map((e) => [e.file, e.line]),
      [
        ["go.mod", 7],
        ["go.mod", 8],
      ],
    );
  });

  it("ignores go.mod files under vendor/, testdata/ and dot/underscore dirs", async () => {
    const mod = "module x\n";
    const detection = await adapter.detect({
      repository: memoryHandle({
        "go.mod": "module root\n",
        "vendor/example.com/v/go.mod": mod,
        "internal/testdata/t/go.mod": mod,
        ".hidden/go.mod": mod,
        "_old/go.mod": mod,
        "tools/go.mod": mod,
      }),
      network: { mode: "offline" },
    });
    assert.deepEqual(
      detection.projects.map((p) => p.path),
      [".", "tools"],
    );
  });

  it("stays below the detection threshold with loose .go files only", async () => {
    const detection = await adapter.detect({
      repository: memoryHandle({ "main.go": "package main\n" }),
      network: { mode: "offline" },
    });
    assert.ok(detection.confidence < 0.5);
    assert.deepEqual(detection.projects, []);
  });

  it("records go.sum as the lockfile when present", async () => {
    const detection = await adapter.detect(ctx("single-module"));
    assert.deepEqual(detection.projects[0]!.packageManagers, [
      { name: "go-modules", lockfile: "go.sum" },
    ]);
  });

  it("an exact-version replace wins over a version-less one", async () => {
    const context: AdapterContext = {
      repository: memoryHandle({
        "go.mod": [
          "module m",
          "require a.example/x v1.2.0",
          "replace a.example/x => ./any",
          "replace a.example/x v1.2.0 => ./exact",
        ].join("\n"),
      }),
      network: { mode: "offline" },
    };
    const detection = await adapter.detect(context);
    const deps = await adapter.listDirectDependencies(context, detection.projects);
    assert.deepEqual(deps[0]!.specifier, { type: "file", detail: "./exact" });
  });
});

for (const name of FIXTURES) runAdapterContractTests(createGoAdapter(), ctx(name));

describe("Go declaration lines (#198)", () => {
  const adapter = createGoAdapter();
  // Same whole-token check core applies before keeping a declaredLine.
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const onLine = (text: string, name: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9._/@-])${escape(name)}([^A-Za-z0-9._/-]|$)`).test(text);

  for (const name of FIXTURES) {
    it(`${name}: every declaredLine is a go.mod line naming the dependency`, async () => {
      const context = ctx(name);
      const detection = await adapter.detect(context);
      const deps = await adapter.listDirectDependencies(context, detection.projects);
      for (const d of deps) {
        assert.ok(d.declaredLine !== undefined, `${d.name} has a line`);
        const text = (await context.repository.readFile(d.declaredIn)).split(/\r?\n/);
        assert.ok(
          onLine(text[d.declaredLine - 1] ?? "", d.name),
          `${d.name} line ${d.declaredLine}`,
        );
      }
    });
  }

  it("reports the line for single-line and block requires", async () => {
    const context: AdapterContext = {
      repository: memoryHandle({
        "go.mod": [
          "module example.com/m",
          "",
          "require example.com/one v1.0.0",
          "",
          "require (",
          "\texample.com/two v1.0.0",
          '\t"example.com/three" v1.0.0',
          "\t`example.com/four` v1.0.0",
          ")",
          "",
        ].join("\n"),
      }),
      network: { mode: "offline" },
    };
    const detection = await adapter.detect(context);
    const deps = await adapter.listDirectDependencies(context, detection.projects);
    assert.deepEqual(Object.fromEntries(deps.map((d) => [d.name, d.declaredLine])), {
      "example.com/one": 3,
      "example.com/two": 6,
      "example.com/three": 7,
      "example.com/four": 8,
    });
  });

  it("gives no line when an escaped path does not appear as written", async () => {
    const context: AdapterContext = {
      repository: memoryHandle({
        "go.mod": 'module example.com/m\n\nrequire "example.com/\\esc" v1.0.0\n',
      }),
      network: { mode: "offline" },
    };
    const detection = await adapter.detect(context);
    const [dep] = await adapter.listDirectDependencies(context, detection.projects);
    assert.equal(dep?.name, "example.com/esc");
    assert.ok(!("declaredLine" in dep!));
  });
});
