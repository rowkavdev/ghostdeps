import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { normaliseUsageResult } from "@ghostdeps/core";
import type { AdapterContext, Dependency } from "@ghostdeps/core";
import { createGoAdapter } from "../adapter.js";
import { FIXTURES_ROOT, fixtureHandle, memoryHandle } from "../testing/fs-handle.js";
import { defaultPackageName, extractGoImports } from "./imports.js";
import { MAX_GO_SOURCE_BYTES, owningModule } from "./scan.js";

type ExpectedUsage = { file: string; line: number; symbols: string[]; via?: string };

const FIXTURES = ["single-module", "multi-module", "vendored", "replace-exclude", "import-forms"];

describe("Go usage against fixtures/go expected usages", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      const exp = JSON.parse(
        readFileSync(path.join(FIXTURES_ROOT, "go", name, "expected.json"), "utf8"),
      ) as { usages: Record<string, ExpectedUsage[]> };
      const adapter = createGoAdapter();
      const context: AdapterContext = {
        repository: fixtureHandle("go", name),
        network: { mode: "offline" },
      };
      const detection = await adapter.detect(context);
      const deps = await adapter.listDirectDependencies(context, detection.projects);
      const graphs = await adapter.buildDependencyGraph!(context, detection.projects);
      for (const [module, want] of Object.entries(exp.usages)) {
        // Indirect modules are not direct dependencies; probe them as the graph lists them.
        const dep: Dependency =
          deps.find((d) => d.name === module) ??
          ({
            name: module,
            constraint: "*",
            kind: "runtime",
            project: graphs.find((g) => g.nodes.some((n) => n.name === module))!.project,
            declaredIn: "go.mod",
          } satisfies Dependency);
        const { usages } = normaliseUsageResult(await adapter.findUsage!(context, dep));
        assert.deepEqual(
          usages.map((u) => ({
            file: u.file,
            line: u.line,
            symbols: u.symbols,
            ...(u.via && u.via !== "import" ? { via: u.via } : {}),
          })),
          want,
          `${name}: ${module}`,
        );
      }
    });
  }
});

describe("extractGoImports", () => {
  it("reads single, grouped, aliased, blank and dot imports", () => {
    const r = extractGoImports(
      [
        "// Package x.",
        "package x",
        "",
        'import "fmt"',
        "import (",
        '\ty "gopkg.in/yaml.v3"',
        '\t_ "github.com/lib/pq"',
        '\t. "example.com/dot"',
        "",
        '\t"example.com/plain" // trailing',
        ")",
        "",
        "func f() { y.Marshal(nil); fmt.Println(); plain.Do(); s.plain.Not() }",
      ].join("\n"),
    );
    assert.deepEqual(r.imports, [
      { path: "fmt", line: 4 },
      { path: "gopkg.in/yaml.v3", line: 6, alias: "y" },
      { path: "github.com/lib/pq", line: 7, alias: "_" },
      { path: "example.com/dot", line: 8, alias: "." },
      { path: "example.com/plain", line: 10 },
    ]);
    assert.deepEqual([...(r.selectors.get("plain") ?? [])], ["Do"]);
    assert.deepEqual([...(r.selectors.get("y") ?? [])], ["Marshal"]);
  });

  it("ignores imports inside comments, strings and after the first declaration", () => {
    const r = extractGoImports(
      [
        "package x",
        '/* import "a.example/c1" */',
        '// import "a.example/c2"',
        'import "a.example/real"',
        'var s = `import "a.example/raw"`',
        'import "a.example/late"',
      ].join("\n"),
    );
    assert.deepEqual(
      r.imports.map((i) => i.path),
      ["a.example/real"],
    );
  });

  it("returns nothing for a file without a package clause", () => {
    assert.deepEqual(extractGoImports('import "a.example/x"').imports, []);
  });

  it("counts lines across multi-line comments and raw strings", () => {
    const r = extractGoImports(
      ["package x", "/*", "multi", "*/", "import (", "\t`a.example/raw-path`", ")"].join("\n"),
    );
    assert.deepEqual(r.imports, [{ path: "a.example/raw-path", line: 6 }]);
  });
});

describe("module and package name mapping", () => {
  it("owningModule picks the longest matching module path", () => {
    const mods = ["github.com/a/b", "github.com/a/b/sub", "github.com/a/bc"];
    assert.equal(owningModule("github.com/a/b/sub/pkg", mods), "github.com/a/b/sub");
    assert.equal(owningModule("github.com/a/b/other", mods), "github.com/a/b");
    assert.equal(owningModule("github.com/a/bc", mods), "github.com/a/bc");
    assert.equal(owningModule("github.com/a/bcd", mods), undefined);
  });

  it("defaultPackageName follows the common conventions", () => {
    assert.equal(defaultPackageName("github.com/go-chi/chi/v5"), "chi");
    assert.equal(defaultPackageName("gopkg.in/yaml.v3"), "yaml");
    assert.equal(defaultPackageName("github.com/mattn/go-isatty"), "isatty");
    assert.equal(defaultPackageName("github.com/google/uuid"), "uuid");
  });
});

describe("PR mode", () => {
  it("reports removed import lines as removedInPr usages", async () => {
    const adapter = createGoAdapter();
    const context: AdapterContext = {
      repository: memoryHandle({
        "go.mod": "module m\nrequire github.com/pkg/errors v0.9.1\n",
        "main.go": "package main\n",
      }),
      network: { mode: "offline" },
      pullRequestSourceChanges: [
        {
          path: "main.go",
          removedLines: [{ line: 3, text: '\t"github.com/pkg/errors"' }],
          addedLines: [],
        },
        {
          path: "vendor/x/y.go",
          removedLines: [{ line: 1, text: '"github.com/pkg/errors"' }],
          addedLines: [],
        },
      ],
    };
    const [dep] = await adapter.listDirectDependencies(
      context,
      (await adapter.detect(context)).projects,
    );
    const { usages } = normaliseUsageResult(await adapter.findUsage!(context, dep!));
    assert.deepEqual(
      usages.map((u) => [u.file, u.line, u.removedInPr]),
      [["main.go", 3, true]],
    );
  });
});

describe("scan limits", () => {
  const dep = (context: AdapterContext): Promise<Dependency> =>
    (async () => {
      const adapter = createGoAdapter();
      const [d] = await adapter.listDirectDependencies(
        context,
        (await adapter.detect(context)).projects,
      );
      return d!;
    })();

  it("skips .go files over MAX_GO_SOURCE_BYTES instead of lexing them", async () => {
    const big =
      'package main\nimport "github.com/pkg/errors"\n' +
      "// pad\n".repeat(MAX_GO_SOURCE_BYTES / 7 + 1);
    const context: AdapterContext = {
      repository: memoryHandle({
        "go.mod": "module m\nrequire github.com/pkg/errors v0.9.1\n",
        "big.go": big,
        "small.go": 'package main\nimport "github.com/pkg/errors"\n',
      }),
      network: { mode: "offline" },
    };
    const { usages } = normaliseUsageResult(
      await createGoAdapter().findUsage!(context, await dep(context)),
    );
    assert.deepEqual(
      usages.map((u) => u.file),
      ["small.go"],
    );
  });

  it("throws on abort and does not cache the partial scan", async () => {
    const files = {
      "go.mod": "module m\nrequire github.com/pkg/errors v0.9.1\n",
      "a.go": 'package main\nimport "github.com/pkg/errors"\n',
    };
    const repository = memoryHandle(files);
    const controller = new AbortController();
    const aborted: AdapterContext = {
      repository,
      network: { mode: "offline" },
      signal: controller.signal,
    };
    const d = await dep(aborted);
    controller.abort();
    await assert.rejects(createGoAdapter().findUsage!(aborted, d));
    const fresh: AdapterContext = { repository, network: { mode: "offline" } };
    const { usages } = normaliseUsageResult(await createGoAdapter().findUsage!(fresh, d));
    assert.deepEqual(
      usages.map((u) => u.file),
      ["a.go"],
    );
  });
});
