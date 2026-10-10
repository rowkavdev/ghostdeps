import assert from "node:assert/strict";
import { test } from "node:test";
import { NpmMetadataService, NPM_ECOSYSTEM, type FetchLike } from "./npm-metadata.js";
const request = {
  ecosystem: NPM_ECOSYSTEM,
  packages: [{ name: "example", version: "1.0.0", origin: "https://registry.npmjs.org" }],
};

for (const method of ["installSizes", "packageFacts"] as const) {
  for (const path of ["missing", "http_error", "declared_overflow"] as const) {
    for (const cleanup of ["stalls", "throws", "rejects"] as const) {
      test(`${method} ${path} ignores cleanup that ${cleanup}`, async () => {
        let calls = 0,
          cancelled = 0;
        const fetch: FetchLike = async () => {
          calls++;
          return {
            status: path === "missing" ? 404 : path === "http_error" ? 500 : 200,
            headers: { get: () => (path === "declared_overflow" ? "100" : null) },
            body: Object.assign(
              (async function* () {
                yield* [];
                throw Error("rejected body must not be read");
              })(),
              {
                cancel() {
                  cancelled++;
                  if (cleanup === "throws") throw Error("cleanup");
                  if (cleanup === "rejects") return Promise.reject(Error("cleanup"));
                  return new Promise<void>(() => {});
                },
              },
            ),
          };
        };
        const service = new NpmMetadataService({
          fetch,
          maxResponseBytes: 10,
          requestTimeoutMs: 10,
          runTimeoutMs: 20,
        });
        const run = service.forRun();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          run[method]!(request),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("hung"), 100);
          }),
        ]);
        clearTimeout(timer);
        assert.notEqual(result, "hung");
        assert.deepEqual(
          result,
          method === "installSizes" ? { basis: "npm registry dist.unpackedSize", sizes: [] } : [],
        );
        assert.equal(cancelled, 1);
        assert.equal(run.complete, path !== "http_error");
        await service.forRun()[method]!(request);
        assert.equal(
          calls,
          path === "http_error" ? 2 : 1,
          "known misses cache; HTTP failures stay retryable",
        );
      });
    }
  }
}
