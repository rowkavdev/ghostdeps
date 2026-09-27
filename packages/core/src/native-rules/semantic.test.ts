import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FsRepositoryHandle } from "../engine/scanner/handle.js";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import {
  collectNativeSemanticEvidence,
  type NativeFlowInspection,
  type NativeFlowKind,
} from "./semantic.js";
import { mintNativeSnapshot } from "./snapshot.js";
const source =
  'import axios from "axios";\nasync function f() { const response = await axios.get("/x"); if (response.status) throw Error(); return response.data; }\n';
const policy = "a".repeat(64);
const file = "src/a.ts";
const span = (needle: string) => {
  const start = Buffer.from(source).indexOf(Buffer.from(needle));
  assert.ok(start >= 0);
  return { file, start, end: start + Buffer.byteLength(needle) };
};
const call = span('axios.get("/x")');
const repo = (): RepositoryHandle => {
  const entries: RepositoryTreeEntry[] = [{ path: file, kind: "file" }];
  return {
    listFiles: async () => [file],
    readFile: async () => source,
    exists: async () => true,
    listEntries: async () => ({ entries, complete: true, limitations: [], policy }),
    readFileBytes: async () => Buffer.from(source),
  };
};
const mapping: Record<NativeFlowKind, number> = {
  "response-handling": 0,
  "status-check": 0,
  "parsed-response": 1,
  "error-handling": 0,
  "cancellation-propagation": 2,
};
const candidates: Record<NativeFlowKind, string> = {
  "response-handling": 'await axios.get("/x")',
  "status-check": "response.status",
  "parsed-response": "response.data",
  "error-handling": "catch (error)",
  "cancellation-propagation": "signal: controller.signal",
};
const allKinds = Object.keys(mapping) as NativeFlowKind[];
function flow(
  kind: NativeFlowKind,
  change: Partial<NativeFlowInspection> = {},
): NativeFlowInspection {
  const citation =
    kind === "error-handling" || kind === "cancellation-propagation"
      ? call
      : span(candidates[kind]);
  return {
    difference: AXIOS_FETCH_RULE.semanticDifferences[mapping[kind]]!,
    kind,
    call,
    lineage: [span('import axios from "axios"')],
    state: "inspected",
    citations: [citation],
    explored: [call, citation],
    capped: false,
    ...change,
  };
}
async function run(records: NativeFlowInspection[]) {
  const repository = repo(),
    binding = await mintNativeSnapshot(repository);
  assert.equal(binding.status, "verified");
  return collectNativeSemanticEvidence(
    repository,
    AXIOS_FETCH_RULE,
    binding.snapshotSha256,
    [call],
    records,
  );
}
describe("native semantic pillar (#450)", () => {
  it("carries cited response/status inspection but blocks unknown error and incompatible parsed response", async () => {
    const records = allKinds.map((k) =>
      flow(
        k,
        k === "error-handling"
          ? { state: "unknown" }
          : k === "parsed-response"
            ? { state: "incompatible" }
            : {},
      ),
    );
    const result = await run(records);
    assert.equal(result.status, "blocked");
    assert.equal(result.lineageVerification, "adapter-asserted");
    assert.equal(result.checks.length, 3);
    assert.equal(result.checks[0]?.state, "unknown");
    assert.equal(result.checks[1]?.state, "incompatible");
    assert.equal(
      result.blocking.some((b) => b.reason === "incompatible"),
      true,
    );
  });
  it("missing or capped explored sets block despite inspected labels", async () => {
    const records = allKinds.map((k) => flow(k));
    for (const changed of [
      records.filter((r) => r.kind !== "error-handling"),
      records.map((r) => (r.kind === "status-check" ? { ...r, explored: [] } : r)),
      records.map((r) => (r.kind === "status-check" ? { ...r, capped: true } : r)),
    ]) {
      const result = await run(changed);
      assert.equal(result.status, "blocked");
      assert.ok(
        result.blocking.some(
          (b) =>
            b.reason === "missing-flow" ||
            b.reason === "incomplete-exploration" ||
            b.reason === "citation-inconsistent",
        ),
      );
    }
  });
  it("rejects forged, out-of-bounds, and missing citations; no promotion", async () => {
    const base = allKinds.map((k) => flow(k));
    for (const bad of [
      { ...span("response.status"), end: 99999 },
      { ...span("response.status"), file: "src/other.ts" },
      span('import axios from "axios"'),
    ]) {
      const records = base.map((r) => (r.kind === "status-check" ? { ...r, citations: [bad] } : r));
      const result = await run(records);
      assert.equal(result.status, "blocked");
      assert.equal(
        result.blocking.some((b) => b.reason === "citation-inconsistent"),
        true,
      );
    }
  });
  it("malformed runtime spans block rather than throwing", async () => {
    const base = allKinds.map((k) => flow(k));
    for (const field of ["explored", "lineage", "citations"] as const) {
      const bad = base.map((r) => (r.kind === "status-check" ? { ...r, [field]: [null] } : r));
      const result = await run(bad as unknown as NativeFlowInspection[]);
      assert.equal(result.status, "blocked");
      assert.equal(
        result.blocking.some((b) => b.reason === "citation-inconsistent"),
        true,
      );
    }
  });
  it("caller-asserted mismatch blocks, and the real scanner handle reads expected entries", async () => {
    const wrong = await collectNativeSemanticEvidence(
      repo(),
      AXIOS_FETCH_RULE,
      "b".repeat(64),
      [call],
      allKinds.map((k) => flow(k)),
    );
    assert.equal(wrong.status, "blocked");
    assert.equal(wrong.binding, "caller-asserted");
    const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-semantic-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, file), source);
      const repository = await FsRepositoryHandle.open(root),
        binding = await mintNativeSnapshot(repository);
      assert.equal(binding.status, "verified");
      const result = await collectNativeSemanticEvidence(
        repository,
        AXIOS_FETCH_RULE,
        binding.snapshotSha256,
        [call],
        allKinds.map((k) => flow(k)),
      );
      assert.equal(result.binding, "verified");
      assert.equal(result.lineageVerification, "adapter-asserted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
