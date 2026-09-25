import assert from "node:assert/strict";
import { it } from "node:test";
import { RegistryMetadataService } from "./registry-metadata.js";
import { NPM_ECOSYSTEM, NpmMetadataService, type FetchLike } from "./npm-metadata.js";

it("routes npm metadata but not unknown ecosystems or unproven origins", async () => {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = (async function* () {
      yield Buffer.from(
        JSON.stringify({
          versions: { "1.0.0": { deprecated: "Use replacement" } },
          time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
        }),
      );
    })();
    return { status: 200, headers: { get: () => null }, body };
  };
  const service = new RegistryMetadataService(
    new Map([[NPM_ECOSYSTEM, new NpmMetadataService({ fetch })]]),
  );
  const run = service.forRun();
  const packages = [
    { name: "safe", version: "1.0.0", origin: "https://registry.npmjs.org" },
    { name: "secret", version: "1.0.0", origin: "https://internal.example" },
    { name: "other", version: "1.0.0" },
  ];
  assert.equal(await run.packageFacts?.({ ecosystem: "python", packages }), undefined);
  assert.deepEqual(await run.packageFacts?.({ ecosystem: NPM_ECOSYSTEM, packages }), [
    {
      name: "safe",
      version: "1.0.0",
      origin: "https://registry.npmjs.org",
      publishedAt: { value: "2020-01-01T00:00:00.000Z", basis: "npm registry time[version]" },
      deprecated: { value: true, basis: "npm registry versions[version].deprecated" },
    },
  ]);
  assert.deepEqual(urls, ["https://registry.npmjs.org/safe"]);
  assert.equal(run.complete, true);
});

it("uses one shared per-run budget across size and facts and retries missing facts next run", async () => {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = (async function* () {
      yield Buffer.from(
        JSON.stringify({
          dist: { unpackedSize: 7 },
          versions: { "1.0.0": {} },
          time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
        }),
      );
    })();
    return { status: 200, headers: { get: () => null }, body };
  };
  const service = new RegistryMetadataService(
    new Map([[NPM_ECOSYSTEM, new NpmMetadataService({ fetch, fetchBudget: 1 })]]),
  );
  const request = {
    ecosystem: NPM_ECOSYSTEM,
    packages: [{ name: "one", version: "1.0.0", origin: "https://registry.npmjs.org" }],
  };
  const first = service.forRun();
  assert.equal((await first.installSizes(request))?.sizes[0]?.bytes, 7);
  assert.deepEqual(await first.packageFacts?.(request), []);
  assert.equal(first.complete, false);
  const second = service.forRun();
  assert.equal(
    (await second.packageFacts?.(request))?.[0]?.publishedAt?.value,
    "2020-01-01T00:00:00.000Z",
  );
  assert.deepEqual(urls, [
    "https://registry.npmjs.org/one/1.0.0",
    "https://registry.npmjs.org/one",
  ]);
});

it("expires health facts and known misses after TTL", async () => {
  let now = 1000;
  const before = Date.now;
  Date.now = () => now;
  try {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return { status: 404, headers: { get: () => null }, body: null };
    };
    const service = new NpmMetadataService({ fetch, versionTtlMs: 10 });
    const request = {
      ecosystem: NPM_ECOSYSTEM,
      packages: [{ name: "gone", version: "1.0.0", origin: "https://registry.npmjs.org" }],
    };
    await service.forRun().packageFacts?.(request);
    now += 5;
    await service.forRun().packageFacts?.(request);
    assert.equal(urls.length, 1);
    now += 6;
    await service.forRun().packageFacts?.(request);
    assert.equal(urls.length, 2);
  } finally {
    Date.now = before;
  }
});
