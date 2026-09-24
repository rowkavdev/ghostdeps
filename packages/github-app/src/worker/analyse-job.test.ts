import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDefaultPolicy, severityOf, type AnalysisResult } from "@ghostdeps/core";
import type { AnalysisJob } from "../jobs.js";
import {
  analyseCheckout,
  createAnalysisWorker,
  DEFAULT_ADAPTER_MODULES,
  type AnalyseRunOptions,
  type RepositoryClient,
} from "./analyse-job.js";
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
    /** `${ref}:${path}` -> raw file text */
    files?: Record<string, string>;
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

  it("analyses the full repository when the changes cannot be read in full", async () => {
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
    assert.deepEqual(seen, {});
    assert.equal(rec.updated.length, 1);
    assert.notEqual(
      (rec.updated[0]?.output as { title?: string }).title,
      "GhostDeps could not run",
    );
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
      assert.deepEqual(seen, {});
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

  it("reports an unused dependency, capped at medium severity (#173)", async () => {
    const result = await analyseCheckout(await unusedRepo(), DEFAULT_ADAPTER_MODULES, policy);
    const unused = result.findings.filter((f) => f.kind === "unused");
    assert.deepEqual(
      unused.map((f) => f.dependency),
      ["left-pad"],
    );
    for (const f of unused) assert.equal(severityOf(f), "medium");
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
});
