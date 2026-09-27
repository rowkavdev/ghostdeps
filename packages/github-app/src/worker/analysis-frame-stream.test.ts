import assert from "node:assert/strict";
import { test } from "node:test";
import { collectAnalysisFrame } from "./analysis-frame-stream.js";
import { AnalysisProtocolError, MAX_ANALYSIS_FRAME_BYTES } from "./analysis-protocol.js";

async function* chunks(...items: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const item of items) yield item;
}
function frame(text: string): Uint8Array {
  const body = Buffer.from(text);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length);
  body.copy(out, 4);
  return out;
}

test("collects split header/body and a single chunk exactly", async () => {
  const data = frame('{"version":1}');
  assert.deepEqual(Buffer.from(await collectAnalysisFrame(chunks(data))), data);
  assert.deepEqual(
    Buffer.from(
      await collectAnalysisFrame(
        chunks(data.subarray(0, 1), data.subarray(1, 3), data.subarray(3, 8), data.subarray(8)),
      ),
    ),
    data,
  );
});

test("rejects oversized declaration before allocating or consuming body", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_ANALYSIS_FRAME_BYTES + 1);
  let bodyRequested = false;
  async function* hostile(): AsyncGenerator<Uint8Array> {
    yield header;
    bodyRequested = true;
    yield Buffer.alloc(MAX_ANALYSIS_FRAME_BYTES + 1);
  }
  await assert.rejects(
    collectAnalysisFrame(hostile()),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_LENGTH",
  );
  assert.equal(bodyRequested, false);
});

test("rejects zero, truncation, trailing bytes even in later chunk, and invalid chunk", async () => {
  const good = frame("hello");
  const zero = Buffer.alloc(4);
  for (const source of [
    chunks(zero),
    chunks(good.subarray(0, -1)),
    chunks(good, Buffer.from("x")),
    chunks(Buffer.concat([good, Buffer.from("x")])),
    chunks(good.subarray(0, 2)),
  ])
    await assert.rejects(collectAnalysisFrame(source), AnalysisProtocolError);
  await assert.rejects(
    collectAnalysisFrame(chunks(null as unknown as Uint8Array)),
    AnalysisProtocolError,
  );
});

test("does not copy an oversized supplied chunk into the frame", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(1);
  await assert.rejects(
    collectAnalysisFrame(chunks(header, Buffer.alloc(MAX_ANALYSIS_FRAME_BYTES + 1))),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_TRAILING",
  );
});
test("collects a frame exactly at the byte limit across split header chunks", async () => {
  const body = Buffer.alloc(MAX_ANALYSIS_FRAME_BYTES, 0x61);
  const data = Buffer.alloc(4 + body.length);
  data.writeUInt32BE(body.length, 0);
  body.copy(data, 4);
  const collected = await collectAnalysisFrame(
    chunks(data.subarray(0, 3), data.subarray(3, 4), data.subarray(4)),
  );
  assert.deepEqual(Buffer.from(collected), data);
});

test("rejects one byte past a complete frame at the byte limit", async () => {
  const body = Buffer.alloc(MAX_ANALYSIS_FRAME_BYTES, 0x61);
  const data = Buffer.alloc(4 + body.length + 1);
  data.writeUInt32BE(body.length, 0);
  body.copy(data, 4);
  await assert.rejects(
    collectAnalysisFrame(chunks(data)),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_TRAILING",
  );
});

test("rejects garbage bytes that decode to a hostile declared length", async () => {
  // "GARB" read as a big-endian uint32 is far past the frame cap.
  let laterChunkPulled = false;
  async function* hostile(): AsyncGenerator<Uint8Array> {
    yield Buffer.from("GARBAGE, not a frame");
    laterChunkPulled = true;
    yield Buffer.alloc(1);
  }
  await assert.rejects(
    collectAnalysisFrame(hostile()),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_LENGTH",
  );
  assert.equal(laterChunkPulled, false);
});

test("rejects a hostile length split across header chunks without reading further", async () => {
  let laterChunkPulled = false;
  async function* hostile(): AsyncGenerator<Uint8Array> {
    yield Buffer.from([0xff, 0xff]);
    yield Buffer.from([0xff, 0xff]); // 0xffffffff: reject the moment the header completes
    laterChunkPulled = true;
    yield Buffer.alloc(1);
  }
  await assert.rejects(
    collectAnalysisFrame(hostile()),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_LENGTH",
  );
  assert.equal(laterChunkPulled, false);
});

test("rejects a body that ends one byte short across chunk boundaries", async () => {
  const data = frame('{"a":1}');
  const truncated = data.subarray(0, -1);
  await assert.rejects(
    collectAnalysisFrame(
      chunks(
        truncated.subarray(0, 2),
        truncated.subarray(2, 4),
        truncated.subarray(4, 7),
        truncated.subarray(7),
      ),
    ),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_TRUNCATED",
  );
});

test("rejects a declared length larger than the delivered body", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(10, 0);
  await assert.rejects(
    collectAnalysisFrame(chunks(header.subarray(0, 3), header.subarray(3), Buffer.from("abc"))),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_TRUNCATED",
  );
});

test("rejects a declared length smaller than the delivered bytes immediately", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(2, 0);
  let tailConsumed = false;
  async function* hostile(): AsyncGenerator<Uint8Array> {
    yield Buffer.concat([header, Buffer.from("abcdef")]);
    tailConsumed = true;
    yield Buffer.alloc(1);
  }
  await assert.rejects(
    collectAnalysisFrame(hostile()),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_TRAILING",
  );
  assert.equal(tailConsumed, false);
});

test("rejects a second complete frame after the first", async () => {
  const first = frame('{"version":1}');
  const second = frame('{"version":2}');
  await assert.rejects(
    collectAnalysisFrame(chunks(first, second)),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_TRAILING",
  );
});

test("rejects a non-byte chunk after a valid header", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(2, 0);
  await assert.rejects(
    collectAnalysisFrame(chunks(header, "ab" as unknown as Uint8Array)),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_CHUNK",
  );
});

test("rejects a zero declared length split across chunks", async () => {
  const zero = Buffer.alloc(4);
  await assert.rejects(
    collectAnalysisFrame(chunks(zero.subarray(0, 2), zero.subarray(2))),
    (error: unknown) => error instanceof AnalysisProtocolError && error.code === "FRAME_LENGTH",
  );
});
