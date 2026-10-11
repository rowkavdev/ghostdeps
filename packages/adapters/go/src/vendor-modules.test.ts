import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGoAdapter } from "./adapter.js";
import { parseVendorModules } from "./manifest.js";
import { memoryHandle } from "./testing/fs-handle.js";

// Go emits unused and wildcard replacements after the versioned module
// headers. These replacement records do not themselves name graph nodes.
const GENERATED_VENDOR = [
  "# example.com/used v1.0.0 => ./used",
  "## explicit; go 1.24",
  "example.com/used",
  "# example.com/used => ./used",
  "# example.com/unused => ./unused",
].join("\n");

describe("Go vendor replacement-only headers", () => {
  for (const target of ["./unused", "../shared", "example.com/fork v1.2.3"]) {
    it(`ignores a wildcard replacement to ${target}`, () => {
      assert.deepEqual(parseVendorModules(`# example.com/unused => ${target}`), []);
    });
  }

  it("reads versioned modules without turning wildcard footers into versions", () => {
    assert.deepEqual(parseVendorModules(GENERATED_VENDOR), [
      { path: "example.com/used", version: "v1.0.0" },
    ]);
  });

  it("retains ordinary, indirect and versioned replaced module headers", () => {
    assert.deepEqual(
      parseVendorModules(
        [
          "# example.com/plain v1.0.0",
          "## explicit; go 1.24",
          "example.com/plain/pkg",
          "# example.com/indirect v0.0.0-20200101000000-abcdefabcdef",
          "## go 1.24",
          "# example.com/local v2.0.0+incompatible => ../local",
          "# example.com/remote v1.1.0 => example.com/fork v1.2.3",
          "## workspace",
          "# => ./replacement-only",
        ].join("\n"),
      ),
      [
        { path: "example.com/plain", version: "v1.0.0" },
        { path: "example.com/indirect", version: "v0.0.0-20200101000000-abcdefabcdef" },
        { path: "example.com/local", version: "v2.0.0+incompatible" },
        { path: "example.com/remote", version: "v1.1.0" },
      ],
    );
  });

  it("keeps only required and versioned vendored graph nodes", async () => {
    const adapter = createGoAdapter();
    const context = {
      repository: memoryHandle({
        "go.mod": [
          "module example.com/app",
          "go 1.24",
          "require example.com/used v1.0.0",
          "replace example.com/used => ./used",
          "replace example.com/unused => ./unused",
        ].join("\n"),
        "vendor/modules.txt": GENERATED_VENDOR + "\n# example.com/transitive v1.5.0\n",
      }),
      network: { mode: "offline" as const },
    };
    const detection = await adapter.detect(context);
    const direct = await adapter.listDirectDependencies(context, detection.projects);
    assert.deepEqual(
      direct.map((d) => [d.name, d.constraint, d.specifier]),
      [["example.com/used", "v1.0.0", { type: "file", detail: "./used" }]],
    );
    const graphs = await adapter.buildDependencyGraph!(context, detection.projects);
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0]!.incomplete, true);
    assert.deepEqual(graphs[0]!.transitiveClosure, {});
    assert.deepEqual(graphs[0]!.nodes, [
      { name: "example.com/transitive", version: "v1.5.0", dependencies: [], dev: false },
      { name: "example.com/used", version: "v1.0.0", dependencies: [], dev: false },
    ]);
  });

  it("does not let a replacement-only footer add an absent versioned module", async () => {
    const adapter = createGoAdapter();
    const context = {
      repository: memoryHandle({
        "go.mod": "module example.com/app\ngo 1.24\n",
        "vendor/modules.txt": "# example.com/unused => example.com/fork v1.2.3\n",
      }),
      network: { mode: "offline" as const },
    };
    const detection = await adapter.detect(context);
    const graphs = await adapter.buildDependencyGraph!(context, detection.projects);
    assert.deepEqual(graphs[0]!.nodes, []);
    assert.equal(graphs[0]!.incomplete, true);
  });
});
