import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSpecifier } from "./specifier.js";

describe("parseSpecifier", () => {
  it("maps bare and subpath specifiers to the package name", () => {
    assert.deepEqual(parseSpecifier("lodash"), { kind: "package", packageName: "lodash" });
    assert.deepEqual(parseSpecifier("lodash/get"), {
      kind: "package",
      packageName: "lodash",
      subpath: "get",
    });
  });

  it("handles scoped packages and scoped subpaths", () => {
    assert.equal(parseSpecifier("@babel/core").packageName, "@babel/core");
    assert.deepEqual(parseSpecifier("@scope/pkg/deep/path.js"), {
      kind: "package",
      packageName: "@scope/pkg",
      subpath: "deep/path.js",
    });
  });

  it("recognises Node built-ins with and without the node: prefix", () => {
    for (const s of ["fs", "node:fs", "fs/promises", "node:test", "path"]) {
      assert.equal(parseSpecifier(s).kind, "builtin", s);
    }
  });

  it("does not mistake paths, subpath imports or URLs for packages", () => {
    assert.equal(parseSpecifier("./util").kind, "relative");
    assert.equal(parseSpecifier("../x").kind, "relative");
    assert.equal(parseSpecifier("/abs/x").kind, "relative");
    assert.equal(parseSpecifier("#internal/x").kind, "subpath-import");
    assert.equal(parseSpecifier("https://esm.sh/react").kind, "url");
    assert.equal(parseSpecifier("bun:test").kind, "url");
    assert.equal(parseSpecifier("npm:left-pad").kind, "url");
  });

  it("rejects names npm could never publish (e.g. @/ path aliases)", () => {
    for (const s of ["@/components/Button", "@", "", "~", "_private", ".hidden", "a b"]) {
      assert.notEqual(parseSpecifier(s).kind, "package", JSON.stringify(s));
    }
  });
  it("strips bundler resource queries (normalize.css?inline)", () => {
    assert.deepEqual(parseSpecifier("normalize.css?inline"), {
      kind: "package",
      packageName: "normalize.css",
    });
    assert.deepEqual(parseSpecifier("@scope/icons/logo.svg?url"), {
      kind: "package",
      packageName: "@scope/icons",
      subpath: "logo.svg",
    });
    assert.equal(parseSpecifier("./local.css?inline").kind, "relative");
    assert.equal(parseSpecifier("?x").kind, "invalid");
  });
});
