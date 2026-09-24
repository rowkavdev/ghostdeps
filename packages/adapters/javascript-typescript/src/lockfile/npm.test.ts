import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNpmLockfile } from "./npm.js";

describe("parseNpmLockfile v2/v3 missing package entries (#91)", () => {
  const declared = [
    { name: "present", dev: false },
    { name: "ghost", dev: false },
  ];
  const lock = (version: number) =>
    JSON.stringify({
      lockfileVersion: version,
      packages: {
        "": { dependencies: { present: "1", ghost: "1" } },
        "node_modules/present": { version: "1.0.0" },
      },
    });

  for (const version of [2, 3]) {
    it(`v${version}: a root-listed dep with no node_modules entry is a mismatch`, () => {
      const parsed = parseNpmLockfile(lock(version), "package-lock.json", "", declared);
      const mismatches = parsed.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch");
      assert.equal(mismatches.length, 1);
      assert.match(mismatches[0]!.statement, /^ghost is a direct dependency/);
      assert.equal(parsed.direct.find((d) => d.name === "ghost")?.id, undefined);
    });
  }

  it("does not double-report a dep missing from both the root entry and packages", () => {
    const parsed = parseNpmLockfile(
      JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
      "package-lock.json",
      "",
      [{ name: "stale", dev: false }],
    );
    const mismatches = parsed.evidence.filter((e) => e.kind === "lockfile-manifest-mismatch");
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0]!.statement, /lockfile is stale/);
  });
});
