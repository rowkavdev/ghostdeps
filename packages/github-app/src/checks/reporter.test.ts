import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisResult, Finding } from "@ghostdeps/core";
import { addedLinesFromFiles, addedLinesFromPatch } from "./diff.js";
import { maxAnnotations, md, quietSummary, renderCheck } from "./render.js";
import { CheckReporter, type ChecksClient } from "./reporter.js";

function result(findings: Finding[]): AnalysisResult {
  return {
    schemaVersion: 1,
    projects: [],
    dependencies: [],
    usages: [],
    findings,
    detected: [],
    surface: [],
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    kind: "unused",
    dependency: "left-pad",
    summary: "left-pad is declared but never imported",
    recommendation: "Remove left-pad from dependencies",
    evidence: [
      { kind: "declared", statement: "declared in package.json", file: "package.json", line: 12 },
    ],
    confidence: "high",
    limitations: [],
    affectedFiles: ["package.json"],
    ...over,
  };
}

const added = new Map([["package.json", new Set([12])]]);

describe("addedLinesFromPatch", () => {
  it("returns new-file line numbers of added lines only", () => {
    const patch = [
      "@@ -10,4 +10,5 @@",
      " a",
      "-b",
      "+B",
      "+C",
      " d",
      "\\ No newline at end of file",
    ].join("\n");
    assert.deepEqual([...addedLinesFromPatch(patch)], [11, 12]);
  });

  it("handles multiple hunks and missing patches", () => {
    const patch = ["@@ -1 +1 @@", "-x", "+y", "@@ -20,2 +20,3 @@", " p", "+q", " r"].join("\n");
    assert.deepEqual([...addedLinesFromPatch(patch)], [1, 21]);
    assert.equal(addedLinesFromPatch(undefined).size, 0);
    assert.equal(addedLinesFromFiles([{ filename: "bin.png" }]).size, 0);
  });
});

describe("renderCheck", () => {
  it("is success with the quiet summary when there are no findings", () => {
    const out = renderCheck(result([]), added);
    assert.equal(out.conclusion, "success");
    assert.equal(out.output.summary, quietSummary);
    assert.equal(out.output.annotations.length, 0);
  });

  it("is neutral, never failure, when there are findings", () => {
    assert.equal(
      renderCheck(result([finding({ confidence: "low" })]), added).conclusion,
      "neutral",
    );
  });

  it("annotates a high-confidence finding on a PR-added line", () => {
    const out = renderCheck(result([finding()]), added);
    assert.equal(out.output.annotations.length, 1);
    const a = out.output.annotations[0]!;
    assert.equal(a.path, "package.json");
    assert.equal(a.start_line, 12);
    assert.equal(a.annotation_level, "notice");
    assert.match(a.message, /declared in package\.json/);
  });

  it("keeps findings off unchanged lines, lower confidence, and pushes in the summary", () => {
    const offDiff = finding({
      evidence: [{ kind: "declared", statement: "x", file: "package.json", line: 3 }],
    });
    const medium = finding({ dependency: "moment", confidence: "medium" });
    const out = renderCheck(result([offDiff, medium]), added);
    assert.equal(out.output.annotations.length, 0);
    assert.match(out.output.summary, /High confidence/);
    assert.match(out.output.summary, /<details>/);
    assert.match(out.output.summary, /moment/);
    assert.equal(renderCheck(result([finding()]), new Map()).output.annotations.length, 0);
  });

  it(`caps annotations at ${maxAnnotations} and reports the overflow in the summary`, () => {
    const lines = new Set(Array.from({ length: 60 }, (_, i) => i + 1));
    const many = Array.from({ length: 60 }, (_, i) =>
      finding({
        dependency: `dep${i}`,
        evidence: [{ kind: "declared", statement: "d", file: "package.json", line: i + 1 }],
      }),
    );
    const out = renderCheck(result(many), new Map([["package.json", lines]]));
    assert.equal(out.output.annotations.length, maxAnnotations);
    assert.match(out.output.summary, /10 more high-confidence findings exceeded/);
  });

  it("renders repository text as data", () => {
    const hostile = finding({
      dependency: "evil](https://x.test)<img src=x>",
      summary: "line1\n# heading \u202e",
      confidence: "low",
    });
    const out = renderCheck(result([hostile]), added);
    assert.doesNotMatch(out.output.summary, /(^|[^\\])<img/);
    assert.doesNotMatch(out.output.summary, /(^|[^\\])\]\(https/);
    assert.doesNotMatch(out.output.summary, /\u202e/);
    assert.equal(md("a*b"), "a\\*b");
  });
});

function fakeClient(existing: { id: number; app?: { id: number }; external_id?: string }[] = []) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const client: ChecksClient = {
    checks: {
      async listForRef(params) {
        calls.push({ op: "list", params });
        return { data: { check_runs: existing } };
      },
      async create(params) {
        calls.push({ op: "create", params });
        await new Promise((r) => setTimeout(r, 5));
        return { data: { id: 99 } };
      },
      async update(params) {
        calls.push({ op: "update", params });
        return { data: { id: Number(params.check_run_id) } };
      },
    },
  };
  return { client, calls };
}

const target = {
  owner: "acme",
  repo: "demo",
  headSha: "h".repeat(40),
  externalId: "acme/demo@h",
  appId: 1,
};

describe("CheckReporter", () => {
  it("creates one in_progress run and completes it in one update", async () => {
    const { client, calls } = fakeClient();
    const r = new CheckReporter(client);
    const { checkRunId, created } = await r.start(target);
    assert.equal(created, true);
    await r.complete(target, checkRunId, result([finding()]), added);
    assert.deepEqual(
      calls.map((c) => c.op),
      ["list", "create", "update"],
    );
    assert.equal(calls[1]!.params.status, "in_progress");
    assert.equal(calls[1]!.params.name, "ghostdeps");
    assert.equal(calls[2]!.params.conclusion, "neutral");
    assert.equal(calls[2]!.params.status, "completed");
  });

  it("does not create a second run when this app already has one for the SHA", async () => {
    const { client, calls } = fakeClient([{ id: 5, app: { id: 1 } }]);
    const res = await new CheckReporter(client).start(target);
    assert.deepEqual(res, { checkRunId: 5, created: false });
    assert.equal(
      calls.some((c) => c.op === "create"),
      false,
    );
  });

  it("ignores another app's run with the same name", async () => {
    const { client } = fakeClient([{ id: 5, app: { id: 777 } }]);
    const res = await new CheckReporter(client).start(target);
    assert.equal(res.created, true);
  });

  it("records a neutral busy run that a later analysis does not reuse", async () => {
    const { client, calls } = fakeClient();
    const r = new CheckReporter(client);
    await r.busy(target);
    const created = calls.find((c) => c.op === "create")!.params;
    assert.equal(created.status, "completed");
    assert.equal(created.conclusion, "neutral");
    assert.equal(created.external_id, "busy:acme/demo@h");
    assert.match(String((created.output as { summary: string }).summary), /Push a new commit/);

    const later = fakeClient([{ id: 5, app: { id: 1 }, external_id: "busy:acme/demo@h" }]);
    const res = await new CheckReporter(later.client).start(target);
    assert.equal(res.created, true);
  });

  it("collapses concurrent duplicate deliveries onto one run", async () => {
    const { client, calls } = fakeClient();
    const r = new CheckReporter(client);
    const [a, b] = await Promise.all([r.start(target), r.start(target)]);
    assert.equal(calls.filter((c) => c.op === "create").length, 1);
    assert.equal(a.checkRunId, b.checkRunId);
    assert.equal([a.created, b.created].filter(Boolean).length, 1);
  });
});

describe("CheckReporter against the GitHub REST API (nock)", () => {
  it("lists, creates and completes one check run with the documented request shapes", async () => {
    const nock = (await import("nock")).default;
    const { ProbotOctokit } = await import("probot");
    nock.disableNetConnect();
    const bodies: Record<string, unknown>[] = [];
    const api = nock("https://api.github.com")
      .get(`/repos/acme/demo/commits/${target.headSha}/check-runs`)
      .query({ check_name: "ghostdeps", filter: "latest", per_page: "10", app_id: "1" })
      .reply(200, { total_count: 0, check_runs: [] })
      .post("/repos/acme/demo/check-runs", (b: Record<string, unknown>) => {
        bodies.push(b);
        return true;
      })
      .reply(201, { id: 321 })
      .patch("/repos/acme/demo/check-runs/321", (b: Record<string, unknown>) => {
        bodies.push(b);
        return true;
      })
      .reply(200, { id: 321 });
    try {
      const octokit = new ProbotOctokit({ auth: { token: "test" }, retry: { enabled: false } });
      const reporter = new CheckReporter(octokit.rest);
      const { checkRunId } = await reporter.start(target);
      await reporter.complete(target, checkRunId, result([]), added);
      assert.ok(api.isDone());
      assert.equal(bodies[0]?.name, "ghostdeps");
      assert.equal(bodies[0]?.status, "in_progress");
      assert.equal(bodies[0]?.external_id, "acme/demo@h");
      assert.equal(bodies[1]?.conclusion, "success");
      assert.deepEqual(bodies[1]?.output, {
        title: quietSummary,
        summary: quietSummary,
        annotations: [],
      });
    } finally {
      nock.cleanAll();
      nock.enableNetConnect();
    }
  });
});
