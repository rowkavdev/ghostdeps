import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appIdFromEnv,
  footprintFromEnv,
  recommendationsFromEnv,
  sourcePrTriggerFromEnv,
} from "./config.js";

describe("footprintFromEnv (#174)", () => {
  it("is off unless true or 1", () => {
    for (const v of [undefined, "", "false", "0", "yes"]) {
      assert.equal(footprintFromEnv({ GHOSTDEPS_FOOTPRINT: v }), false, String(v));
    }
    for (const v of ["true", "TRUE", " 1 "]) {
      assert.equal(footprintFromEnv({ GHOSTDEPS_FOOTPRINT: v }), true, v);
    }
  });
});

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
  it("is on unless false or 0", () => {
    for (const v of [undefined, "", "true", "1", "yes"]) {
      assert.equal(sourcePrTriggerFromEnv({ GHOSTDEPS_SOURCE_PR_TRIGGER: v }), true, String(v));
    }
    for (const v of ["false", " 0 ", "FALSE"]) {
      assert.equal(sourcePrTriggerFromEnv({ GHOSTDEPS_SOURCE_PR_TRIGGER: v }), false, v);
    }
  });
});

describe("recommendationsFromEnv", () => {
  it("is on unless false or 0", () => {
    for (const v of [undefined, "", "true", "1", "yes"]) {
      assert.equal(recommendationsFromEnv({ GHOSTDEPS_RECOMMENDATIONS: v }), true, String(v));
    }
    for (const v of ["false", "FALSE", " 0 "]) {
      assert.equal(recommendationsFromEnv({ GHOSTDEPS_RECOMMENDATIONS: v }), false, v);
    }
  });
});
