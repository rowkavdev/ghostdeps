import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import nock from "nock";
import { Probot } from "probot";
import { repoScopedClients, WORKER_PERMISSIONS } from "./github-client.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("repoScopedClients", () => {
  before(() => nock.disableNetConnect());
  after(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("mints a token scoped to the one repository and the worker's permissions", async () => {
    let body: unknown;
    nock("https://api.github.com")
      .post("/app/installations/55501/access_tokens", (b: unknown) => {
        body = b;
        return true;
      })
      .reply(201, { token: "scoped-token", expires_at: "2099-01-01T00:00:00Z" });
    nock("https://api.github.com", { reqheaders: { authorization: "token scoped-token" } })
      .get("/repos/octo-org/example-app/tarball/abc")
      .reply(302, "", {
        location: "https://codeload.github.com/octo-org/example-app/legacy.tar.gz/abc",
      });

    const probot = new Probot({ appId: 123, privateKey, logLevel: "fatal" });
    const client = await repoScopedClients(probot)({
      key: "k",
      deliveryId: "d",
      installationId: 55501,
      repository: { id: 872001, owner: "octo-org", name: "example-app" },
      headSha: "abc",
      trigger: { kind: "full_scan", reason: "explicit" },
    });
    assert.deepEqual(body, { repository_ids: [872001], permissions: WORKER_PERMISSIONS });
    const res = await client.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner: "octo-org",
      repo: "example-app",
      ref: "abc",
      request: { redirect: "manual" },
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.location ?? "", /^https:\/\/codeload\.github\.com\//);
    assert.ok(nock.isDone());
  });
});
