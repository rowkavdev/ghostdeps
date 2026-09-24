import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPublicNpmRegistryOrigin,
  normaliseRegistryOrigin,
  PUBLIC_NPM_REGISTRY_ORIGINS,
} from "./index.js";

describe("public npm registry origins (#174)", () => {
  it("is exactly npm and yarn classic's mirror", () => {
    assert.deepEqual(
      [...PUBLIC_NPM_REGISTRY_ORIGINS],
      ["https://registry.npmjs.org", "https://registry.yarnpkg.com"],
    );
    assert.ok(Object.isFrozen(PUBLIC_NPM_REGISTRY_ORIGINS));
    assert.throws(() => (PUBLIC_NPM_REGISTRY_ORIGINS as string[]).push("https://evil.example"));
  });

  it("accepts both origins, canonicalised", () => {
    for (const ok of [
      "https://registry.npmjs.org",
      "https://registry.npmjs.org/",
      "HTTPS://REGISTRY.NPMJS.ORG",
      "https://registry.yarnpkg.com",
      "https://registry.yarnpkg.com/",
    ]) {
      assert.equal(isPublicNpmRegistryOrigin(ok), true, ok);
    }
  });

  it("never matches by suffix, subdomain, scheme, port or path", () => {
    for (const bad of [
      "http://registry.npmjs.org",
      "https://registry.npmjs.org:8443",
      "https://registry.npmjs.org.evil.example",
      "https://mirror.registry.npmjs.org",
      "https://evilregistry.npmjs.org",
      "https://npmjs.org",
      "https://registry.npmjs.com",
      "https://registry.yarnpkg.com.evil.example",
      "https://registry.npmjs.org/left-pad",
      "https://user@registry.npmjs.org",
      "https://npm.acme.example",
      "https://registry.npmmirror.com",
      undefined,
      null,
      "",
      42,
    ]) {
      assert.equal(isPublicNpmRegistryOrigin(bad), false, String(bad));
    }
  });

  it("is exported with the normaliser from @ghostdeps/core", () => {
    assert.equal(
      normaliseRegistryOrigin("https://registry.yarnpkg.com/"),
      "https://registry.yarnpkg.com",
    );
  });
});
