import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepositoryHandle, RepositoryTreeEntry, Dependency } from "../types/index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import { assembleNativeEnvelope, type NativePillars, type NativeEnvelopeResult } from "./seal.js";
import { evaluateNativePolicy } from "./policy.js";
import { mintNativeSnapshot } from "./snapshot.js";

const rule = {
  ...AXIOS_FETCH_RULE,
  incompatibleUses: ["timeout"],
  semanticDifferences: ["response handled"],
};
const policy = "c".repeat(64);
const files: Record<string, string> = {
  "package.json": '{"dependencies":{"axios":"^1.0.0"}}',
  "src/a.ts": 'import axios from "axios"; axios.get("/x");',
};
const repository = (data = files): RepositoryHandle => {
  const entries: RepositoryTreeEntry[] = Object.keys(data).map((path) => ({ path, kind: "file" }));
  return {
    listFiles: async () => Object.keys(data),
    readFile: async (file) => data[file]!,
    exists: async (file) => file in data,
    listEntries: async () => ({ entries, complete: true, limitations: [], policy }),
    readFileBytes: async (file) => Buffer.from(data[file]!),
  };
};
const dependency: Dependency = {
  name: "axios",
  constraint: "^1.0.0",
  kind: "runtime",
  declaredIn: "package.json",
  project: { path: ".", ecosystem: "javascript-typescript", packageManagers: [] },
};
async function assembled() {
  const repo = repository();
  const binding = await mintNativeSnapshot(repo);
  assert.equal(binding.status, "verified");
  const digest = binding.snapshotSha256;
  const use = {
    snapshotSha256: digest,
    file: "src/a.ts",
    line: 1,
    span: { sha256: "a".repeat(64) },
  };
  const declaration = {
    snapshotSha256: digest,
    file: "ghostdeps.targets.json",
    line: 1,
    span: { sha256: "b".repeat(64) },
  };
  const pillars = {
    deployment: {
      status: "pass",
      snapshotSha256: digest,
      binding: "verified",
      policy,
      targets: [
        {
          binding: "verified",
          target: "production",
          runtime: "node",
          minimumVersion: "22.0.0",
          declaration,
          declarationText: '"node":">=22"',
          authority: "deployment",
        },
      ],
      blocking: [],
    },
    matched: {
      status: "pass",
      snapshotSha256: digest,
      binding: "verified",
      lineageVerification: "core-reconstructed",
      policy,
      matchedApis: [
        {
          packageName: "axios",
          binding: "get",
          callTarget: "axios.get",
          api: "get",
          source: use,
          arguments: "inspected",
          options: "inspected",
          resolution: "direct",
        },
      ],
      accounted: [],
      lineageAccounting: [{ referenceIndex: 0, status: "core-reconstructed" }],
      blocking: [],
    },
    incompatible: {
      status: "pass",
      snapshotSha256: digest,
      binding: "verified",
      lineageVerification: "core-reconstructed",
      policy,
      checks: [
        {
          patternId: "timeout",
          state: "absent",
          scope: { snapshotSha256: digest, files: ["src/a.ts"], calls: [use], complete: true },
          locations: [],
          negativeProof: {
            snapshotSha256: digest,
            policy,
            patternId: "timeout",
            kind: "option-key-value",
            eligibility: "js-ts-pattern-files-v1",
            listingSha256: "c".repeat(64),
            files: [],
            sha256: "d".repeat(64),
          },
        },
      ],
      blocking: [],
    },
    semantic: {
      status: "pass",
      snapshotSha256: digest,
      binding: "verified",
      lineageVerification: "core-reconstructed",
      policy,
      checks: [{ difference: "response handled", use, state: "inspected", inspectedSource: [use] }],
      blocking: [],
    },
  } as NativePillars;
  const envelope = await assembleNativeEnvelope(repo, rule, dependency, digest, pillars);
  assert.equal(envelope.status, "produced");
  return { repo, digest, pillars, envelope };
}

describe("sealed native policy gate (#460)", () => {
  it("emits only on live assembled seal with matched locations and negative evidence", async () => {
    const { repo, digest, envelope } = await assembled();
    const result = await evaluateNativePolicy(repo, rule, digest, envelope);
    assert.equal(result.status, "produced");
    if (result.status !== "produced") return;
    assert.equal(result.finding.kind, "potentially-unnecessary");
    assert.equal(result.finding.rule, rule.id);
    assert.ok(
      result.finding.evidence.some((e) => e.kind === "native-api-matched" && e.file === "src/a.ts"),
    );
    assert.ok(
      result.finding.evidence.some(
        (e) => e.kind === "native-incompatibility-excluded" && e.statement.includes("d".repeat(64)),
      ),
    );
  });
  it("names a failing pillar and rejects adapter-asserted lineage", async () => {
    const { repo, digest, pillars } = await assembled();
    const failing = await assembleNativeEnvelope(repo, rule, dependency, digest, {
      ...pillars,
      matched: {
        ...pillars.matched,
        status: "blocked",
        blocking: [{ reason: "lineage-unreconstructed", detail: "gap" }],
      },
    } as NativePillars);
    const result = await evaluateNativePolicy(repo, rule, digest, failing);
    assert.deepEqual(result, { status: "blocked", reason: "pillar-blocked", pillar: "matched" });
    const asserted = await assembleNativeEnvelope(repo, rule, dependency, digest, {
      ...pillars,
      matched: { ...pillars.matched, lineageVerification: "adapter-asserted" },
    } as NativePillars);
    const refused = await evaluateNativePolicy(repo, rule, digest, asserted);
    assert.equal(refused.status, "blocked");
    if (refused.status === "blocked") assert.equal(refused.reason, "adapter-lineage");
  });
  it("blocks wrong rule version, stale tree and caller-filled or cloned evidence", async () => {
    const { repo, digest, envelope } = await assembled();
    const changed = { ...rule, id: "javascript-typescript/axios-to-fetch/v2" };
    const wrong = await evaluateNativePolicy(repo, changed, digest, envelope);
    assert.deepEqual(wrong, { status: "blocked", reason: "rule-version-mismatch" });
    for (const altered of [
      { nativeCapability: "replacement()" },
      { minimumRuntime: { node: "1.0.0" } },
      { coveredApis: ["get", "post"] },
      { semanticDifferences: ["response handled", "new behavior"] },
      { incompatibleUses: ["timeout", "new risk"] },
    ]) {
      const result = await evaluateNativePolicy(repo, { ...rule, ...altered }, digest, envelope);
      assert.deepEqual(result, { status: "blocked", reason: "rule-content-mismatch" });
    }
    const stale = await evaluateNativePolicy(
      repository({ ...files, "src/a.ts": 'axios.get("/changed")' }),
      rule,
      digest,
      envelope,
    );
    assert.equal(stale.status, "blocked");
    const forged = structuredClone(envelope) as NativeEnvelopeResult;
    assert.deepEqual(await evaluateNativePolicy(repo, rule, digest, forged), {
      status: "blocked",
      reason: "not-live-assembler-seal",
    });
    if (envelope.status === "produced") {
      const filled = {
        status: "produced",
        evidence: { ...envelope.evidence, evidence: structuredClone(envelope.evidence.evidence) },
      } as NativeEnvelopeResult;
      assert.deepEqual(await evaluateNativePolicy(repo, rule, digest, filled), {
        status: "blocked",
        reason: "not-live-assembler-seal",
      });
      (envelope.evidence.evidence.matchedApis[0]! as { api: string }).api = "post";
      const stillBound = await evaluateNativePolicy(repo, rule, digest, envelope);
      assert.equal(stillBound.status, "produced");
    }
  });
  it("keeps the shape-only evaluator outside public verdict exports", async () => {
    const api = await import("./index.js");
    assert.equal("evaluateNativeRule" in api, false);
    assert.equal("assembleNativeEnvelope" in api, true);
  });
});
