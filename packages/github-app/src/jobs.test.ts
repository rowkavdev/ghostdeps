import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analysisJobKey, InProcessJobQueue, type AnalysisJob } from "./jobs.js";

function job(sha: string): AnalysisJob {
  return {
    key: analysisJobKey(1, sha),
    deliveryId: `delivery-${sha}`,
    installationId: 7,
    repository: { id: 1, owner: "o", name: "r" },
    headSha: sha,
    trigger: { kind: "full_scan", reason: "explicit" },
  };
}

describe("InProcessJobQueue", () => {
  it("runs queued jobs and collapses duplicate keys", async () => {
    const ran: string[] = [];
    const queue = new InProcessJobQueue({ worker: async (j) => void ran.push(j.headSha) });
    assert.equal(queue.enqueue(job("a")), "queued");
    assert.equal(queue.enqueue(job("a")), "duplicate");
    assert.equal(queue.enqueue(job("b")), "queued");
    await queue.onIdle();
    assert.deepEqual(ran.sort(), ["a", "b"]);
  });

  it("never runs more than the concurrency limit at once", async () => {
    let active = 0;
    let peak = 0;
    const queue = new InProcessJobQueue({
      concurrency: 2,
      worker: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    });
    for (const sha of ["a", "b", "c", "d", "e"]) queue.enqueue(job(sha));
    await queue.onIdle();
    assert.equal(peak, 2);
  });

  it("reports worker errors and keeps draining", async () => {
    const errors: string[] = [];
    const ran: string[] = [];
    const queue = new InProcessJobQueue({
      concurrency: 1,
      worker: async (j) => {
        if (j.headSha === "bad") throw new Error("boom");
        ran.push(j.headSha);
      },
      onError: (j) => errors.push(j.headSha),
    });
    queue.enqueue(job("bad"));
    queue.enqueue(job("good"));
    await queue.onIdle();
    assert.deepEqual(errors, ["bad"]);
    assert.deepEqual(ran, ["good"]);
  });

  it("forgets the oldest key once the dedupe window is full", async () => {
    const queue = new InProcessJobQueue({ dedupeWindow: 2, worker: async () => {} });
    queue.enqueue(job("a"));
    queue.enqueue(job("b"));
    queue.enqueue(job("c"));
    await queue.onIdle();
    assert.equal(queue.enqueue(job("a")), "queued");
    assert.equal(queue.enqueue(job("c")), "duplicate");
  });
});
