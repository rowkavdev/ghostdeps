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
