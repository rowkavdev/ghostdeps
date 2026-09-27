import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnalysisProtocolError,
  decodeAnalysisFrame,
  encodeAnalysisRequest,
  validateAnalysisRequest,
  validateAnalysisResponse,
  MAX_ANALYSIS_FRAME_BYTES,
} from "./analysis-protocol.js";

const jobId = "job_42";
const request = {
  version: 1,
  jobId,
  checkoutSha256: "a".repeat(64),
  adapters: ["javascript-typescript"],
};
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

test("request is versioned, bounded, and never accepts paths, module URLs or extra fields", () => {
  assert.equal(Buffer.from(encodeAnalysisRequest(request)).readUInt32BE(0) > 0, true);
  for (const bad of [
    { ...request, root: "/host" },
    { ...request, adapters: ["file:///checkout/evil.js"] },
    { ...request, adapters: ["python", "python"] },
    { ...request, checkoutSha256: "../checkout" },
    { ...request, jobId: "../token" },
    { ...request, version: 2 },
  ])
    assert.throws(() => validateAnalysisRequest(bad), AnalysisProtocolError);
});

test("response rejects oversized, truncated, trailing, invalid UTF-8, wrong job and schema", () => {
  const good = { version: 1, jobId, status: "complete", result: { findings: [] } };
  assert.deepEqual(decodeAnalysisFrame(frame(good), jobId), good);
  for (const bad of [
    Buffer.alloc(MAX_ANALYSIS_FRAME_BYTES + 5),
    frame(good).subarray(0, -1),
    Buffer.concat([frame(good), Buffer.from("garbage")]),
    frame({ ...good, jobId: "other" }),
    frame({ ...good, token: "forbidden" }),
  ])
    assert.throws(() => decodeAnalysisFrame(bad, jobId), AnalysisProtocolError);
  const invalid = Buffer.from([0, 0, 0, 1, 0xff]);
  assert.throws(() => decodeAnalysisFrame(invalid, jobId), AnalysisProtocolError);
});

test("response rejects deep, wide and oversized text before rendering", () => {
  const good = { version: 1, jobId, status: "complete", result: {} };
  let nested: unknown = "leaf";
  for (let i = 0; i < 26; i++) nested = [nested];
  for (const result of [
    { nested },
    { value: "x".repeat(16_385) },
    { values: Array(50_001).fill(0) },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), i])),
    JSON.parse('{"__proto__":1}'),
  ])
    assert.throws(
      () => validateAnalysisResponse({ ...good, result }, jobId),
      AnalysisProtocolError,
    );
});
