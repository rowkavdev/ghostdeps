// Regression for the #172 review: actual malformed CLI output at exit 0 must
// fail the pin actionably, never crash the harness. Exercises the same
// parseScanOutput the corpus loop calls with the CLI's real stdout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScanOutput } from "./corpus-scan-output.mjs";

test("exit 0 with garbage stdout is an actionable parse error", () => {
  const { error, result } = parseScanOutput(0, "thread 'main' panicked at cli.rs:42\n");
  assert.equal(result, undefined);
  assert.match(error, /not parseable/);
  assert.match(error, /CLI contract broke/);
});

test("exit 0 with valid JSON null is rejected, not dereferenced", () => {
  const { error } = parseScanOutput(0, "null");
  assert.match(error, /was null - expected an object/);
});

test("exit 0 with valid JSON array is rejected", () => {
  const { error } = parseScanOutput(0, "[]");
  assert.match(error, /was an array - expected an object/);
});

test("exit 0 with {} has no findings array", () => {
  const { error } = parseScanOutput(0, "{}");
  assert.match(error, /no findings array/);
});

test("exit 0 with non-array findings is rejected", () => {
  const { error } = parseScanOutput(0, '{"findings": "none"}');
  assert.match(error, /no findings array/);
});

test("exit 0 with a malformed finding entry names its index", () => {
  const { error } = parseScanOutput(0, '{"findings": [{"severity": "high"}]}');
  assert.match(error, /findings\[0\] is malformed/);
});

test("exit 0 with a bad severity type names its index", () => {
  const { error } = parseScanOutput(0, '{"findings": [{"kind": "unused", "severity": 3}]}');
  assert.match(error, /findings\[0\] is malformed/);
});

test("nonzero exit carries no stdout contract", () => {
  assert.deepEqual(parseScanOutput(1, "not json at all"), { result: undefined });
});

test("well-formed output parses through", () => {
  const stdout = JSON.stringify({
    findings: [
      { kind: "unused", severity: "medium", dependency: "chalk" },
      { kind: "missing", dependency: null },
    ],
    dependencies: [{ name: "chalk" }],
  });
  const { error, result } = parseScanOutput(0, stdout);
  assert.equal(error, undefined);
  assert.equal(result.findings.length, 2);
});
