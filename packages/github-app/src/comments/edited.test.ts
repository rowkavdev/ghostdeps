import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkboxOnlyDiff,
  handleCommentEdited,
  type EditedPayload,
  type HandleEditedDeps,
} from "./edited.js";
import { buildMarker } from "./marker.js";
import type { IssuesClient } from "./state.js";

const SHA = "f".repeat(40);
const K1 = "1".repeat(64);
const K2 = "2".repeat(64);
const MARKER = { repositoryId: 10, pullNumber: 4, headSha: SHA, keys: [K1, K2] };

function canonical(): string {
  return [
    buildMarker(MARKER),
    "",
    "## GhostDeps - 2 findings to review",
    "",
    `- [ ] **unused \`left-pad\`** - declared but never used. <!-- gd-key:${K1} -->`,
    `- [ ] **unused \`rimraf\`** - declared but never used. <!-- gd-key:${K2} -->`,
    "",
    `_Head analysed: \`${SHA.slice(0, 7)}\`._`,
  ].join("\n");
}

let LAST_BODY: string | undefined;

function payload(body: string, over: Partial<EditedPayload> = {}): EditedPayload {
  LAST_BODY = body;
  return {
    action: "edited",
    issue: { number: 4, pull_request: { url: "x" } },
    comment: { id: 77, body, user: { login: "ghostdeps[bot]", type: "Bot" } },
    changes: { body: { from: canonical() } },
    repository: { id: 10, owner: { login: "o" }, name: "r" },
    sender: { login: "rowkav09" },
    installation: { id: 55, suspended_at: null },
    ...over,
  };
}

function deps(
  permission: string,
  captured: { updates: string[] },
  live: { body?: string; prOpen?: boolean; bodyAfterFirstRead?: string } = {},
): HandleEditedDeps {
  let reads = 0;
  return {
    issues: {
      issues: {
        getComment: async () => {
          reads += 1;
          const body =
            reads > 1 && live.bodyAfterFirstRead !== undefined
              ? live.bodyAfterFirstRead
              : (live.body ?? LAST_BODY!);
          return { data: { id: 77, body } };
        },
        get: async () => ({
          data: { state: live.prOpen === false ? "closed" : "open", pull_request: {} },
        }),
        updateComment: async (p: { body: string }) => {
          captured.updates.push(p.body);
          return { data: { id: 77 } };
        },
      },
    } as unknown as IssuesClient,
    permissions: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
    },
    botLogin: "ghostdeps[bot]",
    log: { info: () => {}, warn: () => {} },
  };
}

describe("checkboxOnlyDiff", () => {
  it("accepts a pure tick of an eligible key", () => {
    const to = canonical().replace(`- [ ] **unused \`left-pad\``, `- [x] **unused \`left-pad\``);
    assert.deepEqual(checkboxOnlyDiff(canonical(), to, new Set([K1, K2])), [K1]);
  });

  it("rejects an uncheck", () => {
    const from = canonical().replace(`- [ ] **unused \`left-pad\``, `- [x] **unused \`left-pad\``);
    assert.equal(checkboxOnlyDiff(from, canonical(), new Set([K1, K2])), undefined);
  });

  it("rejects a tick of a key the marker does not carry", () => {
    const to = canonical()
      .replace(`<!-- gd-key:${K1} -->`, `<!-- gd-key:${"9".repeat(64)} -->`)
      .replace("[ ]", "[x]");
    assert.equal(checkboxOnlyDiff(canonical(), to, new Set([K2])), undefined);
  });

  it("rejects any text change alongside a tick", () => {
    const to = canonical()
      .replace(`- [ ] **unused \`left-pad\``, `- [x] **unused \`left-pad\``)
      .replace("never used", "totally never used");
    assert.equal(checkboxOnlyDiff(canonical(), to, new Set([K1, K2])), undefined);
  });

  it("rejects added or dropped lines", () => {
    assert.equal(
      checkboxOnlyDiff(canonical(), `${canonical()}\nextra`, new Set([K1, K2])),
      undefined,
    );
  });
});

describe("handleCommentEdited", () => {
  it("acknowledges a maintainer tick and restores canonical + note (no apply)", async () => {
    const captured = { updates: [] as string[] };
    const to = canonical().replace(`- [ ] **unused \`left-pad\``, `- [x] **unused \`left-pad\``);
    const out = await handleCommentEdited(deps("maintain", captured), payload(to));
    assert.deepEqual(out, { kind: "restored", tickedKeys: [K1] });
    assert.equal(captured.updates.length, 1);
    assert.match(captured.updates[0]!, /ticked by a maintainer - tick-to-apply is not enabled yet/);
    assert.match(captured.updates[0]!, /- \[ \] \*\*unused `left-pad`/);
  });

  it("reverts a tampered body to canonical", async () => {
    const captured = { updates: [] as string[] };
    const to = canonical().replace("never used", "HAX");
    const out = await handleCommentEdited(deps("admin", captured), payload(to));
    assert.deepEqual(out, { kind: "restored", tickedKeys: [] });
    assert.equal(captured.updates[0], canonical());
  });

  it("refuses a stale delivery that no longer matches the live comment", async () => {
    const captured = { updates: [] as string[] };
    const out = await handleCommentEdited(
      deps("maintain", captured, { body: "NEWER canonical body from a later delivery" }),
      payload(canonical().replace("[ ]", "[x]")),
    );
    assert.deepEqual(out, {
      kind: "ignored",
      reason: "comment moved after this delivery; a newer delivery owns it",
    });
    assert.equal(captured.updates.length, 0);
  });

  it("refuses to write when a scan update lands during the permission check", async () => {
    const captured = { updates: [] as string[] };
    const out = await handleCommentEdited(
      deps("maintain", captured, { bodyAfterFirstRead: "SCAN UPDATE: fresh canonical body" }),
      payload(canonical().replace("[ ]", "[x]")),
    );
    assert.deepEqual(out, {
      kind: "ignored",
      reason: "comment moved while permissions were checked; refusing to overwrite",
    });
    assert.equal(captured.updates.length, 0);
  });

  it("refuses a restore onto a closed or merged PR", async () => {
    const captured = { updates: [] as string[] };
    const out = await handleCommentEdited(
      deps("maintain", captured, { prOpen: false }),
      payload(canonical().replace("[ ]", "[x]")),
    );
    assert.deepEqual(out, { kind: "ignored", reason: "pull request is not open" });
    assert.equal(captured.updates.length, 0);
  });

  it("ignores a non-maintainer editor entirely", async () => {
    const captured = { updates: [] as string[] };
    const to = canonical().replace("[ ]", "[x]");
    const out = await handleCommentEdited(deps("write", captured), payload(to));
    assert.deepEqual(out, { kind: "ignored", reason: "editor is write, not a maintainer" });
    assert.equal(captured.updates.length, 0);
  });

  it("ignores edits to comments that are not ours", async () => {
    const captured = { updates: [] as string[] };
    const out = await handleCommentEdited(
      deps("admin", captured),
      payload(canonical(), {
        comment: { id: 77, body: canonical(), user: { login: "someone", type: "User" } },
      }),
    );
    assert.equal(out.kind, "ignored");
  });

  it("ignores non-PR issue comments and suspended installations", async () => {
    const captured = { updates: [] as string[] };
    const a = await handleCommentEdited(
      deps("admin", captured),
      payload(canonical(), { issue: { number: 4 } }),
    );
    const b = await handleCommentEdited(
      deps("admin", captured),
      payload(canonical(), { installation: { id: 55, suspended_at: "2026-01-01" } }),
    );
    assert.equal(a.kind, "ignored");
    assert.equal(b.kind, "ignored");
  });

  it("ignores a forged marker pointing at another repository", async () => {
    const captured = { updates: [] as string[] };
    const forged = canonical().replace("repo:10", "repo:999");
    const out = await handleCommentEdited(deps("admin", captured), payload(forged));
    assert.equal(out.kind, "ignored");
    assert.equal(captured.updates.length, 0);
  });
});
