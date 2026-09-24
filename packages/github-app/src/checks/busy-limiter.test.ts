import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BusyLimiter } from "./busy-limiter.js";

describe("BusyLimiter", () => {
  it("allows one per repository per window", () => {
    let t = 0;
    const l = new BusyLimiter({ windowMs: 1000, now: () => t });
    assert.equal(l.allow(1), true);
    assert.equal(l.allow(1), false);
    assert.equal(l.allow(2), true);
    t = 1000;
    assert.equal(l.allow(1), true);
  });

  it("stays bounded", () => {
    const l = new BusyLimiter({ maxRepositories: 2 });
    l.allow(1);
    l.allow(2);
    l.allow(3);
    assert.equal(l.allow(1), true);
  });
});
