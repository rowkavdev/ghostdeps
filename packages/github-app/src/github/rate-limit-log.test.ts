import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readRateLimit, watchRateLimit } from "./rate-limit-log.js";

type After = (
  response: { headers: Record<string, unknown> },
  options: { method?: string; url?: string },
) => void;

function fakeOctokit() {
  let after: After | undefined;
  return {
    octokit: { hook: { after: (_name: "request", fn: After) => void (after = fn) } },
    respond: (headers: Record<string, unknown>) =>
      after?.({ headers }, { method: "GET", url: "/x" }),
  };
}

function recorder() {
  const warns: object[] = [];
  const debugs: object[] = [];
  return {
    log: { warn: (o: object) => warns.push(o), debug: (o: object) => debugs.push(o) },
    warns,
    debugs,
  };
}

const headers = (remaining: number, limit = 5000, resource = "core") => ({
  "x-ratelimit-limit": String(limit),
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-used": String(limit - remaining),
  "x-ratelimit-resource": resource,
  "x-ratelimit-reset": "1790290000",
});

describe("rate-limit telemetry (#256)", () => {
  it("reads the x-ratelimit headers and ignores missing or malformed ones", () => {
    assert.deepEqual(readRateLimit(headers(4000)), {
      limit: 5000,
      remaining: 4000,
      used: 1000,
      resource: "core",
      reset: 1790290000,
    });
    assert.equal(readRateLimit({}), undefined);
    assert.equal(
      readRateLimit({ "x-ratelimit-limit": "0", "x-ratelimit-remaining": "0" }),
      undefined,
    );
    assert.equal(
      readRateLimit({ "x-ratelimit-limit": "x", "x-ratelimit-remaining": "1" }),
      undefined,
    );
  });

  it("logs every reading at debug and warns once below 10% of the budget", () => {
    const { octokit, respond } = fakeOctokit();
    const r = recorder();
    watchRateLimit(octokit, r.log);
    respond(headers(4000));
    respond(headers(500)); // exactly 10%: not below
    assert.equal(r.warns.length, 0);
    respond(headers(499));
    respond(headers(300));
    assert.equal(r.warns.length, 1);
    assert.equal((r.warns[0] as { remaining: number }).remaining, 499);
    assert.equal(r.debugs.length, 4);
  });

  it("warns again after the budget recovers, and per resource", () => {
    const { octokit, respond } = fakeOctokit();
    const r = recorder();
    watchRateLimit(octokit, r.log);
    respond(headers(100));
    respond(headers(4999)); // reset
    respond(headers(100));
    respond(headers(10, 5000, "graphql"));
    assert.equal(r.warns.length, 3);
  });

  it("stays quiet on responses without rate-limit headers", () => {
    const { octokit, respond } = fakeOctokit();
    const r = recorder();
    watchRateLimit(octokit, r.log);
    respond({});
    assert.equal(r.debugs.length + r.warns.length, 0);
  });
});
