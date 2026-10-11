import assert from "node:assert/strict";
import { it } from "node:test";
import { maintainPrReport, type ReportClient } from "./pr-report.js";
import { renderCheck } from "./render.js";

const rendered = renderCheck(
  {
    schemaVersion: 1,
    projects: [],
    dependencies: [],
    usages: [],
    findings: [],
    detected: [],
    surface: [],
  },
  new Map(),
  [],
);
const input = {
  botLogin: "github-actions[bot]",
  channel: "action" as const,
  sha: "a".repeat(40),
  rendered,
};

it("creates, reuses and updates one owned report; ignores spoofed markers", async () => {
  const comments = [
    { id: 1, user: { login: "someone" }, body: "<!-- ghostdeps:report:action:v1 -->\nspoof" },
  ];
  let edits = 0;
  const client: ReportClient = {
    listComments: async () => comments,
    createComment: async (body) => comments.push({ id: 2, user: { login: input.botLogin }, body }),
    updateComment: async (id, body) => {
      edits++;
      comments.find((c) => c.id === id)!.body = body;
    },
  };
  assert.equal(await maintainPrReport(client, input), "created");
  assert.equal(await maintainPrReport(client, input), "unchanged");
  assert.equal(await maintainPrReport(client, { ...input, sha: "b".repeat(40) }), "updated");
  assert.equal(comments.length, 2);
  assert.equal(edits, 1);
  assert.match(comments[1]!.body, /No significant dependency issues/);
  assert.doesNotMatch(comments[1]!.body, /\[ \]/);
});

it("refuses writes when pagination is exhausted or ownership is ambiguous", async () => {
  let writes = 0;
  const client: ReportClient = {
    listComments: async () => Array.from({ length: 100 }, () => ({ id: 1 })),
    createComment: async () => {
      writes++;
    },
    updateComment: async () => {
      writes++;
    },
  };
  await assert.rejects(maintainPrReport(client, input), /discovery incomplete/);
  client.listComments = async () =>
    [1, 2].map((id) => ({
      id,
      user: { login: input.botLogin },
      body: "<!-- ghostdeps:report:action:v1 -->\nx",
    }));
  await assert.rejects(maintainPrReport(client, input), /ambiguous/);
  assert.equal(writes, 0);
});
