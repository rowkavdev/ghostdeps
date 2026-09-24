import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLIC_NPM_REGISTRY_ORIGINS } from "@ghostdeps/core";
import {
  answerKey,
  NPM_ECOSYSTEM,
  NPM_SIZE_BASIS,
  NpmMetadataService,
  registryPath,
  type FetchLike,
} from "./npm-metadata.js";

type Reply = number | "404" | "500" | "throw" | "hang" | "nosize" | "big" | "chunked";

async function* chunks(text: string) {
  yield Buffer.from(text);
}

/** A registry stub: records every URL and request, answers from `replies`. */
function registry(replies: Record<string, Reply>) {
  const urls: string[] = [];
  let chunksRead = 0;
  const inits: Parameters<FetchLike>[1][] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    inits.push(init);
    const path = url.replace("https://registry.npmjs.org/", "");
    const reply = replies[path] ?? "404";
    const res = (status: number, body: string, length?: number) => ({
      status,
      headers: {
        get: (n: string) =>
          n === "content-length" && length !== undefined ? String(length) : null,
      },
      body: chunks(body),
    });
    if (reply === "throw") throw new Error("network down");
    if (reply === "hang")
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (reply === "404") return res(404, "{}");
    if (reply === "500") return res(500, "");
    if (reply === "nosize") return res(200, JSON.stringify({ dist: {} }));
    if (reply === "big") return res(200, "{}", 10 * 1024 * 1024);
    if (reply === "chunked")
      // No content-length, and an endless body: only the cap stops it.
      return {
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          for (;;) {
            chunksRead++;
            yield new Uint8Array(512);
          }
        })(),
      };
    return res(200, JSON.stringify({ name: "x", dist: { unpackedSize: reply } }));
  };
  return { fetch, urls, inits, chunksRead: () => chunksRead };
}

const NPM_PUBLIC_ORIGIN = "https://registry.npmjs.org";
const YARN_PUBLIC_ORIGIN = "https://registry.yarnpkg.com";
const ref = (name: string, version: string) => ({ name, version });
// Core passes the lockfile's resolved origin; these tests ask as the public registry.
const ask = (service: NpmMetadataService, packages: { name: string; version: string }[]) =>
  service.forRun().installSizes({
    ecosystem: NPM_ECOSYSTEM,
    packages: packages.map((p) => ({ ...p, origin: NPM_PUBLIC_ORIGIN })),
  });

describe("npm footprint metadata (#174)", () => {
  it("returns registry sizes, leaves unknown versions out, and sends no credentials", async () => {
    const r = registry({ "a/1.0.0": 100, "@s%2Fb/2.0.0-rc.1": 250, "c/1.0.0": "nosize" });
    const service = new NpmMetadataService({ fetch: r.fetch });
    const answer = await ask(service, [
      ref("a", "1.0.0"),
      ref("@s/b", "2.0.0-rc.1"),
      ref("c", "1.0.0"),
      ref("gone", "1.0.0"),
    ]);
    assert.deepEqual(answer, {
      basis: NPM_SIZE_BASIS,
      sizes: [
        { name: "@s/b", version: "2.0.0-rc.1", bytes: 250 },
        { name: "a", version: "1.0.0", bytes: 100 },
      ],
    });
    for (const init of r.inits) {
      assert.deepEqual(Object.keys(init.headers), ["accept"]);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
    }
  });

  it("never queries a package not resolved from the public registry", async () => {
    const r = registry({ "a/1.0.0": 1, "secret/1.0.0": 2 });
    const service = new NpmMetadataService({ fetch: r.fetch });
    const answer = await service.forRun().installSizes({
      ecosystem: NPM_ECOSYSTEM,
      packages: [
        { name: "a", version: "1.0.0", origin: NPM_PUBLIC_ORIGIN },
        { name: "secret", version: "1.0.0", origin: "https://npm.corp.example" },
        { name: "secret", version: "1.0.0", origin: "http://registry.npmjs.org" },
        { name: "secret", version: "1.0.0", origin: "https://registry.npmjs.org.evil.example" },
        { name: "secret", version: "1.0.0" },
        { name: "secret", version: "1.0.0", origin: "https://mirror.registry.npmjs.org" },
        { name: "secret", version: "1.0.0", origin: "https://registry.npmjs.org/private" },
      ],
    });
    assert.deepEqual(answer?.sizes, [{ name: "a", version: "1.0.0", bytes: 1 }]);
    assert.deepEqual(r.urls, ["https://registry.npmjs.org/a/1.0.0"]);
    const none = await service
      .forRun()
      .installSizes({ ecosystem: NPM_ECOSYSTEM, packages: [ref("secret", "1.0.0")] });
    assert.deepEqual(none, { basis: NPM_SIZE_BASIS, sizes: [] });
    assert.equal(r.urls.length, 1);
  });

  it("queries yarn classic's public mirror origin too, always at registry.npmjs.org", async () => {
    assert.deepEqual([...PUBLIC_NPM_REGISTRY_ORIGINS].sort(), [
      NPM_PUBLIC_ORIGIN,
      YARN_PUBLIC_ORIGIN,
    ]);
    const r = registry({ "y/1.0.0": 7 });
    const service = new NpmMetadataService({ fetch: r.fetch });
    const answer = await service.forRun().installSizes({
      ecosystem: NPM_ECOSYSTEM,
      packages: [{ name: "y", version: "1.0.0", origin: YARN_PUBLIC_ORIGIN }],
    });
    assert.deepEqual(answer?.sizes, [{ name: "y", version: "1.0.0", bytes: 7 }]);
    assert.deepEqual(r.urls, ["https://registry.npmjs.org/y/1.0.0"]);
  });

  it("answers only its own ecosystem", async () => {
    const r = registry({});
    const service = new NpmMetadataService({ fetch: r.fetch });
    for (const ecosystem of ["python", "rust", "go"]) {
      assert.equal(
        await service.forRun().installSizes({ ecosystem, packages: [ref("a", "1.0.0")] }),
        undefined,
      );
    }
    assert.equal(r.urls.length, 0);
  });

  it("never puts an unsafe name or version in a URL", async () => {
    for (const bad of [
      ref("../etc", "1.0.0"),
      ref("a", "../../x"),
      ref("a", "^1.0.0"),
      ref("A", "1.0.0"),
      ref("a/b/c", "1.0.0"),
      ref("@s/b", "1.0.0/../x"),
      ref("a".repeat(215), "1.0.0"),
      ref("a", "file:../x"),
    ]) {
      assert.equal(registryPath(bad), undefined, `${bad.name}@${bad.version}`);
    }
    assert.equal(registryPath(ref("@s/b", "1.2.3+build.7")), "@s%2Fb/1.2.3%2Bbuild.7");
    const r = registry({});
    await ask(new NpmMetadataService({ fetch: r.fetch }), [ref("../etc", "1.0.0")]);
    // An unsafe name is skipped even with a public origin.
    assert.equal(r.urls.length, 0);
  });

  it("caches versions and known misses across runs", async () => {
    const r = registry({ "a/1.0.0": 1 });
    const service = new NpmMetadataService({ fetch: r.fetch });
    await ask(service, [ref("a", "1.0.0"), ref("gone", "1.0.0")]);
    const answer = await ask(service, [ref("a", "1.0.0"), ref("gone", "1.0.0"), ref("b", "1.0.0")]);
    assert.deepEqual(
      r.urls.map((u) => u.split("/").slice(-2).join("/")),
      ["a/1.0.0", "gone/1.0.0", "b/1.0.0"],
    );
    assert.deepEqual(answer?.sizes, [{ name: "a", version: "1.0.0", bytes: 1 }]);
  });

  it("answers an unchanged dependency set (a source-only PR) from its content key", async () => {
    const r = registry({ "a/1.0.0": 1, "b/1.0.0": 2 });
    const service = new NpmMetadataService({ fetch: r.fetch, maxVersions: 1 });
    const first = await ask(service, [ref("a", "1.0.0"), ref("b", "1.0.0")]);
    // Reordered, and the version cache has already evicted "a": still no fetch.
    const again = await ask(service, [ref("b", "1.0.0"), ref("a", "1.0.0")]);
    assert.deepEqual(again, first);
    assert.equal(r.urls.length, 2);
    assert.equal(
      answerKey(NPM_ECOSYSTEM, [ref("a", "1.0.0"), ref("b", "1.0.0")]),
      answerKey(NPM_ECOSYSTEM, [ref("b", "1.0.0"), ref("a", "1.0.0")]),
    );
    assert.notEqual(
      answerKey(NPM_ECOSYSTEM, [ref("a", "1.0.0")]),
      answerKey(NPM_ECOSYSTEM, [ref("a", "1.0.1")]),
    );
    assert.notEqual(
      answerKey(NPM_ECOSYSTEM, [{ ...ref("a", "1.0.0"), origin: NPM_PUBLIC_ORIGIN }]),
      answerKey(NPM_ECOSYSTEM, [{ ...ref("a", "1.0.0"), origin: "https://npm.corp.example" }]),
    );
  });

  it("stops at the per-run fetch budget and does not cache the partial answer", async () => {
    const r = registry({ "a/1.0.0": 1, "b/1.0.0": 2, "c/1.0.0": 3 });
    const service = new NpmMetadataService({ fetch: r.fetch, fetchBudget: 2, concurrency: 1 });
    const packages = [ref("a", "1.0.0"), ref("b", "1.0.0"), ref("c", "1.0.0")];
    const partial = await ask(service, packages);
    assert.equal(partial?.sizes.length, 2);
    assert.equal(r.urls.length, 2);
    // A new run has a fresh budget, reuses the two cached sizes and finishes.
    const full = await ask(service, packages);
    assert.equal(full?.sizes.length, 3);
    assert.equal(r.urls.length, 3);
  });

  it("fails quiet: errors and timeouts leave packages unsized and are retried later", async () => {
    const r = registry({
      "a/1.0.0": 1,
      "b/1.0.0": "500",
      "c/1.0.0": "throw",
      "d/1.0.0": "hang",
      "e/1.0.0": "big",
    });
    const service = new NpmMetadataService({
      fetch: r.fetch,
      requestTimeoutMs: 20,
      maxResponseBytes: 1024,
    });
    const packages = ["a", "b", "c", "d", "e"].map((n) => ref(n, "1.0.0"));
    const answer = await ask(service, packages);
    assert.deepEqual(answer?.sizes, [{ name: "a", version: "1.0.0", bytes: 1 }]);
    await ask(service, packages);
    // b, c and d were transient, so asked again; e (too big) is a cached miss.
    assert.deepEqual(
      r.urls
        .slice(5)
        .map((u) => u.split("/").slice(-2)[0])
        .sort(),
      ["b", "c", "d"],
    );
  });

  it("stops reading a chunked body at the size cap (a cached miss)", async () => {
    const r = registry({ "a/1.0.0": "chunked", "b/1.0.0": 5 });
    const service = new NpmMetadataService({ fetch: r.fetch, maxResponseBytes: 2048 });
    const answer = await ask(service, [ref("a", "1.0.0"), ref("b", "1.0.0")]);
    assert.deepEqual(answer?.sizes, [{ name: "b", version: "1.0.0", bytes: 5 }]);
    assert.equal(r.chunksRead(), 5);
    await ask(service, [ref("a", "1.0.0")]);
    assert.equal(r.urls.length, 2);
  });

  it("stops at the run deadline", async () => {
    const r = registry({ "a/1.0.0": "hang", "b/1.0.0": "hang" });
    const service = new NpmMetadataService({ fetch: r.fetch, runTimeoutMs: 30, concurrency: 1 });
    const started = Date.now();
    const answer = await ask(service, [ref("a", "1.0.0"), ref("b", "1.0.0")]);
    assert.deepEqual(answer?.sizes, []);
    assert.ok(Date.now() - started < 1000);
    assert.equal(r.urls.length, 1);
  });

  it("returns undefined instead of throwing on a malformed request", async () => {
    const service = new NpmMetadataService({ fetch: registry({}).fetch });
    const provider = service.forRun();
    assert.equal(
      await provider.installSizes({ ecosystem: NPM_ECOSYSTEM, packages: null as never }),
      undefined,
    );
  });
});
