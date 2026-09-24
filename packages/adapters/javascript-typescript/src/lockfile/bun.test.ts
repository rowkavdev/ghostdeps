import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBunLockfile, stripTrailingCommas } from "./bun.js";

describe("stripTrailingCommas", () => {
  it("removes trailing commas but never touches strings", () => {
    const text = `{ "a": [1, 2, ], "b": "x, }", "c": "q\\", ]", }`;
    assert.deepEqual(JSON.parse(stripTrailingCommas(text)), { a: [1, 2], b: "x, }", c: 'q", ]' });
  });
});

describe("parseBunLockfile", () => {
  const declared = [{ name: "@s/a", dev: false }];

  it("resolves nested copies under scoped packages before hoisted ones", () => {
    const text = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { dependencies: { "@s/a": "1" } } },
      packages: {
        "@s/a": ["@s/a@1.0.0", "", { dependencies: { b: "2" } }, "x"],
        "@s/a/b": ["b@2.0.0", "", {}, "x"],
        b: ["b@1.0.0", "", {}, "x"],
      },
    });
    const parsed = parseBunLockfile(text, "bun.lock", ".", declared);
    assert.deepEqual(parsed.packages.get("@s/a")?.dependencies, ["@s/a/b"]);
    assert.equal(parsed.direct[0]?.id, "@s/a");
  });

  it("degrades on malformed shapes instead of crashing or trusting them", () => {
    assert.throws(() => parseBunLockfile(`{ "packages": {`, "bun.lock", ".", declared));
    const arrayPackages = parseBunLockfile(
      JSON.stringify({ workspaces: { "": { dependencies: { "@s/a": "1" } } }, packages: [] }),
      "bun.lock",
      ".",
      declared,
    );
    assert.equal(arrayPackages.packages.size, 0);
    assert.equal(arrayPackages.direct[0]?.id, undefined);
    const badHeads = parseBunLockfile(
      JSON.stringify({
        workspaces: { "": { dependencies: { "@s/a": "1" } } },
        packages: { "@s/a": [42, "", {}], x: "not-an-array", y: [] },
      }),
      "bun.lock",
      ".",
      declared,
    );
    assert.equal(badHeads.packages.size, 0);
    assert.equal(badHeads.direct[0]?.id, undefined);
  });

  it("missing workspace entry is reported as a mismatch", () => {
    const parsed = parseBunLockfile(
      JSON.stringify({ workspaces: {}, packages: {} }),
      "bun.lock",
      ".",
      declared,
    );
    assert.ok(parsed.evidence.some((e) => e.kind === "lockfile-manifest-mismatch"));
  });
});
