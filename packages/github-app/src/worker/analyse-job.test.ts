import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDefaultPolicy, severityOf, type AnalysisResult } from "@ghostdeps/core";
import { renderCheck } from "@ghostdeps/checks-renderer";
import type { AnalysisJob } from "../jobs.js";
import { ResultCache } from "./result-cache.js";
import {
  analyseCheckout,
  createAnalysisWorker,
  excludedChangesNote,
  DEFAULT_ADAPTER_MODULES,
  failureReason,
  type AnalyseRunOptions,
  type RepositoryClient,
} from "./analyse-job.js";
import { NpmMetadataService } from "./npm-metadata.js";
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
  compares: string[];
}

function fakeClient(
  options: {
    existingRunId?: number;
    location?: string;
    /** base...head diff; an object throws with that status. */
    diff?: string | { status: number };
    /** `${ref}:${path}` -> raw file text; an object throws with that status. */
    files?: Record<string, string | { status: number }>;
  } = {},
): {
  client: RepositoryClient;
  rec: Recorded;
} {
  const rec: Recorded = { created: [], updated: [], tarballRequests: 0, compares: [] };
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
    request: (async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        rec.compares.push(String(params.basehead));
        const diff = options.diff;
        if (diff === undefined || typeof diff !== "string") {
          throw Object.assign(new Error("http"), diff ?? { status: 404 });
        }
        return { data: diff };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const file = options.files?.[`${String(params.ref)}:${String(params.path)}`];
        if (file === undefined) throw Object.assign(new Error("not found"), { status: 404 });
        if (typeof file !== "string") throw Object.assign(new Error("http"), file);
        return { data: file };
      }
      rec.tarballRequests++;
      return {
        status: 302,
        headers: {
          location:
            options.location ??
            `https://codeload.github.com/octo-org/example-app/legacy.tar.gz/${SHA}`,
        },
      };
    }) as RepositoryClient["request"],
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

describe("analysis worker: pull request context (#115)", async () => {
  const payload = JSON.parse(
    await readFile(
      new URL("../../test/fixtures/pull_request.opened.json", import.meta.url),
      "utf8",
    ),
  ) as { number: number; pull_request: { base: { sha: string }; head: { sha: string } } };
  const BASE = payload.pull_request.base.sha;
  const HEAD = payload.pull_request.head.sha;
  const prJob = job({
    kind: "pull_request",
    number: payload.number,
    action: "opened",
    baseSha: BASE,
  });

  const DIFF = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"name":"example","dependencies":{"left-pad":"^1.3.0"}}
+{"name":"example","dependencies":{"left-pad":"^1.3.0","axios":"^1.7.0"}}
diff --git a/src/index.js b/src/index.js
index 3333333..4444444 100644
--- a/src/index.js
+++ b/src/index.js
@@ -1,2 +1,3 @@
 import leftPad from "left-pad";
 console.log(leftPad("x", 3));
+console.log("hi");
`;
  const files = {
    [`${BASE}:package.json`]: JSON.stringify({
      name: "example",
      dependencies: { "left-pad": "^1.3.0" },
    }),
    [`${HEAD}:package.json`]: JSON.stringify({
      name: "example",
      dependencies: { "left-pad": "^1.3.0", axios: "^1.7.0" },
    }),
  };
  const prRepo: TarEntry[] = [
    ...repo.filter((e) => !e.name.endsWith("package.json")),
    { name: `${ROOT}package.json`, body: files[`${HEAD}:package.json`] ?? "" },
  ];

  it("passes the PR's dependency changes to the engine (recorded payload)", async () => {
    const { client, rec } = fakeClient({ diff: DIFF, files });
    let seen: AnalyseRunOptions | undefined;
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(prJob);
    assert.deepEqual(rec.compares, [`${BASE}...${HEAD}`]);
    assert.deepEqual(
      seen?.pullRequestChanges?.map((c) => [c.change, c.name, c.usageCheck]),
      [["added", "axios", "pending"]],
    );
    assert.equal(rec.updated[0]?.conclusion, "success");
  });

  it("scopes a source-only PR with an empty change list, not a full analysis (#101)", async () => {
    const sourceOnly = DIFF.slice(DIFF.indexOf("diff --git a/src/index.js"));
    const { client, rec } = fakeClient({ diff: sourceOnly, files });
    let seen: AnalyseRunOptions | undefined;
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(prJob);
    assert.deepEqual(seen?.pullRequestChanges, []);
    assert.equal(rec.updated[0]?.conclusion, "success");
  });

  it("passes removed source lines so a removed last import can be reported (#101)", async () => {
    const removal = `diff --git a/src/index.js b/src/index.js
index 3333333..4444444 100644
--- a/src/index.js
+++ b/src/index.js
@@ -1,2 +1,1 @@
-import leftPad from "left-pad";
 console.log(leftPad("x", 3));
`;
    const { client } = fakeClient({ diff: removal, files });
    let seen: AnalyseRunOptions | undefined;
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(prJob);
    assert.deepEqual(seen?.pullRequestChanges, []);
    const source = seen?.pullRequestSourceChanges ?? [];
    assert.deepEqual(
      source.map((f) => f.path),
      ["src/index.js"],
    );
    assert.equal(source[0]?.removedLines.length, 1);
    assert.match(source[0]?.removedLines[0]?.text ?? "", /left-pad/);
    assert.deepEqual(source[0]?.addedLines, []);
  });

  it("keeps a source-only PR PR-scoped when its diff can't be read in full (#101)", async () => {
    const { client, rec } = fakeClient({ diff: { status: 406 } });
    let seen: AnalyseRunOptions | undefined;
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(
      job({
        kind: "pull_request",
        number: payload.number,
        action: "opened",
        baseSha: BASE,
        sourceOnly: true,
      }),
    );
    assert.deepEqual(seen, {
      pullRequestChanges: [],
      fixtureScope: true,
      analysedSha: SHA,
    });
    // The app made the skip, so the app says so; the run isn't a clean green (#195).
    const out = rec.updated[0]?.output as { title?: string; summary?: string };
    const text = (out.summary ?? "").replace(/\\/g, ""); // summary text is Markdown-escaped
    assert.equal(rec.updated[0]?.conclusion, "neutral");
    assert.equal(out.title, "Analysis incomplete - see notes");
    assert.match(text, /Removed-usage check skipped: this pull request's diff was too large/);
    assert.equal(text.match(/Removed-usage check skipped/g)?.length, 1);
  });

  it("adds no app note when the diff was read in full", async () => {
    const { client, rec } = fakeClient({ diff: DIFF, files });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async () => emptyResult,
    });
    await worker(prJob);
    assert.equal(rec.updated[0]?.conclusion, "success");
    assert.doesNotMatch(
      ((rec.updated[0]?.output as { summary?: string }).summary ?? "").replace(/\\/g, ""),
      /Removed-usage check skipped/,
    );
  });

  async function checkOutputFor(j: AnalysisJob, diff: string | { status: number }) {
    const { client, rec } = fakeClient({ diff, files });
    let seen: AnalyseRunOptions | undefined;
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(j);
    const update = rec.updated[0];
    return { seen, conclusion: update?.conclusion, output: update?.output };
  }

  it("a re-run of a source-only PR matches the first run when the diff is unreadable (#196)", async () => {
    const first = await checkOutputFor(
      job({
        kind: "pull_request",
        number: payload.number,
        action: "opened",
        baseSha: BASE,
        sourceOnly: true,
      }),
      { status: 406 },
    );
    const rerun = await checkOutputFor(
      job({
        kind: "rerequested",
        checkRunId: 7,
        pullRequest: { number: payload.number, baseSha: BASE, sourceOnly: true },
      }),
      { status: 406 },
    );
    assert.deepEqual(rerun, first);
    assert.deepEqual(rerun.seen, {
      pullRequestChanges: [],
      fixtureScope: true,
      analysedSha: SHA,
    });
  });

  it("a re-run without the source-only flag falls back to full with a note, like a capped first run (#196)", async () => {
    const first = await checkOutputFor(
      job({ kind: "pull_request", number: payload.number, action: "opened", baseSha: BASE }),
      { status: 406 },
    );
    const rerun = await checkOutputFor(
      job({
        kind: "rerequested",
        checkRunId: 7,
        pullRequest: { number: payload.number, baseSha: BASE },
      }),
      { status: 406 },
    );
    assert.deepEqual(rerun, first);
    assert.deepEqual(rerun.seen, { fixtureScope: false, analysedSha: SHA });
    assert.equal(rerun.conclusion, "neutral");
    const text = ((rerun.output as { summary?: string }).summary ?? "").replace(/\\/g, "");
    assert.match(text, /GhostDeps analysed the whole repository/);
  });

  describe("same-SHA re-run result cache (#174)", () => {
    const rerunJob = (over: { baseSha?: string; sourceOnly?: true } = {}) =>
      job({
        kind: "rerequested",
        checkRunId: 7,
        pullRequest: {
          number: payload.number,
          baseSha: over.baseSha ?? BASE,
          ...(over.sourceOnly ? { sourceOnly: true as const } : {}),
        },
      });

    async function runBoth(opts: {
      result?: AnalysisResult;
      rerun?: AnalysisJob;
      cache?: ResultCache | false;
      metadata?: NpmMetadataService;
    }) {
      const cache = opts.cache ?? new ResultCache();
      let calls = 0;
      const outputs: unknown[] = [];
      for (const j of [prJob, opts.rerun ?? rerunJob()]) {
        const { client, rec } = fakeClient({ diff: DIFF, files });
        const worker = createAnalysisWorker({
          appId: APP_ID,
          clientFor: async () => client,
          workRoot: await workRoot(),
          fetch: fetchServing(tarGz(prRepo)),
          resultCache: cache,
          ...(opts.metadata ? { metadata: opts.metadata } : {}),
          analyse: async (_root, _mods, run) => {
            calls++;
            // Stand in for core asking for footprints.
            await run.metadata?.installSizes({
              ecosystem: "javascript-typescript",
              packages: [{ name: "a", version: "1.0.0", origin: "https://registry.npmjs.org" }],
            });
            return opts.result ?? emptyResult;
          },
        });
        await worker(j);
        const u = rec.updated.at(-1);
        outputs.push({ conclusion: u?.conclusion, output: u?.output });
      }
      return { calls, outputs, cache };
    }

    it("serves a same-SHA re-run from the cache with identical output", async () => {
      const { calls, outputs } = await runBoth({});
      assert.equal(calls, 1);
      assert.deepEqual(outputs[1], outputs[0]);
    });

    it("caches with a complete footprint, never with a truncated one (#313 review)", async () => {
      const sized = async () => ({
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ dist: { unpackedSize: 10 } }));
        })(),
      });
      const complete = new NpmMetadataService({ fetch: sized });
      assert.equal((await runBoth({ metadata: complete })).calls, 1);
      // A zero budget truncates every answer: post it, but don't cache it.
      const truncated = new NpmMetadataService({ fetch: sized, fetchBudget: 0 });
      assert.equal((await runBoth({ metadata: truncated })).calls, 2);
    });

    it("misses on a different base SHA or source-only flag", async () => {
      assert.equal((await runBoth({ rerun: rerunJob({ baseSha: "c".repeat(40) }) })).calls, 2);
      assert.equal((await runBoth({ rerun: rerunJob({ sourceOnly: true }) })).calls, 2);
    });

    it("never caches an analysis with an adapter error", async () => {
      const failed: AnalysisResult = {
        ...emptyResult,
        findings: [
          {
            kind: "info",
            summary: "javascript-typescript analysis incomplete: usage analysis timed out",
            recommendation: "Manual review recommended for this ecosystem.",
            evidence: [
              {
                kind: "adapter-error",
                statement: "javascript-typescript adapter usage analysis stage",
              },
            ],
            confidence: "low",
            limitations: [],
            affectedFiles: [],
          },
        ],
      };
      const { calls, cache } = await runBoth({ result: failed });
      assert.equal(calls, 2);
      assert.equal((cache as ResultCache).size, 0);
    });

    it("can be turned off", async () => {
      assert.equal((await runBoth({ cache: false })).calls, 2);
    });
  });

  it("analyses the full repository when the changes cannot be read in full", async () => {
    // The fallback stays PR-triggered, so fixture scope stays OFF (#354):
    // a head-only scope here would hide changed fixture paths without the
    // base/head comparison the PR contract requires.
    const { client, rec } = fakeClient({ diff: { status: 406 } });
    let seen: AnalyseRunOptions | undefined;
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(prJob);
    assert.deepEqual(seen, { fixtureScope: false, analysedSha: SHA });
    assert.equal(rec.updated.length, 1);
    assert.notEqual(
      (rec.updated[0]?.output as { title?: string }).title,
      "GhostDeps could not run",
    );
  });

  const scopedRepo: TarEntry[] = [
    ...prRepo,
    {
      name: `${ROOT}.ghostdeps.json`,
      body: JSON.stringify({ schemaVersion: 1, fixtureRoots: ["fixtures"] }),
    },
    { name: `${ROOT}fixtures/`, type: "directory" },
    {
      name: `${ROOT}fixtures/package.json`,
      body: JSON.stringify({ name: "fixture", private: true, dependencies: { decoy: "^1.0.0" } }),
    },
  ];

  it("keeps the unavailable-diff fallback unscoped on a configured repo (#354)", async () => {
    const { client, rec } = fakeClient({ diff: { status: 406 } });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(scopedRepo)),
    });
    await worker(prJob);
    const out = rec.updated[0]?.output as { title?: string; summary?: string };
    const text = (out.summary ?? "").replace(/\\/g, "");
    // The fallback note stays; fixture scope and its omission note stay off,
    // because a head-only scope would hide changed fixture paths (#354).
    assert.match(text, /analysed the whole repository/);
    assert.doesNotMatch(text, /### Scan scope/);
    assert.doesNotMatch(text, /fixture scope omitted/);
  });

  it("scopes push full scans end to end on a configured repo (#354)", async () => {
    const { client, rec } = fakeClient();
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(scopedRepo)),
    });
    await worker(job());
    const out = rec.updated[0]?.output as { title?: string; summary?: string };
    const text = (out.summary ?? "").replace(/\\/g, "");
    assert.match(text, /### Scan scope/);
    assert.match(text, /fixture scope omitted 1 file/);
    assert.match(text, new RegExp(`analysed SHA ${SHA}`));
  });

  it("does not fetch a diff for push jobs or fork re-runs", async () => {
    for (const trigger of [undefined, { kind: "rerequested", checkRunId: 5 } as const]) {
      const { client, rec } = fakeClient({ diff: DIFF, files });
      let seen: AnalyseRunOptions | undefined;
      const worker = createAnalysisWorker({
        appId: APP_ID,
        clientFor: async () => client,
        workRoot: await workRoot(),
        fetch: fetchServing(tarGz(prRepo)),
        analyse: async (_dir, _mods, run) => {
          seen = run;
          return emptyResult;
        },
      });
      await worker(job(trigger));
      assert.deepEqual(rec.compares, []);
      // Genuine full scans (no PR base) opt in to committed fixture scope and
      // stamp the analysed head SHA onto the scope record (#354).
      assert.deepEqual(seen, { fixtureScope: true, analysedSha: SHA });
    }
  });

  it("runs the real isolated engine in pull-request mode end to end", async () => {
    const { client, rec } = fakeClient({ diff: DIFF, files });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
    });
    await worker(prJob);
    assert.equal(rec.updated.length, 1);
    assert.notEqual(
      (rec.updated[0]?.output as { title?: string }).title,
      "GhostDeps could not run",
    );
  });

  const headConfig = JSON.stringify({ schemaVersion: 1, fixtureRoots: ["fixtures"] });
  const summaryText = (rec: Recorded): string => {
    const out = rec.updated[0]?.output as { title?: string; summary?: string };
    assert.notEqual(out.title, "GhostDeps could not run");
    return (out.summary ?? "").replace(/\\/g, "");
  };

  it("discloses a fixture-manifest change without analysing it (#354)", async () => {
    const fixtureDiff = `diff --git a/fixtures/package.json b/fixtures/package.json
index 1111111..2222222 100644
--- a/fixtures/package.json
+++ b/fixtures/package.json
@@ -1 +1 @@
-{"name":"fixture","private":true,"dependencies":{"decoy":"^1.0.0"}}
+{"name":"fixture","private":true,"dependencies":{"decoy":"^2.0.0"}}
`;
    const { client, rec } = fakeClient({
      diff: fixtureDiff,
      files: {
        [`${BASE}:fixtures/package.json`]: JSON.stringify({
          name: "fixture",
          private: true,
          dependencies: { decoy: "^1.0.0" },
        }),
        [`${HEAD}:fixtures/package.json`]: JSON.stringify({
          name: "fixture",
          private: true,
          dependencies: { decoy: "^2.0.0" },
        }),
        [`${BASE}:.ghostdeps.json`]: headConfig,
      },
    });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(scopedRepo)),
    });
    await worker(prJob);
    const text = summaryText(rec);
    assert.match(
      text,
      /changes 1 file\(s\) under excluded fixture roots \(fixtures\/package\.json\)/,
    );
    assert.match(text, /### Scan scope/);
    assert.doesNotMatch(text, /decoy/);
  });

  it("discloses old and new config digests when the PR changes the scope config (#354)", async () => {
    const { client, rec } = fakeClient({
      diff: DIFF,
      files: {
        ...files,
        [`${BASE}:.ghostdeps.json`]: JSON.stringify({
          schemaVersion: 1,
          fixtureRoots: ["old-fixtures"],
        }),
      },
    });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(scopedRepo)),
    });
    await worker(prJob);
    const text = summaryText(rec);
    assert.match(text, /Fixture scope configuration changed in this pull request/);
    assert.match(text, /roots added: fixtures/);
    assert.match(text, /roots removed: old-fixtures/);
    assert.match(text, /diff interpretation is incomplete/);
  });

  it("treats a committed base config with empty roots as a config, not an absence (#354)", async () => {
    const { client, rec } = fakeClient({
      diff: DIFF,
      files: {
        ...files,
        [`${BASE}:.ghostdeps.json`]: JSON.stringify({ schemaVersion: 1, fixtureRoots: [] }),
      },
    });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(scopedRepo)),
    });
    await worker(prJob);
    const text = summaryText(rec);
    assert.match(text, /Fixture scope configuration changed in this pull request/);
    assert.match(text, /roots added: fixtures/);
    assert.match(text, /roots removed: none/);
  });

  it("discloses an unreadable base config even when the head has none (#354)", async () => {
    const { client, rec } = fakeClient({
      diff: DIFF,
      files: { ...files, [`${BASE}:.ghostdeps.json`]: { status: 500 } },
    });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(prRepo)),
    });
    await worker(prJob);
    const text = summaryText(rec);
    assert.match(text, /base revision's fixture scope configuration could not be read/);
    assert.match(text, /diff interpretation is incomplete/);
  });

  it("posts the excluded-paths disclosure on a fixture-only source-only PR (#354)", async () => {
    const sourceDiff = `diff --git a/fixtures/tool.ts b/fixtures/tool.ts
new file mode 100644
index 0000000..1111111 100644
--- /dev/null
+++ b/fixtures/tool.ts
@@ -0,0 +1 @@
+export const x = 1;
`;
    const { client, rec } = fakeClient({
      diff: sourceDiff,
      files: { [`${BASE}:.ghostdeps.json`]: headConfig },
    });
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(scopedRepo)),
    });
    await worker(
      job({
        kind: "pull_request",
        number: payload.number,
        action: "opened",
        baseSha: BASE,
        sourceOnly: true,
      }),
    );
    const text = summaryText(rec);
    assert.match(text, /changes 1 file\(s\) under excluded fixture roots \(fixtures\/tool\.ts\)/);
    assert.doesNotMatch(text, /analysed the whole repository/);
  });
});

describe("analyseCheckout: scan completeness (#136)", () => {
  async function checkout(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-checkout-test-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { a: "1" } }),
    );
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/index.js"), 'import a from "a";\n');
    return dir;
  }
  const capture = () => {
    const seen: { options?: Record<string, unknown> } = {};
    const engine = (async (_handle: unknown, options: Record<string, unknown>) => {
      seen.options = options;
      return emptyResult;
    }) as unknown as Parameters<typeof analyseCheckout>[4];
    return { seen, engine };
  };

  it("sets scanIncomplete when the scan was truncated", async () => {
    const { seen, engine } = capture();
    await analyseCheckout(await checkout(), ["m"], {}, { limits: { maxFiles: 1 } }, engine);
    assert.equal(seen.options?.scanIncomplete, true);
    const notes = seen.options?.scanCompleteness as { kind: string; summary: string }[];
    assert.ok(notes.length > 0);
    assert.ok(notes.every((n) => n.kind === "info"));
    assert.match(notes[0]?.summary ?? "", /stopped early/);
  });

  it("surfaces the notes through the real engine", async () => {
    const result = await analyseCheckout(await checkout(), [], {}, { limits: { maxFiles: 1 } });
    assert.ok(result.findings.some((f) => f.kind === "info" && /stopped early/.test(f.summary)));
  });

  it("leaves scanIncomplete unset for a complete scan", async () => {
    const { seen, engine } = capture();
    await analyseCheckout(await checkout(), ["m"], {}, {}, engine);
    assert.equal(seen.options?.scanIncomplete, undefined);
    assert.equal(seen.options?.scanCompleteness, undefined);
    assert.deepEqual(seen.options?.adapters, ["m"]);
  });

  it("passes PR changes alongside", async () => {
    const { seen, engine } = capture();
    const changes = [
      { change: "added", name: "a", ecosystem: "javascript-typescript", manifest: "package.json" },
    ] as const;
    await analyseCheckout(await checkout(), ["m"], { pullRequestChanges: changes }, {}, engine);
    assert.deepEqual(seen.options?.pullRequestChanges, changes);
  });

  it("passes PR source line changes alongside (#101)", async () => {
    const { seen, engine } = capture();
    const source = [
      { path: "src/a.js", removedLines: [{ line: 1, text: 'import x from "x";' }], addedLines: [] },
    ];
    await analyseCheckout(
      await checkout(),
      ["m"],
      { pullRequestChanges: [], pullRequestSourceChanges: source },
      {},
      engine,
    );
    assert.deepEqual(seen.options?.pullRequestSourceChanges, source);
  });
});

describe("analyseCheckout: fixture scope (#354)", () => {
  async function scopedCheckout(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-scope-test-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", private: true, version: "0.0.0", dependencies: { a: "1" } }),
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/index.js"), 'import a from "a";\n');
    await mkdir(join(dir, "fixtures"));
    await writeFile(
      join(dir, "fixtures", "package.json"),
      JSON.stringify({ name: "fake", dependencies: { leftpad: "1" } }),
    );
    await writeFile(
      join(dir, ".ghostdeps.json"),
      JSON.stringify({ schemaVersion: 1, fixtureRoots: ["fixtures"] }),
    );
    return dir;
  }

  it("applies and discloses the committed config on full scans", async () => {
    const result = await analyseCheckout(await scopedCheckout(), [], { fixtureScope: true });
    assert.equal(result.scanScope?.source, "repo-config");
    assert.deepEqual(result.scanScope?.roots, [
      { root: "fixtures", matched: true, files: 1, manifests: 1 },
    ]);
    assert.ok(result.findings.some((f) => f.summary.includes("fixture scope omitted 1 file")));
  });

  it("does not scope runs the worker has not marked as full scans", async () => {
    // PR analyses pass pullRequestChanges; a PR-triggered full-repository
    // fallback passes neither flag. Both stay unscoped.
    const changes = [
      { change: "added", name: "a", ecosystem: "javascript-typescript", manifest: "package.json" },
    ] as const;
    for (const run of [{ pullRequestChanges: changes }, {}] as const) {
      const result = await analyseCheckout(await scopedCheckout(), [], run);
      assert.equal(result.scanScope, undefined);
      assert.ok(!result.findings.some((f) => f.summary.includes("fixture scope omitted")));
    }
  });

  it("fails visibly on a malformed config instead of analysing anyway", async () => {
    const dir = await scopedCheckout();
    await writeFile(join(dir, ".ghostdeps.json"), '{"schemaVersion":2,"fixtureRoots":[]}');
    await assert.rejects(analyseCheckout(dir, [], { fixtureScope: true }), /\.ghostdeps\.json/);
  });
});

describe("analyseCheckout: recommendation policy on the app path", () => {
  async function unusedRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-policy-test-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "p", dependencies: { "left-pad": "^1.3.0", lodash: "^4.0.0" } }),
    );
    await mkdir(join(dir, "src"));
    await writeFile(
      join(dir, "src/index.js"),
      'import _ from "lodash";\nconsole.log(_.chunk([1], 1));\n',
    );
    for (let i = 0; i < 3; i++)
      await writeFile(join(dir, `src/f${i}.js`), `export const a${i} = 1;\n`);
    return dir;
  }
  const policy = { recommend: createDefaultPolicy() };

  it("keeps a blocked native evaluation visible and neutral in the real App check output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-native-app-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    await writeFile(
      join(dir, "ghostdeps.targets.json"),
      JSON.stringify({
        schemaVersion: 1,
        complete: true,
        targets: [{ id: "production", runtime: "node", minVersion: "18.0.0" }],
      }),
    );
    await mkdir(join(dir, "src"));
    await writeFile(
      join(dir, "src/a.ts"),
      'import axios from "axios"; async function f() { const res = await axios.get("/x"); if (res.status === 200) return res.data; }',
    );
    const result = await analyseCheckout(dir, DEFAULT_ADAPTER_MODULES, policy);
    assert.equal(result.nativeEvaluations?.[0]?.status, "blocked");
    assert.ok(!result.findings.some((f) => f.kind === "potentially-unnecessary"));
    const check = renderCheck(result, new Map());
    assert.equal(check.conclusion, "neutral");
    assert.notEqual(check.output.title, "No significant dependency issues found.");
    assert.match(check.output.summary, /Native evaluation/);
    assert.ok(check.output.summary.includes(String.raw`blocked in deployment (below\-floor)`));
  });

  it("does not count an unchanged native candidate on a source-only or unrelated-dependency PR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghostdeps-native-pr-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    await writeFile(
      join(dir, "ghostdeps.targets.json"),
      JSON.stringify({
        schemaVersion: 1,
        complete: true,
        targets: [{ id: "production", runtime: "node", minVersion: "18.0.0" }],
      }),
    );
    await mkdir(join(dir, "src"));
    await writeFile(
      join(dir, "src/a.ts"),
      'import axios from "axios"; async function f() { const res = await axios.get("/x"); if (res.status === 200) return res.data; }',
    );
    const noDiff = await analyseCheckout(dir, DEFAULT_ADAPTER_MODULES, {
      ...policy,
      pullRequestChanges: [],
    });
    assert.equal(noDiff.nativeEvaluations, undefined);
    assert.ok(!noDiff.findings.some((f) => f.kind === "potentially-unnecessary"));
    const quiet = renderCheck(noDiff, new Map());
    assert.equal(quiet.conclusion, "success", quiet.output.summary);
    assert.doesNotMatch(quiet.output.summary, /Native evaluation/);
    const other = await analyseCheckout(dir, DEFAULT_ADAPTER_MODULES, {
      ...policy,
      pullRequestChanges: [
        {
          change: "added",
          name: "other",
          ecosystem: "javascript-typescript",
          manifest: "package.json",
        },
      ],
    });
    assert.equal(other.nativeEvaluations, undefined);
    assert.doesNotMatch(renderCheck(other, new Map()).output.summary, /Native evaluation/);
    const changed = await analyseCheckout(dir, DEFAULT_ADAPTER_MODULES, {
      ...policy,
      pullRequestChanges: [
        {
          change: "added",
          name: "axios",
          ecosystem: "javascript-typescript",
          manifest: "package.json",
        },
      ],
    });
    assert.equal(changed.nativeEvaluations?.[0]?.status, "blocked");
    assert.match(renderCheck(changed, new Map()).output.summary, /Native evaluation/);
  });

  it("reports an unused dependency, capped at medium severity and confidence (#173, #178)", async () => {
    const result = await analyseCheckout(await unusedRepo(), DEFAULT_ADAPTER_MODULES, policy);
    const unused = result.findings.filter((f) => f.kind === "unused");
    assert.deepEqual(
      unused.map((f) => f.dependency),
      ["left-pad"],
    );
    for (const f of unused) {
      assert.notEqual(f.confidence, "high");
      assert.ok(["info", "low", "medium"].includes(severityOf(f)), severityOf(f));
    }
  });

  it("never reports unused on a truncated checkout", async () => {
    const result = await analyseCheckout(await unusedRepo(), DEFAULT_ADAPTER_MODULES, policy, {
      limits: { maxFiles: 2 },
    });
    assert.equal(
      result.findings.some((f) => f.kind === "unused"),
      false,
    );
    assert.equal(
      result.findings.some((f) => f.confidence === "high" && f.kind !== "info"),
      false,
    );
    assert.ok(result.findings.some((f) => f.kind === "info" && /stopped early/.test(f.summary)));
  });

  it("reports facts only without a policy", async () => {
    const result = await analyseCheckout(await unusedRepo(), DEFAULT_ADAPTER_MODULES, {});
    assert.equal(
      result.findings.some((f) => f.kind === "unused"),
      false,
    );
  });

  it("the worker passes its policy through to the engine", async () => {
    const { client } = fakeClient();
    let seen: AnalyseRunOptions | undefined;
    const recommend = createDefaultPolicy();
    const worker = createAnalysisWorker({
      appId: APP_ID,
      clientFor: async () => client,
      workRoot: await workRoot(),
      fetch: fetchServing(tarGz(repo)),
      recommend,
      analyse: async (_dir, _mods, run) => {
        seen = run;
        return emptyResult;
      },
    });
    await worker(job());
    assert.equal(seen?.recommend, recommend);
  });

  it("passes footprint metadata only when set, a fresh provider per job (#174)", async () => {
    const seen: (AnalyseRunOptions | undefined)[] = [];
    const make = async (metadata?: NpmMetadataService) => {
      const { client } = fakeClient();
      return createAnalysisWorker({
        appId: APP_ID,
        clientFor: async () => client,
        workRoot: await workRoot(),
        fetch: fetchServing(tarGz(repo)),
        resultCache: false,
        ...(metadata ? { metadata } : {}),
        analyse: async (_dir, _mods, run) => {
          seen.push(run);
          return emptyResult;
        },
      });
    };
    await (
      await make()
    )(job());
    assert.equal(seen[0]?.metadata, undefined);
    const withMetadata = await make(new NpmMetadataService({ fetch: async () => ({}) as never }));
    await withMetadata(job());
    await withMetadata(job());
    assert.equal(typeof seen[1]?.metadata?.installSizes, "function");
    assert.notEqual(seen[1]?.metadata, seen[2]?.metadata);
  });
});

describe("failureReason", () => {
  it("says a rate-limited run should be re-run later (#255)", () => {
    const limited = {
      status: 403,
      message: "API rate limit exceeded",
      response: { headers: { "x-ratelimit-remaining": "0" } },
    };
    assert.match(failureReason(limited), /rate limit was reached\. Wait a few minutes/);
    assert.equal(failureReason(new Error("boom")), "an internal error stopped the analysis.");
  });
});

describe("excludedChangesNote (#354)", () => {
  it("lists bounded examples and summarises the rest", () => {
    assert.equal(
      excludedChangesNote({ count: 2, examples: ["fixtures/a.ts", "fixtures/b.ts"] }),
      "This pull request changes 2 file(s) under excluded fixture roots (fixtures/a.ts, fixtures/b.ts); they were not analysed.",
    );
    assert.equal(
      excludedChangesNote({
        count: 12,
        examples: ["f/1", "f/2", "f/3", "f/4", "f/5", "f/6", "f/7", "f/8", "f/9", "f/10"],
      }),
      "This pull request changes 12 file(s) under excluded fixture roots (f/1, f/2, f/3, f/4, f/5, f/6, f/7, f/8, f/9, f/10, +2 more); they were not analysed.",
    );
  });
});
