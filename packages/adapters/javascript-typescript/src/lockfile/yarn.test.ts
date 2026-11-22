import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleGraph } from "./model.js";
import { parseYarnLockfile, readClassicLockfile } from "./yarn.js";

describe("yarn classic reader", () => {
  it("a __proto__ field is stored as data, never as a prototype", () => {
    const text = [
      "a@^1.0.0:",
      '  version "1.0.0"',
      "  __proto__:",
      '    version "9.9.9"',
      '    dependencies "evil"',
      "",
    ].join("\n");
    const entry = readClassicLockfile(text).get("a@^1.0.0")!;
    assert.equal(entry.version, "1.0.0");
    assert.equal(Object.getPrototypeOf(entry), null);
    assert.equal(entry.dependencies, undefined);
    const parsed = parseYarnLockfile(text, "yarn.lock", ".", [
      { name: "a", dev: false, constraint: "^1.0.0" },
    ]);
    const pkg = [...parsed.packages.values()][0]!;
    assert.deepEqual([pkg.version, pkg.dependencies], ["1.0.0", []]);
  });

  it("a classic entry literally named __metadata is not treated as Berry YAML", () => {
    const text = ['"__metadata@^1.0.0":', '  version "1.0.0"', ""].join("\n");
    const parsed = parseYarnLockfile(text, "yarn.lock", ".", [
      { name: "__metadata", dev: false, constraint: "^1.0.0" },
    ]);
    assert.equal(parsed.direct[0]?.id, "__metadata@^1.0.0");
  });
});

it("does not split commas inside quoted Yarn classic patterns", () => {
  const range = "https://example.com/pkg?x=a,b";
  const text = `"demo@${range}", demo@^1:\n  version "1.0.0"\n`;
  const parsed = parseYarnLockfile(text, "yarn.lock", ".", [
    { name: "demo", dev: false, constraint: range },
  ]);
  assert.equal(parsed.direct[0]?.id, `demo@${range}`);
  assert.equal(parsed.evidence.length, 0);
  assert.equal([...parsed.packages.values()][0]?.name, "demo");
});

it("keeps commas in Berry workspace descriptors and still reads grouped descriptors", () => {
  // The workspace path case comes from Yarn 4.9.2's generated lockfile.
  const text = `__metadata:
  version: 8
"root@workspace:.":
  resolution: "root@workspace:."
  dependencies:
    thing: "workspace:packages/local,here"
    spaced: "workspace:packages/local, here"
    alias: "npm:@s/demo@^1"
"thing@workspace:packages/local,here":
  version: 0.0.0-use.local
  resolution: "thing@workspace:packages/local,here"
"spaced@workspace:*, spaced@workspace:packages/local, here":
  version: 0.0.0-use.local
  resolution: "spaced@workspace:packages/local, here"
"@s/demo@npm:1.0.0, alias@npm:@s/demo@^1":
  version: 1.0.0
  resolution: "@s/demo@npm:1.0.0"
`;
  const parsed = parseYarnLockfile(text, "yarn.lock", ".", [
    { name: "thing", dev: false, constraint: "workspace:packages/local,here" },
    { name: "spaced", dev: false, constraint: "workspace:packages/local, here" },
    { name: "alias", dev: false, constraint: "npm:@s/demo@^1" },
  ]);
  const { graph } = assembleGraph(
    { path: ".", ecosystem: "javascript-typescript", packageManagers: [] },
    parsed,
  );
  assert.equal(graph.incomplete, false);
  assert.deepEqual(
    graph.nodes.map((node) => node.name),
    ["@s/demo", "spaced", "thing"],
  );
});
