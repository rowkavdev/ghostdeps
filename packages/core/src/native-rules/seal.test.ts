import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepositoryHandle, RepositoryTreeEntry, Dependency } from "../types/index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import type { NativePillars, NativeSealedEvidence } from "./seal.js";
import { assembleNativeEnvelope } from "./seal.js";
import { mintNativeSnapshot } from "./snapshot.js";
import type { NativeSourceProof } from "./producer.js";
const policy = "c".repeat(64);
const contents: Record<string, string> = {
  "package.json": '{"dependencies":{"axios":"^1.0.0"}}',
  "src/a.ts": 'import axios from "axios"; axios.get("/x");',
};
const repo = (data = contents): RepositoryHandle => {
  const entries: RepositoryTreeEntry[] = Object.keys(data).map((path) => ({ path, kind: "file" }));
  return {
    listFiles: async () => Object.keys(data),
    readFile: async (file) => data[file]!,
    exists: async (file) => file in data,
    listEntries: async () => ({ entries, complete: true, limitations: [], policy }),
    readFileBytes: async (file) => Buffer.from(data[file]!),
  };
};
const dep: Dependency = {
  name: "axios",
  constraint: "^1.0.0",
  kind: "runtime",
  declaredIn: "package.json",
  project: { path: ".", ecosystem: "javascript-typescript", packageManagers: [] },
};
function components(snapshotSha256: string): NativePillars {
  const source: NativeSourceProof = {
    snapshotSha256,
    file: "src/a.ts",
    line: 1,
    span: { sha256: "a".repeat(64) },
  };
  const target: NativeSourceProof = {
    snapshotSha256,
    file: "ghostdeps.targets.json",
    line: 1,
    span: { sha256: "b".repeat(64) },
  };
  const rule = {
    ...AXIOS_FETCH_RULE,
    incompatibleUses: ["timeout"],
    semanticDifferences: ["response handled"],
  };
  void rule;
  const matched = {
    packageName: "axios",
    binding: "get",
    callTarget: "axios.get",
    api: "get",
    source,
    arguments: "inspected" as const,
    options: "inspected" as const,
    resolution: "direct" as const,
  };
  return {
    deployment: {
      status: "pass",
      snapshotSha256,
      binding: "verified",
      policy,
      targets: [
        {
          binding: "verified",
          target: "production",
          runtime: "node",
          minimumVersion: "22.0.0",
          declaration: target,
          declarationText: '"node":">=22"',
          authority: "deployment",
        },
      ],
      blocking: [],
    },
    matched: {
      status: "pass",
      snapshotSha256,
      binding: "verified",
      lineageVerification: "core-reconstructed",
      policy,
      matchedApis: [matched],
      accounted: [],
      blocking: [],
    },
    incompatible: {
      status: "pass",
      snapshotSha256,
      binding: "verified",
      lineageVerification: "core-reconstructed",
      policy,
      checks: [
        {
          patternId: "timeout",
          state: "absent",
          scope: { snapshotSha256, files: ["src/a.ts"], calls: [source], complete: true },
          locations: [],
          negativeProof: {
            snapshotSha256,
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
      snapshotSha256,
      binding: "verified",
      lineageVerification: "core-reconstructed",
      policy,
      checks: [
        {
          difference: "response handled",
          use: source,
          state: "inspected",
          inspectedSource: [source],
        },
      ],
      blocking: [],
    },
  };
}
const rule = {
  ...AXIOS_FETCH_RULE,
  incompatibleUses: ["timeout"],
  semanticDifferences: ["response handled"],
};
async function setup() {
  const repository = repo(),
    snapshot = await mintNativeSnapshot(repository);
  assert.equal(snapshot.status, "verified");
  return {
    repository,
    snapshotSha256: snapshot.snapshotSha256,
    pillars: components(snapshot.snapshotSha256),
  };
}
describe("native envelope seal (#454)", () => {
  it("synthetic core-reconstructed seam seals only with computed complete coverage and direct declaration", async () => {
    const { repository, snapshotSha256, pillars } = await setup();
    const result = await assembleNativeEnvelope(repository, rule, dep, snapshotSha256, pillars);
    assert.equal(result.status, "produced");
    if (result.status !== "produced") return;
    assert.equal(result.evidence.lineageVerification, "core-reconstructed");
    assert.equal(result.evidence.evidence.referencesComplete, true);
    assert.equal(result.evidence.evidence.declaration.file, "package.json");
    assert.match(
      String((result.evidence.evidence.declaration.span as { sha256: string }).sha256),
      /^[a-f0-9]{64}$/,
    );
  });
  it("refuses adapter-asserted lineage even when all four pillars pass", async () => {
    const { repository, snapshotSha256, pillars } = await setup();
    const changed = {
      ...pillars,
      matched: { ...pillars.matched, lineageVerification: "adapter-asserted" as const },
    } as NativePillars;
    const result = await assembleNativeEnvelope(repository, rule, dep, snapshotSha256, changed);
    assert.equal(result.status, "blocked");
    if (result.status === "blocked")
      assert.ok(
        result.refusals.some((r) => r.reason === "adapter-lineage" && r.pillar === "matched"),
      );
  });
  it("aggregates all blocked pillars verbatim and rejects caller binding, identity and coverage", async () => {
    const { repository, snapshotSha256, pillars } = await setup();
    const blocked = {
      ...pillars,
      matched: {
        ...pillars.matched,
        status: "blocked" as const,
        blocking: [{ reason: "uninspected-use" as const, referenceIndex: 0, detail: "unknown" }],
      },
      semantic: {
        ...pillars.semantic,
        status: "blocked" as const,
        blocking: [{ difference: "response handled", reason: "unknown" as const }],
      },
      incompatible: { ...pillars.incompatible, binding: "caller-asserted" as const },
      deployment: { ...pillars.deployment, policy: "e".repeat(64) },
    } as NativePillars;
    const result = await assembleNativeEnvelope(repository, rule, dep, snapshotSha256, blocked);
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") {
      assert.equal(result.pillars, blocked);
      assert.deepEqual(result.pillars.matched.blocking, blocked.matched.blocking);
      assert.ok(
        result.refusals.some((r) => r.reason === "pillar-blocked" && r.pillar === "semantic"),
      );
      assert.ok(
        result.refusals.some(
          (r) => r.reason === "binding-unverified" && r.pillar === "incompatible",
        ),
      );
      assert.ok(
        result.refusals.some((r) => r.reason === "identity-mismatch" && r.pillar === "deployment"),
      );
    }
  });
  it("refuses transitive or wrong direct declaration", async () => {
    const { repository, snapshotSha256, pillars } = await setup();
    for (const wrong of [
      { ...dep, name: "other" },
      { ...dep, constraint: "^2.0.0" },
      { ...dep, kind: "build" as const },
    ]) {
      const result = await assembleNativeEnvelope(repository, rule, wrong, snapshotSha256, pillars);
      assert.equal(result.status, "blocked");
      if (result.status === "blocked")
        assert.ok(result.refusals.some((r) => r.reason === "declaration-unverified"));
    }
  });
});
// @ts-expect-error seal is private: callers cannot construct this opaque output.
const forged: NativeSealedEvidence = {
  evidence: {} as NativeSealedEvidence["evidence"],
  lineageVerification: "core-reconstructed",
};
void forged;
