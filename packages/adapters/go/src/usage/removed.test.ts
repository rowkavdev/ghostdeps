import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterContext, SourceLineChanges } from "@ghostdeps/core";
import { createGoAdapter } from "../adapter.js";
import { memoryHandle } from "../testing/fs-handle.js";
import { MAX_GO_SOURCE_BYTES } from "./scan.js";

const moduleText = "module example.com/root\nrequire github.com/pkg/errors v0.9.1\n";
async function usages(files: Record<string, string>, changes: SourceLineChanges[]) {
  const adapter = createGoAdapter();
  const context: AdapterContext = {
    repository: memoryHandle({ "go.mod": moduleText, ...files }),
    network: { mode: "offline" },
    pullRequestSourceChanges: changes,
  };
  const deps = await adapter.listDirectDependencies(
    context,
    (await adapter.detect(context)).projects,
  );
  return Promise.all(
    deps.map(async (dep) => ({
      project: dep.project.path,
      usages: await adapter.findUsage!(context, dep),
    })),
  );
}
const change = (path: string, lines: string[]): SourceLineChanges => ({
  path,
  removedLines: lines.map((text, i) => ({ line: i + 1, text })),
  addedLines: [],
});

test("removed comments and ordinary strings are not import evidence", async () => {
  const [result] = await usages({}, [
    change("deleted.go", [
      "package main",
      '// import "github.com/pkg/errors"',
      'var name = "github.com/pkg/errors"',
    ]),
  ]);
  assert.deepEqual(result!.usages, []);
});

test("deleted imports belong only to the nearest module and decode Go escapes", async () => {
  const results = await usages({ "nested/go.mod": moduleText.replace("root", "nested") }, [
    change("nested/deleted.go", ["package main", 'import "github.com/pkg/\\x65rrors"']),
  ]);
  assert.deepEqual(
    results.map((r) => [r.project, r.usages]),
    [
      [".", []],
      [
        "nested",
        [
          {
            dependency: "github.com/pkg/errors",
            file: "nested/deleted.go",
            line: 2,
            form: "static",
            via: "import",
            symbols: [],
            removedInPr: true,
          },
        ],
      ],
    ],
  );
});

test("removed grouped imports reconstruct the base and ignore malformed diffs", async () => {
  const head = "package main\nimport (\n)\n";
  const [result] = await usages({ "main.go": head }, [
    {
      path: "main.go",
      removedLines: [{ line: 3, text: '"github.com/pkg/errors"' }],
      addedLines: [],
    },
  ]);
  assert.equal((result!.usages as unknown[]).length, 1);
  const [malformed] = await usages({ "main.go": "package main\n" }, [
    {
      path: "main.go",
      removedLines: [{ line: 100, text: 'import "github.com/pkg/errors"' }],
      addedLines: [],
    },
  ]);
  assert.deepEqual(malformed!.usages, []);
});

test("reconstructed base UTF-8 bytes include head and removed text", async () => {
  const head = "package main\n//" + "é".repeat(300_000);
  const [result] = await usages({ "main.go": head }, [
    {
      path: "main.go",
      removedLines: [
        { line: 2, text: 'import "github.com/pkg/errors"' },
        { line: 3, text: "//" + "é".repeat(300_000) },
      ],
      addedLines: [],
    },
  ]);
  assert.deepEqual(result!.usages, []);
});

test("deleted reconstructed base byte cap is inclusive including newlines", async () => {
  for (const size of [MAX_GO_SOURCE_BYTES - 1, MAX_GO_SOURCE_BYTES, MAX_GO_SOURCE_BYTES + 1]) {
    const prefix = 'package main\nimport "github.com/pkg/errors"\n//';
    const source = prefix + "x".repeat(size - Buffer.byteLength(prefix));
    const [result] = await usages({}, [change("deleted.go", source.split("\n"))]);
    assert.equal(
      (result!.usages as unknown[]).length,
      size <= MAX_GO_SOURCE_BYTES ? 1 : 0,
      String(size),
    );
  }
});

test("removed UTF-8 payload cap survives the #860 follow-up", async () => {
  const [result] = await usages({}, [
    change("deleted.go", [
      "package main",
      'import "github.com/pkg/errors"',
      "//" + "é".repeat(500_000),
    ]),
  ]);
  assert.deepEqual(result!.usages, []);
});
