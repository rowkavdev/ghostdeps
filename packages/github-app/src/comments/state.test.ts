import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maintainComment, type IssuesClient } from "./state.js";
import { buildMarker } from "./marker.js";

const SHA = "e".repeat(40);
const MARKER = { repositoryId: 3, pullNumber: 11, headSha: SHA, keys: [] };

interface Call {
  method: string;
  body?: string;
}
function client(comments: { id: number; body: string; login: string }[]) {
  const calls: Call[] = [];
  const issues: IssuesClient = {
    issues: {
      listComments: async () => ({
        data: comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.login } })),
      }),
      createComment: async (p: { body: string }) => {
        calls.push({ method: "create", body: p.body });
        return { data: { id: 500 } };
      },
      updateComment: async (p: { comment_id: number; body: string }) => {
        calls.push({ method: "update", body: p.body });
        return { data: { id: p.comment_id } };
      },
    } as unknown as IssuesClient["issues"],
  };
  return { issues, calls };
}

const input = (body: string) => ({
  owner: "o",
  repo: "r",
  pullNumber: 11,
  botLogin: "ghostdeps[bot]",
  body,
  marker: MARKER,
});

describe("maintainComment", () => {
  const body = `${buildMarker(MARKER)}\nhello`;

  it("creates when no owned comment exists", async () => {
    const { issues, calls } = client([{ id: 1, body: "unrelated", login: "someone" }]);
    const out = await maintainComment(issues, input(body));
    assert.deepEqual(out, { action: "created", commentId: 500 });
    assert.equal(calls[0]?.method, "create");
  });

  it("updates the existing owned comment when the body changed", async () => {
    const { issues, calls } = client([
      { id: 7, body: `${buildMarker(MARKER)}\nold`, login: "ghostdeps[bot]" },
    ]);
    const out = await maintainComment(issues, input(body));
    assert.deepEqual(out, { action: "updated", commentId: 7 });
    assert.equal(calls[0]?.method, "update");
  });

  it("is a no-op on an identical render", async () => {
    const { issues, calls } = client([{ id: 7, body, login: "ghostdeps[bot]" }]);
    assert.deepEqual(await maintainComment(issues, input(body)), {
      action: "unchanged",
      commentId: 7,
    });
    assert.equal(calls.length, 0);
  });

  it("refuses ambiguity: two owned comments, no writes", async () => {
    const { issues, calls } = client([
      { id: 7, body, login: "ghostdeps[bot]" },
      { id: 8, body, login: "ghostdeps[bot]" },
    ]);
    const out = await maintainComment(issues, input(body));
    assert.equal(out.action, "ambiguous");
    assert.equal(calls.length, 0);
  });

  it("ignores marker-shaped comments from other authors", async () => {
    const { issues, calls } = client([{ id: 7, body, login: "impersonator" }]);
    const out = await maintainComment(issues, input(body));
    assert.equal(out.action, "created");
    assert.equal(calls[0]?.method, "create");
  });

  it("ignores our comments whose marker is for another repository", async () => {
    const other = buildMarker({ repositoryId: 999, pullNumber: 11, headSha: SHA, keys: [] });
    const { issues } = client([{ id: 7, body: `${other}\nx`, login: "ghostdeps[bot]" }]);
    assert.equal((await maintainComment(issues, input(body))).action, "created");
  });
});
