import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import nock from "nock";
import { createNodeMiddleware, Probot } from "probot";
import { createGhostDepsApp, HEALTH_PATH } from "./app.js";
import { BusyLimiter } from "./checks/busy-limiter.js";
import type { AnalysisJob, EnqueueResult, JobQueue } from "./jobs.js";

const SECRET = "test-only-webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

class RecordingQueue implements JobQueue {
  readonly jobs: AnalysisJob[] = [];
  readonly #keys = new Set<string>();
  enqueue(job: AnalysisJob): EnqueueResult {
    if (this.#keys.has(job.key)) return "duplicate";
    this.#keys.add(job.key);
    this.jobs.push(job);
    return "queued";
  }
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../test/fixtures/${name}.json`, import.meta.url), "utf8");
}

const API = "https://api.github.com";
const REPO_PATH = "/repos/octo-org/example-app";

/** Installation token for the fixture installation; Probot caches it per test instance. */
function mockInstallationToken() {
  nock(API)
    .post("/app/installations/55501/access_tokens")
    .reply(201, { token: "test-token", expires_at: "2099-01-01T00:00:00Z" });
}

function mockPrFiles(filenames: string[], times = 1) {
  nock(API)
    .get(`${REPO_PATH}/pulls/42/files`)
    .query({ per_page: "100" })
    .times(times)
    .reply(
      200,
      filenames.map((filename) => ({ filename, status: "modified" })),
    );
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GhostDeps GitHub App", () => {
  let server: Server;
  let baseUrl: string;
  let queue: RecordingQueue;

  async function deliver(event: string, body: string, signature = sign(body)) {
    return fetch(`${baseUrl}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": signature,
      },
      body,
    });
  }

  before(() => {
    // Only mocked GitHub API calls are allowed; anything else fails the test.
    nock.disableNetConnect();
    nock.enableNetConnect("127.0.0.1");
  });

  after(() => {
    nock.enableNetConnect();
  });

  async function listen(options: { sourcePrTrigger?: boolean } = {}) {
    queue = new RecordingQueue();
    const probot = new Probot({ appId: 123, privateKey, secret: SECRET, logLevel: "fatal" });
    const middleware = await createNodeMiddleware(createGhostDepsApp({ queue, ...options }), {
      probot,
    });
    server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    await listen();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(nock.pendingMocks(), []);
    nock.cleanAll();
  });

  it("serves a health endpoint", async () => {
    const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
    const withQuery = await fetch(`${baseUrl}${HEALTH_PATH}?probe=1`);
    assert.equal(withQuery.status, 200);
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const body = await fixture("pull_request.opened");
    const res = await deliver("pull_request", body, sign(body, "wrong-secret"));
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    assert.equal(queue.jobs.length, 0);
  });

  it("rejects a delivery with no signature", async () => {
    const body = await fixture("pull_request.opened");
    const res = await fetch(`${baseUrl}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": randomUUID(),
      },
      body,
    });
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    assert.equal(queue.jobs.length, 0);
  });

  it("emits an AnalysisJob for pull_request.opened that touches a manifest", async () => {
    mockInstallationToken();
    mockPrFiles(["package.json", "src/index.js"]);
    const res = await deliver("pull_request", await fixture("pull_request.opened"));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 1);
    const job = queue.jobs[0];
    assert.ok(job);
    assert.equal(job.key, "872001:6dcb09b5b57875f334f61aebed695e2e4193db5e");
    assert.equal(job.installationId, 55501);
    assert.deepEqual(job.repository, { id: 872001, owner: "octo-org", name: "example-app" });
    assert.deepEqual(job.trigger, {
      kind: "pull_request",
      number: 42,
      action: "opened",
      baseSha: "9049f1265b7d61be4a8904a9a27120d2064dab3b",
    });
  });

  it("collapses a redelivery of the same head SHA onto one job", async () => {
    mockInstallationToken();
    mockPrFiles(["package-lock.json"], 2);
    const body = await fixture("pull_request.opened");
    await deliver("pull_request", body);
    await deliver("pull_request", body);
    assert.equal(queue.jobs.length, 1);
  });

  it("emits a new job when synchronize moves the head SHA", async () => {
    mockInstallationToken();
    mockPrFiles(["package.json"], 2);
    await deliver("pull_request", await fixture("pull_request.opened"));
    await deliver("pull_request", await fixture("pull_request.synchronize"));
    assert.deepEqual(
      queue.jobs.map((j) => j.trigger.kind === "pull_request" && j.trigger.action),
      ["opened", "synchronize"],
    );
  });

  it("ignores pull_request actions that cannot change dependencies", async () => {
    const res = await deliver("pull_request", await fixture("pull_request.closed"));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 0);
  });

  it("accepts installation and installation_repositories events as no-ops", async () => {
    const a = await deliver("installation", await fixture("installation.created"));
    const b = await deliver(
      "installation_repositories",
      await fixture("installation_repositories.added"),
    );
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(queue.jobs.length, 0);
  });

  it("skips a source-only pull request while the source trigger is off (default)", async () => {
    mockInstallationToken();
    mockPrFiles(["src/index.js", "README.md"]);
    const res = await deliver("pull_request", await fixture("pull_request.opened"));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 0);
  });

  it("analyses a source-only pull request with the source trigger on (#101)", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen({ sourcePrTrigger: true });
    mockInstallationToken();
    mockPrFiles(["src/index.js", "README.md"]);
    const res = await deliver("pull_request", await fixture("pull_request.opened"));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 1);
    assert.equal(queue.jobs[0]?.trigger.kind, "pull_request");
  });

  it("skips a pull request that touches no dependency files or analysable source", async () => {
    mockInstallationToken();
    mockPrFiles(["README.md", "docs/guide.md", "dist/index.js"]);
    const res = await deliver("pull_request", await fixture("pull_request.opened"));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 0);
  });

  it("emits a push job for the default branch from payload files, with no API calls", async () => {
    const res = await deliver("push", await fixture("push.default-branch"));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 1);
    assert.deepEqual(queue.jobs[0]?.trigger, {
      kind: "push",
      ref: "refs/heads/main",
      beforeSha: "9049f1265b7d61be4a8904a9a27120d2064dab3b",
    });
    assert.equal(queue.jobs[0]?.key, "872001:0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c");
  });

  it("ignores pushes to other branches and source-only pushes", async () => {
    await deliver("push", await fixture("push.feature-branch"));
    await deliver("push", await fixture("push.source-only"));
    assert.equal(queue.jobs.length, 0);
  });

  it("counts a renamed manifest under its previous name", async () => {
    mockInstallationToken();
    nock(API)
      .get(`${REPO_PATH}/pulls/42/files`)
      .query({ per_page: "100" })
      .reply(200, [
        {
          filename: "legacy/package.json.old",
          previous_filename: "packages/a/package.json",
          status: "renamed",
        },
      ]);
    await deliver("pull_request", await fixture("pull_request.opened"));
    assert.equal(queue.jobs.length, 1);
  });

  it("stops paging PR files after five pages and analyses anyway", async () => {
    mockInstallationToken();
    const page = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/f${i}.js`,
      status: "modified",
    }));
    const scope = nock(API);
    scope
      .get(`${REPO_PATH}/pulls/42/files`)
      .query({ per_page: "100" })
      .reply(200, page, {
        link: `<${API}${REPO_PATH}/pulls/42/files?per_page=100&page=2>; rel="next"`,
      });
    for (const n of [2, 3, 4, 5]) {
      scope
        .get(`${REPO_PATH}/pulls/42/files`)
        .query({ per_page: "100", page: String(n) })
        .reply(200, page, {
          link: `<${API}${REPO_PATH}/pulls/42/files?per_page=100&page=${n + 1}>; rel="next"`,
        });
    }
    let unmatched = 0;
    const onNoMatch = (req: { hostname?: string; host?: string }) => {
      if ((req.hostname ?? req.host ?? "").includes("api.github.com")) unmatched++;
    };
    nock.emitter.on("no match", onNoMatch);
    try {
      await deliver("pull_request", await fixture("pull_request.opened"));
    } finally {
      nock.emitter.removeListener("no match", onNoMatch);
    }
    assert.equal(unmatched, 0, "a sixth page was requested");
    assert.equal(queue.jobs.length, 1);
  });

  it("re-runs analysis on check_run.rerequested even after the SHA was analysed", async () => {
    mockInstallationToken();
    mockPrFiles(["package.json"], 1);
    await deliver("pull_request", await fixture("pull_request.opened"));
    const res = await deliver("check_run", await fixture("check_run.rerequested"));
    assert.equal(res.status, 200);
    assert.deepEqual(
      queue.jobs.map((j) => j.trigger.kind),
      ["pull_request", "rerequested"],
    );
    assert.equal(queue.jobs[1]?.headSha, queue.jobs[0]?.headSha);
  });

  it("ignores check_run actions other than rerequested", async () => {
    const body = JSON.parse(await fixture("check_run.rerequested")) as Record<string, unknown>;
    const res = await deliver("check_run", JSON.stringify({ ...body, action: "completed" }));
    assert.equal(res.status, 200);
    assert.equal(queue.jobs.length, 0);
  });
});

describe("GhostDeps GitHub App when the queue is full", () => {
  const overloaded: JobQueue = { enqueue: () => "overloaded" };

  async function start(options: { appId?: number }) {
    const probot = new Probot({ appId: 123, privateKey, secret: SECRET, logLevel: "fatal" });
    const middleware = await createNodeMiddleware(
      createGhostDepsApp({ queue: overloaded, busyLimiter: new BusyLimiter(), ...options }),
      { probot },
    );
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/github/webhooks`;
    const deliver = async (event: string, body: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": sign(body),
        },
        body,
      });
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return { deliver, close };
  }

  let unmatched = 0;
  const onNoMatch = (req: { hostname?: string; host?: string }) => {
    if ((req.hostname ?? req.host ?? "").includes("api.github.com")) unmatched++;
  };

  before(() => {
    nock.disableNetConnect();
    nock.enableNetConnect("127.0.0.1");
    nock.emitter.on("no match", onNoMatch);
  });

  after(() => {
    nock.emitter.removeListener("no match", onNoMatch);
    nock.enableNetConnect();
  });

  beforeEach(() => {
    unmatched = 0;
  });

  afterEach(() => {
    assert.deepEqual(nock.pendingMocks(), []);
    nock.cleanAll();
  });

  it("writes one neutral busy check run per repository per minute", async () => {
    const created: Record<string, unknown>[] = [];
    mockInstallationToken();
    nock(API)
      .post(`${REPO_PATH}/check-runs`, (b: Record<string, unknown>) => {
        created.push(b);
        return true;
      })
      .reply(201, { id: 1 });
    const app = await start({ appId: 123 });
    try {
      const body = await fixture("push.default-branch");
      assert.equal((await app.deliver("push", body)).status, 200);
      assert.equal((await app.deliver("push", body)).status, 200);
    } finally {
      await app.close();
    }
    assert.equal(unmatched, 0, "a second busy run was attempted inside the window");
    assert.equal(created.length, 1);
    assert.equal(created[0]?.status, "completed");
    assert.equal(created[0]?.conclusion, "neutral");
    assert.equal(created[0]?.external_id, "busy:872001:0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c");
  });

  it("writes nothing without an app id", async () => {
    const saved = process.env.APP_ID;
    delete process.env.APP_ID;
    const app = await start({});
    try {
      assert.equal((await app.deliver("push", await fixture("push.default-branch"))).status, 200);
    } finally {
      await app.close();
      if (saved !== undefined) process.env.APP_ID = saved;
    }
    assert.equal(unmatched, 0);
  });
});
