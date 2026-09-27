import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryHandle } from "../testing/fs-handle.js";
import { findMatchedApiReferences } from "./matched-apis.js";
import { inspectSemanticFlows } from "./semantic-inspections.js";

async function scan(text: string) {
  const files = { "src/é.ts": text };
  const repository = memoryHandle(files);
  const matches = await findMatchedApiReferences(repository, "axios");
  const records = await inspectSemanticFlows(repository, matches.references);
  for (const record of records) {
    for (const citation of [
      ...record.citations,
      ...record.explored,
      ...record.lineage,
      record.call,
    ]) {
      const bytes = Buffer.from(files[citation.file as keyof typeof files]);
      assert.ok(citation.end > citation.start);
      assert.ok(citation.end <= bytes.length);
      assert.ok(bytes.subarray(citation.start, citation.end).toString("utf8"));
    }
  }
  return records;
}
test("awaited response: cited status check and parsed data observation", async () => {
  const records = await scan(
    'import axios from "axios";\nasync function f() { const response = await axios.get("/é"); if (response.status !== 200) throw Error(); return response.data; }',
  );
  assert.equal(records.find((r) => r.kind === "response-handling")?.state, "inspected");
  assert.equal(records.find((r) => r.kind === "status-check")?.state, "inspected");
  assert.equal(records.find((r) => r.kind === "parsed-response")?.state, "incompatible");
  assert.equal(
    records.find((r) => r.kind === "parsed-response")?.citations.map((s) => s.start).length,
    1,
  );
});
test("floating promise remains unknown", async () => {
  const records = await scan('import axios from "axios"; axios.get("/x");');
  assert.equal(records.find((r) => r.kind === "response-handling")?.state, "unknown");
});
test("catch error.code is a cited inspection, not an eligibility verdict", async () => {
  const records = await scan(
    'import axios from "axios"; async function f() { try { await axios.get("/x"); } catch (error) { console.log(error.code); } }',
  );
  assert.equal(records.find((r) => r.kind === "error-handling")?.state, "inspected");
  assert.equal(records.find((r) => r.kind === "error-handling")?.citations.length, 1);
});
test("unrelated catch cannot inspect the call", async () => {
  const records = await scan(
    'import axios from "axios"; try { throw 1; } catch (error) { console.log(error.code); } axios.get("/x");',
  );
  assert.equal(records.find((r) => r.kind === "error-handling")?.state, "unknown");
});
test("signal citation in call options; swallowed wrapper result remains unknown", async () => {
  const records = await scan(
    'import axios from "axios"; const controller = new AbortController(); function f() { axios.get("/x", { signal: controller.signal }); }',
  );
  const cancellation = records.find(
    (r) =>
      r.kind === "cancellation-propagation" &&
      r.call.file === "src/é.ts" &&
      r.state === "inspected",
  );
  assert.ok(cancellation);
  assert.equal(
    records.find((r) => r.kind === "response-handling" && r.call.start === cancellation.call.start)
      ?.state,
    "unknown",
  );
});
