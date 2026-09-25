import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult } from "@ghostdeps/core";
import type { CheckOutput } from "@ghostdeps/checks-renderer";
import type { AnalysisJob } from "../jobs.js";
import {
  isCacheable,
  ResultCache,
  resultCacheKey,
  type ResultCacheContext,
} from "./result-cache.js";

const result = { findings: [] } as unknown as AnalysisResult;
const check = (summary = "ok"): CheckOutput => ({
  conclusion: "success",
  output: { title: "t", summary, annotations: [] },
});
const entry = check();

function job(trigger: AnalysisJob["trigger"], headSha = "a".repeat(40)): AnalysisJob {
  return {
    key: "k",
    deliveryId: "d",
    installationId: 1,
    repository: { id: 1, owner: "o", name: "r" },
    headSha,
    trigger,
  };
}

describe("resultCacheKey", () => {
  const ctx = { adapterModules: ["m"], recommend: true };
  const base = "b".repeat(40);

  it("is the same for a first run and its re-run", () => {
    const first = job({
      kind: "pull_request",
      number: 1,
      action: "opened",
      baseSha: base,
      sourceOnly: true,
    });
    const rerun = job({
      kind: "rerequested",
      checkRunId: 2,
      pullRequest: { number: 1, baseSha: base, sourceOnly: true },
    });
    assert.equal(resultCacheKey(first, ctx), resultCacheKey(rerun, ctx));
  });

  it("changes with head, base, source-only flag and config", () => {
    const k = (j: AnalysisJob, c: ResultCacheContext = ctx) => resultCacheKey(j, c);
    const pr = job({ kind: "pull_request", number: 1, action: "opened", baseSha: base });
    const keys = new Set([
      k(pr),
      k(job(pr.trigger, "c".repeat(40))),
      k(job({ kind: "pull_request", number: 1, action: "opened", baseSha: "d".repeat(40) })),
      k(
        job({ kind: "pull_request", number: 1, action: "opened", baseSha: base, sourceOnly: true }),
      ),
      k(pr, { adapterModules: ["m"], recommend: false }),
      k(pr, { adapterModules: ["m", "n"], recommend: true }),
      k(pr, { adapterModules: ["m"], recommend: true, footprint: true }),
      k(job({ kind: "rerequested", checkRunId: 2 })),
    ]);
    assert.equal(keys.size, 8);
  });
});

describe("isCacheable", () => {
  it("rejects app notes and adapter errors", () => {
    assert.equal(isCacheable(result, []), true);
    assert.equal(isCacheable(result, ["skipped"]), false);
    const failed = {
      findings: [{ kind: "info", evidence: [{ kind: "adapter-error", statement: "x" }] }],
    } as unknown as AnalysisResult;
    assert.equal(isCacheable(failed, []), false);
  });
});

describe("ResultCache", () => {
  it("bounds entries per repository, least recently used first", () => {
    const cache = new ResultCache({ maxPerRepository: 2 });
    cache.set(1, "a", entry);
    cache.set(1, "b", entry);
    assert.ok(cache.get(1, "a"));
    cache.set(1, "c", entry);
    assert.ok(cache.get(1, "a"));
    assert.equal(cache.get(1, "b"), undefined);
    assert.ok(cache.get(1, "c"));
  });

  it("keeps repositories apart", () => {
    const cache = new ResultCache();
    cache.set(1, "k", check("one"));
    cache.set(2, "k", check("two"));
    assert.equal(cache.get(1, "k")?.output.summary, "one");
    assert.equal(cache.get(2, "k")?.output.summary, "two");
    assert.equal(cache.get(3, "k"), undefined);
  });

  it("evicts least recently used entries across repositories to stay in its byte budget", () => {
    const big = check("x".repeat(10_000)); // about 20 KB as UTF-16
    const cache = new ResultCache({ maxBytes: 50_000 });
    cache.set(1, "a", big);
    cache.set(2, "a", big);
    assert.ok(cache.get(1, "a")); // repo 2 is now the least recently used
    cache.set(3, "a", big);
    assert.equal(cache.size, 2);
    assert.ok(cache.bytes <= 50_000);
    assert.equal(cache.get(2, "a"), undefined);
    assert.ok(cache.get(1, "a"));
    assert.ok(cache.get(3, "a"));
  });

  it("never stores an entry bigger than the whole budget", () => {
    const cache = new ResultCache({ maxBytes: 1_000 });
    cache.set(1, "small", entry);
    cache.set(1, "huge", check("x".repeat(1_000)));
    assert.equal(cache.get(1, "huge"), undefined);
    assert.ok(cache.get(1, "small"));
  });

  it("frees the bytes of a replaced entry", () => {
    const cache = new ResultCache();
    cache.set(1, "k", check("x".repeat(1_000)));
    cache.set(1, "k", entry);
    assert.equal(cache.size, 1);
    assert.ok(cache.bytes < 1_000);
  });
});
