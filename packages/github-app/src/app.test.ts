import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import nock from "nock";
import { createNodeMiddleware, Probot } from "probot";
import { createGhostDepsApp, HEALTH_PATH } from "./app.js";
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
    // Handlers must not call the GitHub API yet; any outbound request fails the test.
    nock.disableNetConnect();
    nock.enableNetConnect("127.0.0.1");
  });

  after(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    queue = new RecordingQueue();
    const probot = new Probot({ appId: 123, privateKey, secret: SECRET, logLevel: "fatal" });
    const middleware = await createNodeMiddleware(createGhostDepsApp({ queue }), { probot });
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
    assert.deepEqual(nock.pendingMocks(), []);
  });

  it("serves a health endpoint", async () => {
    const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
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

  it("emits an AnalysisJob for pull_request.opened", async () => {
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
    const body = await fixture("pull_request.opened");
    await deliver("pull_request", body);
    await deliver("pull_request", body);
    assert.equal(queue.jobs.length, 1);
  });

  it("emits a new job when synchronize moves the head SHA", async () => {
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
});
