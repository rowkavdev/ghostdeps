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
  const bytesOf = (s: { file: string; start: number; end: number }) =>
    Buffer.from(files[s.file as keyof typeof files]).subarray(s.start, s.end);
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
    for (const link of record.links) {
      // Every link cites both the flow tokens and the binding occurrence.
      assert.ok(link.bindingSpan.start >= link.span.start && link.bindingSpan.end <= link.span.end);
      assert.ok(link.tokenSpan.start >= link.span.start && link.tokenSpan.end <= link.span.end);
      assert.ok(link.bindingSpan.end > link.bindingSpan.start);
      assert.ok(link.tokenSpan.end > link.tokenSpan.start);
      assert.equal(bytesOf(link.bindingSpan).toString("utf8"), link.binding);
      if (link.tie.state === "resolved") {
        const tie = link.tie;
        assert.ok(
          tie.declarationBinding.start >= tie.declaration.start &&
            tie.declarationBinding.end <= tie.declaration.end,
        );
        assert.equal(bytesOf(tie.declarationBinding).toString("utf8"), link.binding);
        if (tie.via === "call-site") {
          assert.equal(tie.declaration.start, record.call.start);
          assert.equal(tie.declaration.end, record.call.end);
        } else if (tie.via === "call-result") {
          assert.ok(tie.declaration.start <= record.call.start);
          assert.ok(tie.declaration.end >= record.call.end);
        } else {
          assert.ok(link.bindingSpan.start >= record.call.start);
          assert.ok(link.bindingSpan.end <= record.call.end);
        }
      }
    }
    // Links never promote: a non-unknown claim rests on a resolved tie.
    if (record.state !== "unknown")
      assert.ok(record.links.some((link) => link.tie.state === "resolved"));
  }
  return records;
}

const citedText =
  (source: string) =>
  (s: { start: number; end: number }): string =>
    Buffer.from(source).subarray(s.start, s.end).toString("utf8");
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

test("nested response shadow cannot provide Axios status or data citations", async () => {
  const records = await scan(
    'import axios from "axios"; async function f() { const response = await axios.get("/x"); { const response = { status: 500, data: 1 }; if (response.status) console.log(response.data); } }',
  );
  assert.equal(records.find((r) => r.kind === "status-check")?.state, "unknown");
  assert.equal(records.find((r) => r.kind === "parsed-response")?.state, "unknown");
  const body =
    'import axios from "axios"; async function f() { const response = await axios.get("/x"); { const response = { status: 500, data: 1 }; if (response.status) console.log(response.data); } }';
  for (const kind of ["status-check", "parsed-response"]) {
    const record = records.find((r) => r.kind === kind)!;
    assert.ok(
      !record.citations.some(
        (s) =>
          Buffer.from(body).subarray(s.start, s.end).toString() === "response.status" ||
          Buffer.from(body).subarray(s.start, s.end).toString() === "response.data",
      ),
    );
  }
});
test("shadowed catch error is not the Axios catch binding", async () => {
  const records = await scan(
    'import axios from "axios"; async function f() { try { await axios.get("/x"); } catch (error) { { const error = {code:"FAKE"}; console.log(error.code); } } }',
  );
  assert.equal(records.find((r) => r.kind === "error-handling")?.state, "unknown");
});
test("fake signal origin does not ground cancellation propagation", async () => {
  const records = await scan(
    'import axios from "axios"; const fake = { signal: "bogus" }; axios.get("/x", {signal: fake.signal});',
  );
  assert.equal(records.find((r) => r.kind === "cancellation-propagation")?.state, "unknown");
});
test("AbortController origin cites both constructor and call option", async () => {
  const records = await scan(
    'import axios from "axios"; const controller = new AbortController(); axios.get("/x", {signal: controller.signal});',
  );
  const record = records.find((r) => r.kind === "cancellation-propagation")!;
  assert.equal(record.state, "inspected");
  assert.equal(record.citations.length, 2);
});
test("local class shadow of AbortController leaves cancellation unknown", async () => {
  const records = await scan(
    'import axios from "axios"; const AbortController = class { signal = "fake" }; const controller = new AbortController(); axios.get("/x", {signal: controller.signal});',
  );
  assert.equal(records.find((r) => r.kind === "cancellation-propagation")?.state, "unknown");
});
test("import and function parameter shadows cannot prove platform constructor", async () => {
  for (const body of [
    'import { AbortController } from "fake"; const controller = new AbortController(); axios.get("/x", {signal: controller.signal});',
    'function f(AbortController) { const controller = new AbortController(); axios.get("/x", {signal: controller.signal}); }',
  ]) {
    const records = await scan('import axios from "axios"; ' + body);
    assert.equal(records.find((r) => r.kind === "cancellation-propagation")?.state, "unknown");
  }
});
test("reflective mutation of controller signal blocks positive cancellation provenance", async () => {
  const records = await scan(
    'import axios from "axios"; const controller = new AbortController(); Object.defineProperty(controller,"signal",{value:"fake"}); axios.get("/x", {signal:controller.signal});',
  );
  assert.equal(records.find((r) => r.kind === "cancellation-propagation")?.state, "unknown");
});
test("alias of controller may mutate instance, so cancellation remains unknown", async () => {
  const records = await scan(
    'import axios from "axios"; const controller = new AbortController(); const alias = controller; alias.signal = "fake"; axios.get("/x", {signal:controller.signal});',
  );
  assert.equal(records.find((r) => r.kind === "cancellation-propagation")?.state, "unknown");
});
test("ordinary axios flow citations identify the exact check, data, catch and signal tokens", async () => {
  const source =
    'import axios from "axios"; async function f() { const controller = new AbortController(); try { const res = await axios.get("/é", { signal: controller.signal }); if (res.status !== 200) throw Error(); return res.data; } catch (error) { console.log(error.code); } }';
  const records = await scan(source);
  const cited = (kind: string) => {
    const record = records.find((r) => r.kind === kind)!;
    return record.citations.map((s) =>
      Buffer.from(source).subarray(s.start, s.end).toString("utf8"),
    );
  };
  assert.equal(records.find((r) => r.kind === "status-check")?.state, "inspected");
  assert.ok(cited("status-check").includes("res.status !== 200"));
  assert.equal(records.find((r) => r.kind === "parsed-response")?.state, "incompatible");
  assert.ok(cited("parsed-response").includes("res.data"));
  assert.equal(records.find((r) => r.kind === "error-handling")?.state, "inspected");
  assert.ok(cited("error-handling").some((text) => text.includes("error.code")));
  assert.equal(records.find((r) => r.kind === "cancellation-propagation")?.state, "inspected");
  assert.ok(cited("cancellation-propagation").includes("signal: controller.signal"));
  assert.ok(cited("cancellation-propagation").includes("controller = new AbortController()"));
});
test("dynamic response handler and captured response stay unknown", async () => {
  const dynamic = await scan('import axios from "axios"; axios.get("/").then(handler);');
  assert.equal(dynamic.find((r) => r.kind === "response-handling")?.state, "unknown");
  assert.match(dynamic.find((r) => r.kind === "response-handling")?.note ?? "", /dynamic/);
  const captured = await scan(
    'import axios from "axios"; async function f() { const res = await axios.get("/"); return () => res.data; }',
  );
  assert.equal(captured.find((r) => r.kind === "parsed-response")?.state, "unknown");
  assert.match(captured.find((r) => r.kind === "parsed-response")?.note ?? "", /nested handler/);
});

test("status check on the awaited binding is a fully resolved flow link", async () => {
  const source =
    'import axios from "axios"; async function f() { const res = await axios.get("/x"); if (res.status === 200) console.log("ok"); }';
  const cited = citedText(source);
  const records = await scan(source);
  const record = records.find((r) => r.kind === "status-check")!;
  assert.equal(record.state, "inspected");
  const resolved = record.links.filter((l) => l.tie.state === "resolved");
  assert.equal(resolved.length, 1);
  const link = resolved[0]!;
  assert.equal(link.binding, "res");
  assert.equal(cited(link.span), "res.status === 200");
  assert.equal(cited(link.bindingSpan), "res");
  assert.equal(cited(link.tokenSpan), ".status");
  assert.ok(link.tie.state === "resolved" && link.tie.via === "call-result");
  if (link.tie.state === "resolved") {
    assert.ok(cited(link.tie.declaration).startsWith("res = await axios.get("));
    assert.equal(cited(link.tie.declarationBinding), "res");
  }
  const handling = records.find((r) => r.kind === "response-handling")!;
  const awaitLink = handling.links.find((l) => l.tie.state === "resolved")!;
  assert.equal(awaitLink.binding, "axios");
  assert.ok(cited(awaitLink.tokenSpan).startsWith("await"));
  assert.equal(cited(awaitLink.bindingSpan), "axios");
});
test("parsed response use links the response binding to the call", async () => {
  const source =
    'import axios from "axios"; async function f() { const res = await axios.get("/x"); return res.data; }';
  const cited = citedText(source);
  const records = await scan(source);
  const record = records.find((r) => r.kind === "parsed-response")!;
  assert.equal(record.state, "incompatible");
  const link = record.links.find((l) => l.tie.state === "resolved")!;
  assert.equal(link.binding, "res");
  assert.equal(cited(link.span), "res.data");
  assert.equal(cited(link.tokenSpan), ".data");
  assert.ok(link.tie.state === "resolved" && link.tie.via === "call-result");
});
test("try/catch around the call links the awaited binding and the catch region", async () => {
  const source =
    'import axios from "axios"; async function f() { try { const res = await axios.get("/x"); } catch (error) { console.log(error.code); } }';
  const cited = citedText(source);
  const records = await scan(source);
  const record = records.find((r) => r.kind === "error-handling")!;
  assert.equal(record.state, "inspected");
  const link = record.links.find((l) => l.tie.state === "resolved")!;
  assert.equal(link.binding, "res");
  assert.ok(cited(link.span).startsWith("try {"));
  assert.ok(cited(link.span).includes("} catch (error) {"));
  assert.ok(cited(link.tokenSpan).startsWith("catch (error)"));
  assert.equal(cited(link.bindingSpan), "res");
  assert.ok(link.tie.state === "resolved" && link.tie.via === "call-result");
});
test("AbortController signal links the controller binding into the call options", async () => {
  const source =
    'import axios from "axios"; const controller = new AbortController(); axios.get("/x", { signal: controller.signal });';
  const cited = citedText(source);
  const records = await scan(source);
  const record = records.find((r) => r.kind === "cancellation-propagation")!;
  assert.equal(record.state, "inspected");
  const link = record.links.find((l) => l.tie.state === "resolved")!;
  assert.equal(link.binding, "controller");
  assert.equal(cited(link.span), "signal: controller.signal");
  assert.equal(cited(link.bindingSpan), "controller");
  assert.equal(cited(link.tokenSpan), "signal");
  assert.ok(link.tie.state === "resolved" && link.tie.via === "call-option");
  if (link.tie.state === "resolved") {
    assert.equal(cited(link.tie.declaration), "controller = new AbortController()");
    assert.equal(cited(link.tie.declarationBinding), "controller");
  }
});
test("status check on an unrelated variable is unresolved, never associated", async () => {
  const source =
    'import axios from "axios"; async function f() { const res = await axios.get("/x"); const other = { status: 500 }; if (other.status === 500) console.log("x"); }';
  const cited = citedText(source);
  const records = await scan(source);
  const record = records.find((r) => r.kind === "status-check")!;
  assert.equal(record.state, "unknown");
  const link = record.links.find((l) => l.binding === "other")!;
  assert.equal(link.tie.state, "unresolved");
  assert.equal(cited(link.span), "other.status === 500");
  assert.equal(cited(link.bindingSpan), "other");
  assert.equal(cited(link.tokenSpan), ".status");
  assert.ok(!record.links.some((l) => l.tie.state === "resolved"));
});
test("unrelated status checks never promote a linked response status check", async () => {
  const source =
    'import axios from "axios"; async function f() { const res = await axios.get("/x"); const other = { status: 500 }; if (res.status === 200) ok(); if (other.status === 500) bad(); }';
  const records = await scan(source);
  const record = records.find((r) => r.kind === "status-check")!;
  assert.equal(record.state, "inspected");
  assert.ok(record.links.some((l) => l.binding === "res" && l.tie.state === "resolved"));
  assert.ok(record.links.some((l) => l.binding === "other" && l.tie.state === "unresolved"));
});
test("dynamic response handler stays unknown but cites its flow span", async () => {
  const source = 'import axios from "axios"; axios.get("/").then(handler);';
  const cited = citedText(source);
  const records = await scan(source);
  const record = records.find((r) => r.kind === "response-handling")!;
  assert.equal(record.state, "unknown");
  assert.match(record.note ?? "", /dynamic/);
  const link = record.links.find((l) => l.tie.state === "resolved")!;
  assert.equal(link.binding, "axios");
  assert.equal(cited(link.span), 'axios.get("/").then(handler)');
  assert.equal(cited(link.tokenSpan), ".then");
  assert.equal(cited(link.bindingSpan), "axios");
});
test("reassigned response binding severs flow link ties", async () => {
  const source =
    'import axios from "axios"; async function f() { let res = await axios.get("/x"); res = {}; if (res.status === 200) console.log("x"); }';
  const records = await scan(source);
  const record = records.find((r) => r.kind === "status-check")!;
  assert.equal(record.state, "unknown");
  const links = record.links.filter((l) => l.binding === "res");
  assert.ok(links.length >= 1);
  assert.ok(links.every((l) => l.tie.state === "unresolved"));
});
