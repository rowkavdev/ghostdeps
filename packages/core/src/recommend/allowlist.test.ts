import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TOOLING_ALLOWLIST, isAllowlisted, mergeAllowlists } from "./allowlist.js";

describe("isAllowlisted", () => {
  it("matches python entries under PEP 503 normalisation", () => {
    // Python adapters emit PEP 503 names (lowercase, dashes), so a caller
    // entry written as the package is spelled on PyPI must still match.
    const lists = mergeAllowlists(DEFAULT_TOOLING_ALLOWLIST, {
      python: { exact: ["My_Tool", "Other.Tool"], prefixes: ["Acme_Plugin_"] },
    });
    assert.equal(isAllowlisted("my-tool", "python", lists), true);
    assert.equal(isAllowlisted("other-tool", "python", lists), true);
    assert.equal(isAllowlisted("acme-plugin-x", "python", lists), true);
    assert.equal(isAllowlisted("my-tools", "python", lists), false);
  });

  it("keeps javascript names exact and case-sensitive", () => {
    const lists = mergeAllowlists(DEFAULT_TOOLING_ALLOWLIST, {
      "javascript-typescript": { exact: ["My_Tool"] },
    });
    assert.equal(isAllowlisted("My_Tool", "javascript-typescript", lists), true);
    assert.equal(isAllowlisted("my-tool", "javascript-typescript", lists), false);
  });
});
