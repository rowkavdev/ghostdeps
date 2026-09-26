import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentLockKey, withCommentLock } from "./queue.js";

describe("withCommentLock", () => {
  it("serializes overlapping critical sections on the same key", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = withCommentLock("k", async () => {
      events.push("first:in");
      await gate;
      events.push("first:out");
    });
    const second = withCommentLock("k", async () => {
      events.push("second:in");
    });
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:in", "first:out", "second:in"]);
  });

  it("runs different keys concurrently", async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const a = withCommentLock("a", async () => {
      events.push("a:in");
      await gateA;
    });
    const b = withCommentLock("b", async () => {
      events.push("b:in");
    });
    await b;
    releaseA();
    await a;
    assert.deepEqual(events, ["a:in", "b:in"]);
  });

  it("releases the queue when a holder throws", async () => {
    await assert.rejects(
      withCommentLock("k", async () => {
        throw new Error("boom");
      }),
    );
    let ran = false;
    await withCommentLock("k", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("evicts settled keys", async () => {
    await withCommentLock("ephemeral", async () => {});
    // A second acquisition must not find a stale tail that gates it.
    const t0 = Date.now();
    await withCommentLock("ephemeral", async () => {});
    assert.ok(Date.now() - t0 < 100);
  });
});

describe("commentLockKey", () => {
  it("is shared by both writers of one PR comment", () => {
    assert.equal(commentLockKey(5, 9), "5:9");
    assert.notEqual(commentLockKey(5, 9), commentLockKey(5, 10));
  });
});
