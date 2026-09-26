/**
 * End-to-end harness (#41): a recorded pull_request webhook goes through the
 * real app with its default worker - signature check, event filter,
 * in-process queue, repo-scoped token, tarball download and safe
 * extraction, PR diff, core's isolated engine with the JS adapter and the
 * default policy - and the test asserts on the check run the app writes.
 *
 * Only GitHub's HTTP API is simulated (nock). Anything not mocked fails the
 * test, and every mock must be used. Fixtures live in test/e2e/<case>/.
 */
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import nock from "nock";
import { createNodeMiddleware, Probot } from "probot";
import { createGhostDepsApp } from "../app.js";
import { checkName } from "@ghostdeps/checks-renderer";
import { tarGz, type TarEntry } from "../worker/test-tar.js";

const SECRET = "test-only-webhook-secret";
const APP_ID = 123;
const API = "https://api.github.com";
const OWNER = "octo-org";
const REPO = "example-app";
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
const CHECK_RUN_ID = 9001;
const E2E_DIR = fileURLToPath(new URL("../../test/e2e/", import.meta.url));
const PAYLOAD = new URL("../../test/fixtures/pull_request.opened.json", import.meta.url);
/** Generous: the worker spawns an isolated adapter worker per run. */
const RUN_TIMEOUT_MS = 60_000;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

interface PullRequestPayload {
  number: number;
  installation: { id: number };
  repository: { id: number };
  pull_request: { head: { sha: string }; base: { sha: string } };
}

type Json = Record<string, unknown>;

async function filesUnder(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(root, full)));
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out.sort();
}

/** The tarball GitHub serves: one top-level "<owner>-<repo>-<sha>/" directory. */
async function tarballFor(caseDir: string, headSha: string): Promise<Uint8Array> {
  const head = join(caseDir, "head");
  const top = `${OWNER}-${REPO}-${headSha.slice(0, 7)}/`;
  const entries: TarEntry[] = [{ name: top, type: "directory" }];
  for (const file of await filesUnder(head)) {
    entries.push({ name: top + file, body: await readFile(join(head, file), "utf8") });
  }
  return tarGz(entries);
}

/** Changed paths in a unified diff, in order. */
function changedPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

/** Drop wall-clock fields so the golden is stable. */
function stable(body: Json): Json {
  const copy = { ...body };
  delete copy.started_at;
  delete copy.completed_at;
  return copy;
}

describe("end-to-end: pull request webhook -> check run (#41)", () => {
  let server: Server;
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  before(() => {
    nock.disableNetConnect();
    nock.enableNetConnect("127.0.0.1");
    // Exercise the app's defaults, not whatever the host shell exports.
    for (const key of ["GHOSTDEPS_RECOMMENDATIONS", "GHOSTDEPS_SOURCE_PR_TRIGGER", "APP_ID"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  after(() => {
    nock.enableNetConnect();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // A fresh app per case: its queue dedupes jobs by repository + head SHA,
  // and both cases use the same recorded payload.
  beforeEach(async () => {
    const probot = new Probot({ appId: APP_ID, privateKey, secret: SECRET, logLevel: "fatal" });
    const middleware = await createNodeMiddleware(createGhostDepsApp({ appId: APP_ID }), {
      probot,
    });
    server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    nock.cleanAll();
  });

  /**
   * Deliver one PR webhook for a fixture case and return the check-run
   * create and complete request bodies the app sent.
   */
  async function runCase(name: string): Promise<{ created: Json; completed: Json }> {
    const caseDir = join(E2E_DIR, name);
    const body = await readFile(PAYLOAD, "utf8");
    const payload = JSON.parse(body) as PullRequestPayload;
    const headSha = payload.pull_request.head.sha;
    const baseSha = payload.pull_request.base.sha;
    const diff = await readFile(join(caseDir, "pr.diff"), "utf8");
    const basePackage = await readFile(join(caseDir, "base-package.json"), "utf8");
    const headPackage = await readFile(join(caseDir, "head", "package.json"), "utf8");
    const tarball = await tarballFor(caseDir, headSha);

    let created: Json | undefined;
    let completed: (value: Json) => void = () => undefined;
    const done = new Promise<Json>((resolve) => (completed = resolve));

    // Webhook changed-files and worker tokens are independently limited to
    // this repository and the permissions each path actually needs.
    nock(API)
      .post(`/app/installations/${payload.installation.id}/access_tokens`, (b: Json) => {
        assert.deepEqual(b, {
          repository_ids: [payload.repository.id],
          permissions: { contents: "read", pull_requests: "read" },
        });
        return true;
      })
      .reply(201, { token: "handler-token", expires_at: "2099-01-01T00:00:00Z" });
    nock(API)
      .post(`/app/installations/${payload.installation.id}/access_tokens`, (b: Json) => {
        assert.deepEqual(b.repository_ids, [payload.repository.id]);
        assert.deepEqual(b.permissions, { contents: "read", checks: "write" });
        return true;
      })
      .reply(201, { token: "worker-token", expires_at: "2099-01-01T00:00:00Z" });
    nock(API)
      .get(`${REPO_PATH}/pulls/${payload.number}/files`)
      .query(true)
      .reply(
        200,
        changedPaths(diff).map((filename) => ({ filename, status: "modified" })),
      );
    nock(API)
      .get(`${REPO_PATH}/commits/${headSha}/check-runs`)
      .query(true)
      .reply(200, { total_count: 0, check_runs: [] });
    nock(API)
      .post(`${REPO_PATH}/check-runs`, (b: Json) => {
        created = b;
        return true;
      })
      .reply(201, { id: CHECK_RUN_ID });
    nock(API)
      .get(`${REPO_PATH}/tarball/${headSha}`)
      .reply(302, "", {
        location: `https://codeload.github.com/${OWNER}/${REPO}/legacy.tar.gz/${headSha}`,
      });
    nock("https://codeload.github.com")
      .get(`/${OWNER}/${REPO}/legacy.tar.gz/${headSha}`)
      .reply(200, Buffer.from(tarball), { "content-type": "application/x-gzip" });
    nock(API)
      .get(`${REPO_PATH}/compare/${baseSha}...${headSha}`)
      .reply(200, diff, { "content-type": "text/plain; charset=utf-8" });
    nock(API)
      .get(`${REPO_PATH}/contents/package.json`)
      .query({ ref: baseSha })
      .reply(200, basePackage, { "content-type": "text/plain; charset=utf-8" });
    nock(API)
      .get(`${REPO_PATH}/contents/package.json`)
      .query({ ref: headSha })
      .reply(200, headPackage, { "content-type": "text/plain; charset=utf-8" });
    nock(API)
      .patch(`${REPO_PATH}/check-runs/${CHECK_RUN_ID}`, (b: Json) => {
        completed(b);
        return true;
      })
      .reply(200, { id: CHECK_RUN_ID });

    const res = await fetch(`${baseUrl}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    assert.equal(res.status, 200);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`no completed check run; pending: ${nock.pendingMocks().join(", ")}`)),
        RUN_TIMEOUT_MS,
      );
    });
    try {
      const final = await Promise.race([done, timeout]);
      assert.deepEqual(nock.pendingMocks(), []);
      assert.ok(created, "check run was never created");
      return { created, completed: final };
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertGolden(name: string, completed: Json): Promise<void> {
    const file = join(E2E_DIR, name, "expected-check.json");
    const actual = `${JSON.stringify(stable(completed), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(file, actual);
    assert.equal(actual, await readFile(file, "utf8"), `${name}: check run differs from golden`);
  }

  function assertCreated(created: Json, headSha: string): void {
    assert.equal(created.name, checkName);
    assert.equal(created.head_sha, headSha);
    assert.equal(created.status, "in_progress");
    assert.equal(typeof created.external_id, "string");
  }

  it("dependency added, unused: reports left-pad as unused on the PR", async () => {
    const { created, completed } = await runCase("added-unused");
    assertCreated(created, "6dcb09b5b57875f334f61aebed695e2e4193db5e");
    await assertGolden("added-unused", completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.conclusion, "neutral");
    // Markdown-escaped in the summary: "left\-pad".
    const summary = (completed.output as { summary: string }).summary.replace(/\\/g, "");
    assert.match(summary, /left-pad is declared but never used/);
  });

  it("dependency added and used: no unused finding for left-pad", async () => {
    const { created, completed } = await runCase("added-used");
    assertCreated(created, "6dcb09b5b57875f334f61aebed695e2e4193db5e");
    await assertGolden("added-used", completed);
    assert.equal(completed.status, "completed");
    assert.equal(completed.conclusion, "success");
    assert.doesNotMatch(JSON.stringify(completed.output), /left/);
  });
});
