import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AnalysisResult } from "@ghostdeps/core";
import type { AnalysisJob } from "../jobs.js";
import { createAnalysisWorker, type RepositoryClient } from "./analyse-job.js";
import { tarGz, type TarEntry } from "./test-tar.js";

const SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
const APP_ID = 123;
const ROOT = "octo-org-example-app-6dcb09b/";

function job(
  trigger: AnalysisJob["trigger"] = {
    kind: "push",
    ref: "refs/heads/main",
    beforeSha: "0".repeat(40),
  },
): AnalysisJob {
  return {
    key: `872001:${SHA}`,
    deliveryId: "delivery-1",
    installationId: 55501,
    repository: { id: 872001, owner: "octo-org", name: "example-app" },
    headSha: SHA,
    trigger,
  };
}

interface Recorded {
  created: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  tarballRequests: number;
}

function fakeClient(options: { existingRunId?: number; location?: string } = {}): {
  client: RepositoryClient;
  rec: Recorded;
} {
  const rec: Recorded = { created: [], updated: [], tarballRequests: 0 };
  const client: RepositoryClient = {
    checks: {
      async listForRef() {
        return {
          data: {
            check_runs:
              options.existingRunId !== undefined
                ? [{ id: options.existingRunId, external_id: `872001:${SHA}`, app: { id: APP_ID } }]
                : [],
          },
        };
      },
      async create(params) {
        rec.created.push(params);
        return { data: { id: 900 + rec.created.length } };
      },
      async update(params) {
        rec.updated.push(params);
        return { data: { id: params.check_run_id } };
      },
    },
    async request() {
      rec.tarballRequests++;
      return {
        status: 302,
        headers: {
          location:
            options.location ??
            `https://codeload.github.com/octo-org/example-app/legacy.tar.gz/${SHA}`,
        },
      };
    },
  };
  return { client, rec };
}

function fetchServing(archive: Uint8Array): typeof fetch {
  return (async (url: string | URL) => {
    assert.equal(new URL(String(url)).hostname, "codeload.github.com");
    return new Response(archive, { status: 200 });
  }) as typeof fetch;
}

const repo: TarEntry[] = [
  { name: ROOT, type: "directory" },
  {
    name: `${ROOT}package.json`,
    body: JSON.stringify({ name: "example", dependencies: { "left-pad": "^1.3.0" } }),
  },
  { name: `${ROOT}src/`, type: "directory" },
  {
    name: `${ROOT}src/index.js`,
    body: 'import leftPad from "left-pad";\nconsole.log(leftPad("x", 3));\n',
  },
];

const emptyResult = { findings: [] } as unknown as AnalysisResult;

async function workRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ghostdeps-worker-test-"));
}

describe("analysis worker", () => {
  it("claims the SHA, analyses the extracted checkout and completes the run", async () => {
    const { client, rec } = fakeClient();
    const root = await workRoot();
    let analysedRoot = "";
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: root,
      fetch: fetchServing(tarGz(repo)),
      analyse: async (dir) => {
        analysedRoot = dir;
        assert.deepEqual((await readdir(dir)).sort(), ["package.json", "src"]);
        return emptyResult;
      },
    });
    await worker(job());
    assert.ok(analysedRoot.endsWith(ROOT.slice(0, -1)), "analyses inside the codeload root dir");
    assert.equal(rec.created.length, 1);
    assert.equal(rec.created[0]?.status, "in_progress");
    assert.equal(rec.created[0]?.head_sha, SHA);
    assert.equal(rec.updated.length, 1);
    assert.equal(rec.updated[0]?.conclusion, "success");
    assert.deepEqual(await readdir(root), [], "checkout removed afterwards");
  });

  it("runs the real isolated engine with the JS adapter end to end", async () => {
    const { client, rec } = fakeClient();
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(repo)),
    });
    await worker(job());
    assert.equal(rec.updated.length, 1);
    const conclusion = rec.updated[0]?.conclusion;
    assert.ok(conclusion === "success" || conclusion === "neutral", String(conclusion));
    assert.notEqual(
      (rec.updated[0]?.output as { title?: string }).title,
      "GhostDeps could not run",
    );
  });

  it("skips a SHA that already has our run, without downloading", async () => {
    const { client, rec } = fakeClient({ existingRunId: 77 });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      analyse: async () => assert.fail("should not analyse"),
    });
    await worker(job());
    assert.equal(rec.created.length, 0);
    assert.equal(rec.tarballRequests, 0);
  });

  it("re-runs create a fresh run even when one exists", async () => {
    const { client, rec } = fakeClient({ existingRunId: 77 });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(repo)),
      analyse: async () => emptyResult,
    });
    await worker(job({ kind: "rerequested", checkRunId: 77 }));
    assert.equal(rec.created.length, 1);
    assert.equal(rec.updated[0]?.check_run_id, 901);
  });

  it("ends in a neutral run when the archive fails the safety checks", async () => {
    const { client, rec } = fakeClient();
    const root = await workRoot();
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: root,
      fetch: fetchServing(tarGz([{ name: "../escape.txt", body: "x" }])),
      analyse: async () => assert.fail("should not analyse"),
    });
    await worker(job());
    assert.equal(rec.updated[0]?.conclusion, "neutral");
    const output = rec.updated[0]?.output as { title: string; summary: string };
    assert.equal(output.title, "GhostDeps could not run");
    assert.match(output.summary, /safety checks/);
    assert.deepEqual(await readdir(root), []);
  });

  it("refuses a tarball redirect to an unexpected host", async () => {
    const { client, rec } = fakeClient({ location: "https://evil.example/archive.tar.gz" });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: (async () => assert.fail("should not fetch")) as typeof fetch,
    });
    await worker(job());
    assert.equal(rec.updated[0]?.conclusion, "neutral");
    assert.match(
      (rec.updated[0]?.output as { summary: string }).summary,
      /could not be downloaded/,
    );
  });

  it("stops reading once the tarball passes the byte ceiling", async () => {
    const { client, rec } = fakeClient();
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      maxTarballBytes: 64,
      fetch: fetchServing(tarGz(repo)),
      analyse: async () => assert.fail("should not analyse"),
    });
    await worker(job());
    assert.match((rec.updated[0]?.output as { summary: string }).summary, /larger than/);
  });
});
