import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appIdFromEnv } from "./config.js";

describe("appIdFromEnv", () => {
  it("accepts a positive integer", () => {
    assert.equal(appIdFromEnv({ APP_ID: "872001" }), 872001);
    assert.equal(appIdFromEnv({ APP_ID: " 42 " }), 42);
  });
  it("rejects missing, empty, zero, negative, fractional and non-numeric ids", () => {
    for (const APP_ID of [undefined, "", "0", "-1", "1.5", "abc", "12abc", "1e3"]) {
      assert.equal(appIdFromEnv({ APP_ID }), undefined, String(APP_ID));
    }
  });
});
