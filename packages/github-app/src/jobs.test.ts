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
    // A synchronize job for `sha`, replacing `before` when given.
    const prJob = (sha: string, before?: string, pr = 5, repo = 1): AnalysisJob => ({
      ...job(sha),
      key: analysisJobKey(repo, sha),
      repository: { id: repo, owner: "o", name: "r" },
      trigger: {
        kind: "pull_request",
        number: pr,
        action: "synchronize",
        baseSha: "base",
        ...(before ? { beforeSha: before } : {}),
      },
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

    it("drops the queued head a synchronize replaced", async () => {
      const dropped: string[] = [];
      const { queue, ran, release } = blockingQueue((d, b) =>
        dropped.push(`${d.headSha}>${b.headSha}`),
      );
      queue.enqueue(prJob("old"));
      assert.equal(queue.enqueue(prJob("new", "old")), "queued");
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "new"]);
      assert.deepEqual(dropped, ["old>new"]);
    });

    it("a late or redelivered older event never drops the current head", async () => {
      // Pushes A -> B -> C, but C's event arrives before B's.
      const dropped: string[] = [];
      const { queue, ran, release } = blockingQueue((d) => dropped.push(d.headSha));
      queue.enqueue(prJob("C", "B"));
      queue.enqueue(prJob("B", "A"));
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "C", "B"]);
      assert.deepEqual(dropped, []);
    });

    it("drops nothing without a before SHA (opened, reopened)", async () => {
      const { queue, ran, release } = blockingQueue();
      queue.enqueue(prJob("a"));
      queue.enqueue(prJob("b"));
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "a", "b"]);
    });

    it("keeps other PRs, other repositories and non-PR jobs", async () => {
      const { queue, ran, release } = blockingQueue();
      queue.enqueue(prJob("a", undefined, 6));
      queue.enqueue(prJob("a", undefined, 5, 2));
      queue.enqueue({ ...job("a"), key: "1:a:scan" });
      queue.enqueue(prJob("b", "a", 5)); // PR 5 never queued "a"
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "a", "a", "a", "b"]);
    });

    it("never drops a running job or a user's re-run, and a re-run never supersedes", async () => {
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
      const rerun: AnalysisJob = {
        ...job("mid"),
        key: "1:mid:rerun",
        trigger: {
          kind: "rerequested",
          checkRunId: 9,
          pullRequest: { number: 5, baseSha: "base" },
        },
      };
      queue.enqueue(rerun);
      queue.enqueue(prJob("new", "old")); // "old" is running: not dropped
      queue.enqueue(prJob("newer", "mid")); // "mid" is a re-run: not dropped
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["old", "mid", "new", "newer"]);
    });

    it("forgets a dropped job's key so that head can be queued again", async () => {
      const { queue, ran, release } = blockingQueue();
      queue.enqueue(prJob("x"));
      queue.enqueue(prJob("y", "x")); // drops x
      assert.equal(queue.enqueue(prJob("x", "y")), "queued"); // force-push back; drops y
      release();
      await queue.onIdle();
      assert.deepEqual(ran, ["busy", "x"]);
    });
  });
});
