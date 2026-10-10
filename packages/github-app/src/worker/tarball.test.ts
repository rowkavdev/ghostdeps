import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadTarball, TarballError } from "./tarball.js";

const url = new URL("https://codeload.github.com/example/repo/tar.gz/head");
const rejected = [
  {
    label: "HTTP failure",
    status: 502,
    headers: {},
    code: "HTTP",
    message: "tarball download returned 502",
  },
  {
    label: "oversized declaration",
    status: 200,
    headers: { "content-length": "11" },
    code: "TOO_LARGE",
    message: "tarball exceeds 10 bytes",
  },
] as const;

async function consume(response: Response): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of downloadTarball(url, { maxBytes: 10, fetch: async () => response })) {
    chunks.push(chunk);
  }
  return chunks;
}

for (const entry of rejected) {
  test(`cancels unread tarball body on ${entry.label}`, async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(11));
      },
      cancel() {
        cancellations++;
      },
    });
    await assert.rejects(
      consume(new Response(body, entry)),
      (error: unknown) =>
        error instanceof TarballError &&
        error.code === entry.code &&
        error.message === entry.message,
    );
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  });

  for (const behavior of ["throws", "rejects", "stalls"] as const) {
    test(
      `${entry.label} keeps its error when cancellation ${behavior}`,
      { timeout: 1000 },
      async () => {
        let cancellations = 0;
        const body = {
          cancel() {
            cancellations++;
            if (behavior === "throws") throw new Error("cleanup failure");
            if (behavior === "rejects") return Promise.reject(new Error("cleanup failure"));
            return new Promise<void>(() => {});
          },
        };
        const response = {
          ok: entry.status === 200,
          status: entry.status,
          headers: new Headers(entry.headers),
          body,
        } as unknown as Response;
        await assert.rejects(
          consume(response),
          (error: unknown) =>
            error instanceof TarballError &&
            error.code === entry.code &&
            error.message === entry.message,
        );
        assert.equal(cancellations, 1);
      },
    );
  }
}

test("successful exact-cap tarball keeps its bytes and fetch options", async () => {
  const bytes = new Uint8Array(10).fill(7);
  const signal = new AbortController().signal;
  const received: Uint8Array[] = [];
  let calls = 0;
  for await (const chunk of downloadTarball(url, {
    maxBytes: 10,
    signal,
    fetch: async (input, init) => {
      calls++;
      assert.equal(input, url);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.signal, signal);
      return new Response(bytes, { headers: { "content-length": "10" } });
    },
  }))
    received.push(chunk);
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.concat(received), Buffer.from(bytes));
});

test("stream overflow still cancels via iterator cleanup", async () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(11));
    },
    cancel() {
      cancellations++;
    },
  });
  await assert.rejects(
    consume(new Response(body)),
    (error: unknown) => error instanceof TarballError && error.code === "TOO_LARGE",
  );
  assert.equal(cancellations, 1);
});

test("missing response body keeps HTTP failure", async () => {
  await assert.rejects(
    consume(new Response(null, { status: 502 })),
    (error: unknown) => error instanceof TarballError && error.code === "HTTP",
  );
});
