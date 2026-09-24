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

  it("rejects new jobs once maxPending are waiting", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const queue = new InProcessJobQueue({ concurrency: 1, maxPending: 1, worker: () => gate });
    assert.equal(queue.enqueue(job("running")), "queued");
    assert.equal(queue.enqueue(job("waiting")), "queued");
    assert.equal(queue.enqueue(job("extra")), "overloaded");
    release();
    await queue.onIdle();
    assert.equal(queue.enqueue(job("extra")), "queued");
  });

  describe("superseded PR heads (#257)", () => {
    const prJob = (sha: string, pr = 5, repo = 1): AnalysisJob => ({
      ...job(sha),
      key: analysisJobKey(repo, sha),
      repository: { id: repo, owner: "o", name: "r" },
      trigger: { kind: "pull_request", number: pr, action: "synchronize", baseSha: "base" },
    });
    // A worker that blocks until released, so later jobs stay queued.
    function blockingQueue(onSuperseded?: (d: AnalysisJob, b: AnalysisJob) => void) {
      const ran: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const queue = new InProcessJobQueue({
        concurrency: 1,
        worker: async (j) => {
          ran.push(j.headSha);
          if (j.headSha === "busy") await gate;
        },
        ...(onSuperseded ? { onSuperseded } : {}),
      });
      queue.enqueue(job("busy"));
      return { queue, ran, release };
    }

    it("drops a queued older head when a newer head of the same PR arrives", async () => {
      const dropped: string[] = [];
      const { queue, ran, release } = blockingQueue((d, b) =>
        dropped.push(`${d.headSha}>${b.headSha}`),
      );
      queue.enqueue(prJob("old"));
      assert.equal(queue.enqueue(prJob("new")), "queued");
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "new"]);
      assert.deepEqual(dropped, ["old>new"]);
    });

    it("keeps other PRs, other repositories and non-PR jobs", async () => {
      const { queue, ran, release } = blockingQueue();
      queue.enqueue(prJob("a", 5));
      queue.enqueue(prJob("b", 6));
      queue.enqueue(prJob("c", 5, 2));
      queue.enqueue(job("push"));
      queue.enqueue(prJob("d", 5));
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "b", "c", "push", "d"]);
    });

    it("never drops a running job, and a re-run never supersedes", async () => {
      const ran: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const queue = new InProcessJobQueue({
        concurrency: 1,
        worker: async (j) => {
          ran.push(j.headSha);
          if (j.headSha === "old") await gate;
        },
      });
      queue.enqueue(prJob("old")); // starts running
      queue.enqueue(prJob("mid"));
      const rerun: AnalysisJob = {
        ...job("older"),
        key: "1:older:rerun",
        trigger: {
          kind: "rerequested",
          checkRunId: 9,
          pullRequest: { number: 5, baseSha: "base" },
        },
      };
      queue.enqueue(rerun);
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["old", "mid", "older"]);
    });

    it("forgets a dropped job's key so that head can be queued again", async () => {
      const { queue, ran, release } = blockingQueue();
      queue.enqueue(prJob("x"));
      queue.enqueue(prJob("y")); // drops x
      assert.equal(queue.enqueue(prJob("x")), "queued"); // force-push back; drops y
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "x"]);
    });
  });
});
