import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ORIGIN_URL_LENGTH,
  mergeBindings,
  registryUrlOrigin,
  scopedOrigin,
  scopedRegistries,
  tarballOrigin,
} from "./origin.js";

const NPM = "https://registry.npmjs.org";

describe("tarballOrigin (#174 step 3)", () => {
  it("takes the lowercase origin of a registry tarball URL", () => {
    assert.equal(tarballOrigin(`${NPM}/left-pad/-/left-pad-1.3.0.tgz`, "left-pad"), NPM);
    assert.equal(tarballOrigin(`${NPM}/@babel/core/-/core-7.0.0.tgz`, "@babel/core"), NPM);
    assert.equal(tarballOrigin(`${NPM}/@babel%2fcore/-/core-7.0.0.tgz`, "@babel/core"), NPM);
    assert.equal(tarballOrigin(`${NPM}/@babel%2Fcore/-/core-7.0.0.tgz`, "@babel/core"), NPM);
    assert.equal(tarballOrigin("HTTPS://Registry.NPMJS.org/a/-/a-1.0.0.tgz", "a"), NPM);
    // Default ports drop; others stay. Registries under a path prefix keep only the origin.
    assert.equal(tarballOrigin("https://registry.npmjs.org:443/a/-/a-1.0.0.tgz", "a"), NPM);
    assert.equal(
      tarballOrigin("http://localhost:4873/a/-/a-1.0.0.tgz", "a"),
      "http://localhost:4873",
    );
    assert.equal(
      tarballOrigin("https://acme.jfrog.io/artifactory/api/npm/npm/a/-/a-1.0.0.tgz", "a"),
      "https://acme.jfrog.io",
    );
  });

  it("rejects malformed and non-string values", () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      ["https://registry.npmjs.org/a/-/a-1.0.0.tgz"],
      "",
      "https://",
      "https:///a/-/a-1.0.0.tgz",
      "https//registry.npmjs.org/a/-/a-1.0.0.tgz",
      "registry.npmjs.org/a/-/a-1.0.0.tgz",
      "/a/-/a-1.0.0.tgz",
      "https://[::1/a/-/a-1.0.0.tgz",
      "https://exa mple.com/a/-/a-1.0.0.tgz",
      " https://registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org/a/-/a-1.0.0.tgz\n",
      "https:\\\\registry.npmjs.org\\a\\-\\a-1.0.0.tgz",
      "https://registry.npmjs.org\t/a/-/a-1.0.0.tgz",
      `https://registry.npmjs.org/a/-/${"a".repeat(MAX_ORIGIN_URL_LENGTH)}.tgz`,
    ]) {
      assert.equal(tarballOrigin(bad, "a"), undefined, JSON.stringify(bad));
    }
  });

  it("rejects credentials, queries and (outside yarn classic) fragments", () => {
    for (const bad of [
      "https://user:pw@registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://token@registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://:pw@registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://@registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org@evil.example/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org/a/-/a-1.0.0.tgz?token=abc",
      "https://registry.npmjs.org/a/-/a-1.0.0.tgz?",
      "https://evil.example/?x=https://registry.npmjs.org/a/-/a-1.0.0.tgz",
      "https://registry.npmjs.org/a/-/a-1.0.0.tgz#sha1",
    ]) {
      assert.equal(tarballOrigin(bad, "a"), undefined, bad);
    }
    const yarn = { allowFragment: true };
    assert.equal(tarballOrigin(`${NPM}/a/-/a-1.0.0.tgz#0123abcd`, "a", yarn), NPM);
    assert.equal(
      tarballOrigin(`https://u:p@registry.npmjs.org/a/-/a-1.0.0.tgz#x`, "a", yarn),
      undefined,
    );
    assert.equal(tarballOrigin(`${NPM}/a/-/a-1.0.0.tgz?x=1#y`, "a", yarn), undefined);
  });

  it("rejects non-http(s) schemes", () => {
    for (const bad of [
      "git+https://github.com/a/a.git#abc",
      "git+ssh://git@github.com/a/a.git",
      "git://github.com/a/a.git",
      "ssh://git@github.com/a/a.git",
      "file:../a/a-1.0.0.tgz",
      "file:///tmp/a/-/a-1.0.0.tgz",
      "ftp://registry.npmjs.org/a/-/a-1.0.0.tgz",
      "javascript:alert(1)//a/-/a-1.0.0.tgz",
      "data:application/gzip;base64,AAAA",
      "link:../a",
      "workspace:*",
      "npm:a@1.0.0",
      "github:a/a",
    ]) {
      assert.equal(tarballOrigin(bad, "a"), undefined, bad);
    }
  });

  it("requires the registry tarball path for this package name", () => {
    for (const [url, name] of [
      [`${NPM}/`, "a"],
      [`${NPM}/a`, "a"],
      [`${NPM}/a/-/a-1.0.0.tar.gz`, "a"],
      [`${NPM}/b/-/b-1.0.0.tgz`, "a"],
      [`${NPM}/a/-/nested/a-1.0.0.tgz`, "a"],
      [`${NPM}/xa/-/a-1.0.0.tgz`, "a"],
      ["https://codeload.github.com/a/a/tar.gz/abc123", "a"],
      ["https://github.com/a/a/archive/v1.0.0.tgz", "a"],
      [`${NPM}/core/-/core-7.0.0.tgz`, "@babel/core"],
      [`${NPM}/a/-/a-1.0.0.tgz`, ""],
    ] as const) {
      assert.equal(tarballOrigin(url, name), undefined, `${url} for ${name}`);
    }
  });
});

describe("scoped .npmrc registry bindings", () => {
  it("binds a scope to its registry's origin and ignores the bare default", () => {
    const b = scopedRegistries(
      [
        "registry=https://registry.npmjs.org/",
        "; comment",
        "# @evil:registry=https://evil.example/",
        "@acme:registry=https://npm.acme.example/api/npm/",
        "  @Tools:registry = https://NPM.Tools.example  ",
        "//npm.acme.example/:_authToken=secret-token",
        "always-auth=true",
      ].join("\r\n"),
    );
    assert.deepEqual(
      [...b],
      [
        ["@acme", "https://npm.acme.example"],
        ["@Tools", null],
      ],
    );
    assert.equal(scopedOrigin("@acme/ui", b), "https://npm.acme.example");
    // An unscoped package never takes a binding, even with a registry= default.
    assert.equal(scopedOrigin("left-pad", b), undefined);
    assert.equal(scopedOrigin("@other/x", b), undefined);
    assert.equal(scopedOrigin("@acme", b), undefined);
    assert.equal(scopedOrigin("@/x", b), undefined);
    // Auth lines are never kept.
    assert.ok(![...b.values()].some((v) => typeof v === "string" && v.includes("secret")));
  });

  it("marks ambiguous or untrustworthy bindings null (fail closed)", () => {
    const b = scopedRegistries(
      [
        "@dup:registry=https://a.example/",
        "@dup:registry=https://b.example/",
        "@same:registry=https://s.example/",
        "@same:registry=https://S.example",
        "@env:registry=${ACME_REGISTRY}",
        '@quoted:registry="https://q.example/"',
        "@creds:registry=https://user:pw@c.example/",
        "@query:registry=https://q.example/?x=1",
        "@frag:registry=https://f.example/#x",
        "@git:registry=git+https://g.example/",
        "@file:registry=file:///tmp/registry",
        "@empty:registry=",
        "@junk:registry=not a url",
        "@__proto__:registry=https://p.example/",
      ].join("\n"),
    );
    for (const scope of [
      "@dup",
      "@env",
      "@quoted",
      "@creds",
      "@query",
      "@frag",
      "@git",
      "@file",
      "@empty",
      "@junk",
    ]) {
      assert.equal(b.get(scope), null, scope);
      assert.equal(scopedOrigin(`${scope}/pkg`, b), undefined, scope);
    }
    assert.equal(scopedOrigin("@same/pkg", b), "https://s.example");
    // Scopes must look like npm scopes (lowercase, no leading "_"); a Map, so no prototype keys.
    assert.equal(scopedOrigin("@__proto__/pkg", b), undefined);
    assert.equal(scopedOrigin("@constructor/pkg", b), undefined);
  });

  it("a member .npmrc can only veto the root's binding, never add one", () => {
    const root = scopedRegistries(
      "@acme:registry=https://npm.acme.example/\n@a:registry=https://a.example/",
    );
    const member = scopedRegistries(
      "@acme:registry=https://other.example/\n@new:registry=https://new.example/\n@a:registry=https://a.example",
    );
    const merged = mergeBindings(root, member);
    assert.equal(scopedOrigin("@acme/x", merged), undefined);
    assert.equal(scopedOrigin("@new/x", merged), undefined);
    assert.equal(scopedOrigin("@a/x", merged), "https://a.example");
  });

  it("registryUrlOrigin accepts a path but not credentials, query or fragment", () => {
    assert.equal(registryUrlOrigin("https://r.example/npm/"), "https://r.example");
    assert.equal(registryUrlOrigin("https://u@r.example/"), undefined);
    assert.equal(registryUrlOrigin("https://r.example/?a"), undefined);
    assert.equal(registryUrlOrigin("https://r.example/#a"), undefined);
  });
});
