import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchWorkspacePatterns } from "./pnpm-workspace.js";

const VITE = ["packages/*", "playground/**", "packages/**/__tests__/**", "docs"];

describe("matchWorkspacePatterns (#894)", () => {
  const kind = (patterns: string[], rel: string) => matchWorkspacePatterns(patterns, rel).kind;

  it("matches vite's workspace globs", () => {
    assert.equal(kind(VITE, "packages/vite"), "member");
    assert.equal(kind(VITE, "docs"), "member");
    assert.equal(kind(VITE, "playground/tailwind"), "member");
    assert.equal(kind(VITE, "playground/a/b"), "member");
    assert.equal(kind(VITE, "packages/vite/src/node/__tests__/packages/parent"), "member");
    assert.equal(kind(VITE, "packages/create-vite/template-react"), "nonmember");
    assert.equal(kind(VITE, "packages/create-vite/template-vue-ts"), "nonmember");
    assert.equal(kind(VITE, "scripts"), "nonmember");
  });

  it("treats negation as exclusion regardless of order", () => {
    assert.equal(kind(["packages/**", "!packages/legacy"], "packages/legacy"), "nonmember");
    assert.equal(kind(["!packages/legacy", "packages/**"], "packages/legacy"), "nonmember");
    assert.equal(kind(["packages/**", "!packages/legacy"], "packages/new"), "member");
    assert.equal(kind(["!packages/legacy", "packages/**"], "packages/new"), "member");
  });

  it("does not let wildcards match dot segments, but literal dot patterns match", () => {
    assert.equal(kind(["packages/*"], "packages/.hidden"), "nonmember");
    assert.equal(kind(["packages/?hidden"], "packages/.hidden"), "nonmember");
    assert.equal(kind(["packages/**"], "packages/.hidden"), "nonmember");
    assert.equal(kind(["packages/**"], "packages/a/.hidden/b"), "nonmember");
    assert.equal(kind(["packages/**"], "packages/a/b"), "member");
    assert.equal(kind([".github"], ".github"), "member");
    assert.equal(kind([".github/*"], ".github/x"), "member");
    assert.equal(kind(["packages/.hidden"], "packages/.hidden"), "member");
    assert.equal(kind(["packages/.*"], "packages/.hidden"), "member");
  });

  it("matches negated wildcards against dot segments (pnpm uses dot:true for exclusions)", () => {
    assert.equal(kind(["packages/*", "!packages/**"], "packages/a"), "nonmember");
    assert.equal(kind(["packages/*", "!packages/*"], "packages/.hidden"), "nonmember");
    assert.equal(kind(["packages/**", "!packages/**/x"], "packages/.hidden/x"), "nonmember");
  });

  it("leaves dot-segment includes unknown next to exclusions or **", () => {
    assert.equal(kind(["packages/.hidden/**", "!packages/**"], "packages/.hidden/a"), "unknown");
    assert.equal(kind(["!packages/**", "packages/.hidden"], "packages/.hidden"), "unknown");
    assert.equal(kind(["packages/**/.hidden"], "packages/a/.hidden"), "unknown");
    assert.equal(kind(["packages/**/.hidden"], "packages/.hidden"), "unknown");
    assert.equal(kind([".github/**"], ".github/x"), "unknown");
  });

  it("never counts a node_modules or bower_components path as a member", () => {
    assert.equal(kind(["packages/**"], "packages/a/node_modules/b"), "nonmember");
    assert.equal(kind(["**"], "node_modules/x"), "nonmember");
    assert.equal(kind(["packages/*/*"], "packages/bower_components/x"), "nonmember");
    assert.equal(kind(["packages/**"], "packages/tests/a"), "member");
  });

  it("tolerates ./ prefixes and trailing slashes", () => {
    assert.equal(kind(["./packages/*/"], "packages/a"), "member");
  });

  it("leaves unsupported glob syntax unknown instead of guessing", () => {
    for (const glob of [
      "/packages/*",
      "../packages/*",
      "!/packages/legacy",
      "packages/../x",
      "packages/{a,b}",
      "packages/[ab]",
      "packages/!(x)",
      "packages/@(a|b)",
    ]) {
      assert.equal(kind([glob], "packages/a"), "unknown", glob);
    }
  });
});

it("bounds repeated globstar matching in an isolated process", () => {
  const moduleUrl = new URL("./pnpm-workspace.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { matchWorkspacePatterns } from ${JSON.stringify(moduleUrl)};
    const pattern = "**/".repeat(18) + "no-match";
    const path = Array(25).fill("a").join("/");
    assert.equal(matchWorkspacePatterns([pattern], path).kind, "nonmember");
    assert.equal(matchWorkspacePatterns(["**/".repeat(18) + "a"], path).kind, "member");
    assert.equal(matchWorkspacePatterns(["**/".repeat(18) + "a"], ".hidden/" + path).kind, "nonmember");
  `,
    ],
    { timeout: 1500 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
});

it("leaves excessive matching work unknown rather than guessing or overflowing the stack", () => {
  const pattern = Array(1000).fill("a").join("/");
  const path = Array(1000).fill("a").join("/");
  assert.equal(matchWorkspacePatterns([pattern], path).kind, "unknown");
});

it("bounds stars inside one segment in an isolated process", () => {
  const moduleUrl = new URL("./pnpm-workspace.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { matchWorkspacePatterns } from ${JSON.stringify(moduleUrl)};
    assert.equal(matchWorkspacePatterns(["a*".repeat(30) + "X"], "a".repeat(100)).kind, "nonmember");
    assert.equal(matchWorkspacePatterns(["a*".repeat(30)], "a".repeat(100)).kind, "member");
  `,
    ],
    { timeout: 1500 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
});
