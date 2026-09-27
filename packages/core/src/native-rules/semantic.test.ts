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
    state: "inspected-observed",
    links: [],
    linksCapped: false,
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
  it("carries cited response/status inspection but blocks unresolved flows", async () => {
    const records = allKinds.map((k) =>
      flow(
        k,
        k === "error-handling"
          ? { state: "unknown" }
          : k === "parsed-response"
            ? { state: "unknown", note: "response parsing unresolved" }
            : {},
      ),
    );
    const result = await run(records);
    assert.equal(result.status, "blocked");
    assert.equal(result.lineageVerification, "adapter-asserted");
    assert.equal(result.checks.length, 3);
    assert.equal(result.checks[0]?.state, "unknown");
    assert.equal(result.checks[1]?.state, "unknown");
    assert.ok(
      result.blocking.some((b) => b.reason === "unknown" || b.reason === "association-unresolved"),
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
  it("validates a cited status tie against a package-entry chain and fails closed on falsification", async () => {
    const imported = span('import axios from "axios"');
    const local = span("axios");
    const specifier = span('"axios"');
    const callee = { ...call, end: call.start + Buffer.byteLength("axios.get") };
    const chain = {
      links: [
        {
          kind: "import" as const,
          from: "axios",
          to: "axios",
          span: imported,
          fromSpan: local,
          toSpan: local,
          specifierSpan: specifier,
        },
        {
          kind: "call" as const,
          from: "axios",
          to: "get",
          span: call,
          fromSpan: callee,
          toSpan: callee,
        },
      ],
    };
    const condition = span("response.status");
    const binding = { ...condition, end: condition.start + Buffer.byteLength("response") };
    const token = { ...condition, start: binding.end };
    const declaration = span('response = await axios.get("/x")');
    const declarationBinding = {
      ...declaration,
      end: declaration.start + Buffer.byteLength("response"),
    };
    const linked = flow("status-check", {
      lineageChain: chain,
      linksCapped: false,
      links: [
        {
          binding: "response",
          span: condition,
          bindingSpan: binding,
          tokenSpan: token,
          tie: { state: "resolved", via: "call-result", declaration, declarationBinding },
        },
      ],
    });
    const rule = {
      ...AXIOS_FETCH_RULE,
      semanticDifferences: [AXIOS_FETCH_RULE.semanticDifferences[0]!],
    };
    const repository = repo();
    const snapshot = await mintNativeSnapshot(repository);
    assert.equal(snapshot.status, "verified");
    const base = [
      flow("response-handling", {
        lineageChain: chain,
        linksCapped: false,
        links: [
          {
            binding: "axios",
            span: span('await axios.get("/x")'),
            bindingSpan: { ...call, end: call.start + 5 },
            tokenSpan: { ...call, start: call.start - 6, end: call.start },
            tie: {
              state: "resolved",
              via: "call-site",
              declaration: call,
              declarationBinding: { ...call, end: call.start + 5 },
            },
          },
        ],
      }),
      linked,
    ];
    const check = (records: NativeFlowInspection[]) =>
      collectNativeSemanticEvidence(repository, rule, snapshot.snapshotSha256, [call], records);
    const noErrorKind = await check(base);
    assert.equal(noErrorKind.status, "blocked"); // missing mapped error-handling record
    assert.equal(noErrorKind.blocking[0]?.reason, "missing-flow");
    assert.equal(
      noErrorKind.blocking.some((b) => b.reason === "association-unresolved"),
      false,
    );
    for (const bad of [
      { ...linked, links: [{ ...linked.links![0]!, binding: "other" }] },
      { ...linked, links: [{ ...linked.links![0]!, tokenSpan: span("response.data") }] },
      { ...linked, linksCapped: true },
      {
        ...linked,
        links: [
          { ...linked.links![0]!, tie: { state: "unresolved" as const, reason: "shadowed" } },
        ],
      },
    ]) {
      const outcome = await check([
        base[0]!,
        bad,
        flow("error-handling", { state: "unknown", note: "not inspected" }),
      ]);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.lineageVerification, "adapter-asserted");
      assert.ok(
        outcome.blocking.some((b) => b.reason !== "missing-flow"),
        JSON.stringify(outcome.blocking),
      );
    }
  });
  it("upgrades fully linked observed flows and bounded absent kinds", async () => {
    const importSite = span('import axios from "axios"');
    const local = span("axios");
    const callee = { ...call, end: call.start + Buffer.byteLength("axios.get") };
    const chain = {
      links: [
        {
          kind: "import" as const,
          from: "axios",
          to: "axios",
          span: importSite,
          fromSpan: local,
          toSpan: local,
          specifierSpan: span('"axios"'),
        },
        {
          kind: "call" as const,
          from: "axios",
          to: "get",
          span: call,
          fromSpan: callee,
          toSpan: callee,
        },
      ],
    };
    const declaration = span('response = await axios.get("/x")');
    const declarationBinding = { ...declaration, end: declaration.start + 8 };
    const responseLink = (kind: "status-check" | "parsed-response") => {
      const site = span(kind === "status-check" ? "response.status" : "response.data");
      const bindingSpan = { ...site, end: site.start + 8 };
      return {
        binding: "response",
        span: site,
        bindingSpan,
        tokenSpan: { ...site, start: bindingSpan.end },
        tie: {
          state: "resolved" as const,
          via: "call-result" as const,
          declaration,
          declarationBinding,
        },
      };
    };
    const awaited = span('await axios.get("/x")');
    const callBinding = { ...call, end: call.start + 5 };
    const scope = span(
      '{ const response = await axios.get("/x"); if (response.status) throw Error(); return response.data; }',
    );
    const argument = span('"/x"');
    const negative = { scope, options: [argument], inspected: [call, scope] };
    const absent = (kind: "error-handling" | "cancellation-propagation"): NativeFlowInspection =>
      flow(kind, {
        state: "inspected-absent",
        lineageChain: chain,
        negativeProof: negative,
        citations: [scope, argument],
        explored: [call, scope],
        links: [],
        linksCapped: false,
      });
    const records = [
      flow("response-handling", {
        lineageChain: chain,
        linksCapped: false,
        links: [
          {
            binding: "axios",
            span: awaited,
            bindingSpan: callBinding,
            tokenSpan: { ...awaited, end: call.start },
            tie: {
              state: "resolved",
              via: "call-site",
              declaration: call,
              declarationBinding: callBinding,
            },
          },
        ],
      }),
      flow("status-check", {
        lineageChain: chain,
        linksCapped: false,
        links: [responseLink("status-check")],
      }),
      flow("parsed-response", {
        lineageChain: chain,
        linksCapped: false,
        links: [responseLink("parsed-response")],
      }),
      absent("error-handling"),
      absent("cancellation-propagation"),
    ];
    const result = await run(records);
    assert.equal(result.status, "pass", JSON.stringify(result.blocking));
    assert.equal(result.lineageVerification, "core-reconstructed");
    assert.deepEqual(
      result.checks.map((c) => c.state),
      ["inspected", "inspected", "inspected"],
    );
    const truncatedScope = { ...scope, end: call.end + 1 };
    const truncated = records.map((r) =>
      r.kind === "cancellation-propagation"
        ? {
            ...r,
            citations: [truncatedScope, argument],
            explored: [call, truncatedScope],
            negativeProof: {
              scope: truncatedScope,
              options: [argument],
              inspected: [call, truncatedScope],
            },
          }
        : r,
    );
    const truncatedResult = await run(truncated);
    assert.equal(truncatedResult.status, "blocked");
    assert.ok(truncatedResult.blocking.some((b) => b.reason === "absence-unreconstructed"));
    const hiddenStatus = records.map((r) =>
      r.kind === "status-check"
        ? {
            ...r,
            state: "inspected-absent" as const,
            links: [],
            citations: [scope, argument],
            explored: [call, scope],
            negativeProof: negative,
          }
        : r,
    );
    const hiddenResult = await run(hiddenStatus);
    assert.equal(hiddenResult.status, "blocked");
    assert.ok(hiddenResult.blocking.some((b) => b.reason === "absence-unreconstructed"));
    const forged = records.map((r) =>
      r.kind === "cancellation-propagation"
        ? { ...r, negativeProof: { ...negative, options: [] } }
        : r,
    );
    const refused = await run(forged);
    assert.equal(refused.status, "blocked");
    assert.equal(refused.lineageVerification, "adapter-asserted");
    assert.ok(refused.blocking.some((b) => b.reason === "absence-unreconstructed"));
  });
  it("refuses nested var-result negative scope despite true inner-block citations", async () => {
    const content =
      'import axios from "axios"; async function f() { if (true) { var res = await axios.get("/x"); } if (res.status === 200) return res.data; }';
    const file = "src/var.ts";
    const locate = (needle: string) => {
      const start = Buffer.from(content).indexOf(needle);
      assert.ok(start >= 0);
      return { file, start, end: start + Buffer.byteLength(needle) };
    };
    const use = locate('axios.get("/x")');
    const scope = locate('{ var res = await axios.get("/x"); }');
    const argument = locate('"/x"');
    const inspected = [use, scope];
    const repository: RepositoryHandle = {
      listEntries: async () => ({
        entries: [{ path: file, kind: "file" }],
        complete: true,
        limitations: [],
        policy,
      }),
      readFileBytes: async () => Buffer.from(content),
      listFiles: async () => [file],
      readFile: async () => content,
      exists: async () => true,
    };
    const snapshot = await mintNativeSnapshot(repository);
    assert.equal(snapshot.status, "verified");
    const records: NativeFlowInspection[] = (["status-check", "parsed-response"] as const).map(
      (kind) => ({
        difference: AXIOS_FETCH_RULE.semanticDifferences[kind === "status-check" ? 0 : 1]!,
        kind,
        call: use,
        lineage: [locate('import axios from "axios"')],
        state: "inspected-absent",
        citations: [scope, argument],
        explored: inspected,
        links: [],
        linksCapped: false,
        capped: false,
        negativeProof: { scope, options: [argument], inspected },
      }),
    );
    const result = await collectNativeSemanticEvidence(
      repository,
      AXIOS_FETCH_RULE,
      snapshot.snapshotSha256,
      [use],
      records,
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.lineageVerification, "adapter-asserted");
    assert.ok(result.blocking.some((b) => b.reason === "absence-unreconstructed"));
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
