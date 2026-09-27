import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JS_NATIVE_RULES } from "./rules.js";

describe("JS native rule seed data (#57)", () => {
  it("has unique, versioned rules with references and bounded contracts", () => {
    assert.deepEqual(
      JS_NATIVE_RULES.map((r) => r.packages[0]),
      ["axios", "uuid", "lodash.clonedeep"],
    );
    assert.equal(new Set(JS_NATIVE_RULES.map((r) => r.id)).size, JS_NATIVE_RULES.length);
    for (const rule of JS_NATIVE_RULES) {
      assert.match(rule.id, /^javascript-typescript\/.+\/v1$/);
      assert.ok(rule.references.every((url) => url.startsWith("https://")));
      assert.ok(rule.incompatibleUses.length && rule.semanticDifferences.length);
    }
  });
});
