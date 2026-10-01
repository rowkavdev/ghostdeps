import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
