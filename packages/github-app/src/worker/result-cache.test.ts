import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult } from "@ghostdeps/core";
import type { AnalysisJob } from "../jobs.js";
import { isCacheable, ResultCache, resultCacheKey } from "./result-cache.js";

const result = { findings: [] } as unknown as AnalysisResult;
const entry = { result, added: new Map() };

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
    const k = (j: AnalysisJob, c = ctx) => resultCacheKey(j, c);
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
      k(job({ kind: "rerequested", checkRunId: 2 })),
    ]);
    assert.equal(keys.size, 7);
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

  it("bounds repositories and keeps them apart", () => {
    const cache = new ResultCache({ maxRepositories: 2 });
    cache.set(1, "k", entry);
    cache.set(2, "k", entry);
    cache.set(3, "k", entry);
    assert.equal(cache.get(1, "k"), undefined);
    assert.ok(cache.get(2, "k"));
    assert.equal(cache.get(4, "k"), undefined);
    assert.equal(cache.size, 2);
  });
});
