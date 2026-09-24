import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { decideRerequest, rerequestKey } from "./rerequested.js";

const SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../../test/fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("decideRerequest", () => {
  it("re-analyses the check run's head SHA with PR context", async () => {
    const d = decideRerequest(await fixture("check_run.rerequested"), "del-1", "ghostdeps");
    assert.ok(d.analyse);
    assert.equal(d.job.headSha, SHA);
    assert.equal(d.job.installationId, 55501);
    assert.deepEqual(d.job.repository, { id: 872001, owner: "octo-org", name: "example-app" });
    assert.deepEqual(d.job.trigger, {
      kind: "rerequested",
      checkRunId: 4001001,
      pullRequest: { number: 42, baseSha: "9049f1265b7d61be4a8904a9a27120d2064dab3b" },
    });
    assert.equal(d.job.key, rerequestKey(872001, SHA, 4001001, "del-1"));
  });

  it("analyses without PR context for fork PRs (empty pull_requests)", async () => {
    const d = decideRerequest(await fixture("check_run.rerequested.fork"), "del-2", "ghostdeps");
    assert.ok(d.analyse);
    assert.deepEqual(d.job.trigger, { kind: "rerequested", checkRunId: 4001001 });
  });

  it("ignores other check_run actions", async () => {
    const payload = await fixture("check_run.rerequested");
    for (const action of ["created", "completed", "requested_action", undefined]) {
      const d = decideRerequest({ ...payload, action }, "del", "ghostdeps");
      assert.equal(d.analyse, false, String(action));
    }
  });

  it("ignores check runs that are not the GhostDeps check", async () => {
    const payload = await fixture("check_run.rerequested");
    const run = payload.check_run as Record<string, unknown>;
    const d = decideRerequest(
      { ...payload, check_run: { ...run, name: "lint" } },
      "del",
      "ghostdeps",
    );
    assert.equal(d.analyse, false);
  });

  it("rejects malformed payloads instead of throwing", () => {
    for (const payload of [
      null,
      {},
      { action: "rerequested" },
      { action: "rerequested", check_run: { name: "ghostdeps", id: 1, head_sha: "not-a-sha" } },
    ]) {
      assert.equal(decideRerequest(payload, "del", "ghostdeps").analyse, false);
    }
  });

  it("gives each re-run its own key, distinct from the original job", () => {
    const original = `872001:${SHA}`;
    const a = rerequestKey(872001, SHA, 4001001, "del-a");
    const b = rerequestKey(872001, SHA, 4001001, "del-b");
    assert.notEqual(a, original);
    assert.notEqual(a, b);
    assert.ok(a.startsWith(`${original}:`));
  });
});
