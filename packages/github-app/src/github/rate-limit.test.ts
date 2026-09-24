import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundedThrottle,
  isRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  shouldRetryRateLimit,
  withDeadline,
} from "./rate-limit.js";

describe("bounded rate-limit retries (#255)", () => {
  it("retries only short waits, at most twice", () => {
    assert.equal(shouldRetryRateLimit(1, 0), true);
    assert.equal(shouldRetryRateLimit(MAX_RATE_LIMIT_WAIT_SECONDS, 1), true);
    assert.equal(shouldRetryRateLimit(MAX_RATE_LIMIT_WAIT_SECONDS + 1, 0), false);
    assert.equal(shouldRetryRateLimit(1, MAX_RATE_LIMIT_RETRIES), false);
    assert.equal(shouldRetryRateLimit(3600, 0), false);
  });

  it("applies the same bound to primary and secondary limits and logs each hit", () => {
    const lines: string[] = [];
    const t = boundedThrottle({ warn: (_o, msg) => lines.push(msg) });
    const req = { method: "GET", url: "/repos/o/r/tarball/abc" };
    assert.equal(t.onRateLimit(3600, req, undefined, 0), false);
    assert.equal(t.onSecondaryRateLimit(30, req, undefined, 0), true);
    assert.equal(t.onSecondaryRateLimit(30, req, undefined, 2), false);
    assert.deepEqual(lines, [
      "GitHub rate limit hit; giving up",
      "GitHub rate limit hit; retrying",
      "GitHub rate limit hit; giving up",
    ]);
  });
});

describe("isRateLimitError", () => {
  const err = (status: number, headers: Record<string, string>, message = "Forbidden") => ({
    status,
    message,
    response: { headers },
  });

  it("recognises primary, secondary and GraphQL rate limits", () => {
    assert.equal(isRateLimitError(err(403, { "x-ratelimit-remaining": "0" })), true);
    assert.equal(isRateLimitError(err(429, { "retry-after": "30" })), true);
    assert.equal(isRateLimitError(err(403, {}, "You have exceeded a secondary rate limit")), true);
    assert.equal(
      isRateLimitError({ response: { headers: {}, data: { errors: [{ type: "RATE_LIMITED" }] } } }),
      true,
    );
  });

  it("leaves other failures alone", () => {
    assert.equal(isRateLimitError(err(403, { "x-ratelimit-remaining": "4999" })), false);
    assert.equal(isRateLimitError(err(404, { "x-ratelimit-remaining": "0" })), false);
    assert.equal(isRateLimitError(new Error("boom")), false);
    assert.equal(isRateLimitError(undefined), false);
  });
});

describe("withDeadline", () => {
  it("passes a quick result through", async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 1_000, "x"), 7);
  });

  it("rejects when the work takes too long, without waiting for it", async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 5_000).unref());
    const started = Date.now();
    await assert.rejects(withDeadline(slow, 20, "lookup"), /lookup took longer than 20 ms/);
    assert.ok(Date.now() - started < 1_000);
  });

  it("swallows a late failure from work that lost the race", async () => {
    const late = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("late")), 30).unref(),
    );
    await assert.rejects(withDeadline(late, 5, "lookup"), /took longer/);
    await new Promise((r) => setTimeout(r, 60));
  });
});
