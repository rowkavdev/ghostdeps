import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appIdFromEnv, sourcePrTriggerFromEnv } from "./config.js";

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

describe("sourcePrTriggerFromEnv", () => {
  it("is on only for true or 1", () => {
    assert.equal(sourcePrTriggerFromEnv({ GHOSTDEPS_SOURCE_PR_TRIGGER: "true" }), true);
    assert.equal(sourcePrTriggerFromEnv({ GHOSTDEPS_SOURCE_PR_TRIGGER: " 1 " }), true);
    assert.equal(sourcePrTriggerFromEnv({ GHOSTDEPS_SOURCE_PR_TRIGGER: "TRUE" }), true);
    for (const v of [undefined, "", "0", "false", "yes", "on"]) {
      assert.equal(sourcePrTriggerFromEnv({ GHOSTDEPS_SOURCE_PR_TRIGGER: v }), false, String(v));
    }
  });
});
