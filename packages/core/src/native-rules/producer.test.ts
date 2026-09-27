import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeProducerInput } from "./producer.js";
import { produceNativeEvidence } from "./producer.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import type { NativeSourceProof } from "./producer.js";

const snapshotSha256 = "a".repeat(64);
const source: NativeSourceProof = {
  snapshotSha256,
  file: "src/client.ts",
  line: 4,
  span: { start: 56, end: 84 },
};

const base = (): NativeProducerInput => ({
  rule: AXIOS_FETCH_RULE,
  snapshotSha256,
  repository: {
    listFiles: async () => ["package.json", "src/client.ts"],
    readFile: async (path) =>
      path === "package.json"
        ? '{"dependencies":{"axios":"^1.0.0"}}'
        : 'import axios from "axios"; axios.get("/")',
    exists: async () => true,
  },
  dependency: {
    name: "axios",
    constraint: "^1.0.0",
    kind: "runtime",
    project: { path: ".", ecosystem: "javascript-typescript", packageManagers: [] },
    declaredIn: "package.json",
  },
  references: {
    referenceAnalysisComplete: true,
    usages: [
      {
        dependency: "axios",
        file: source.file,
        line: source.line,
        form: "static",
        symbols: ["get"],
      },
    ],
  },
});

describe("native evidence producer boundary (#435)", () => {
  it("does not promote a known member name to a source-validated verdict", async () => {
    assert.deepEqual(await produceNativeEvidence(base()), {
      status: "blocked",
      reason: "Source-validating native evidence production is not implemented.",
    });
  });

  it("blocks unknown and indirect references even when one get is known", async () => {
    const input = base();
    const reference = input.references.usages[0]!;
    const withUnknown = {
      ...input,
      references: {
        ...input.references,
        usages: [reference, { ...reference, form: "unknown" as const, symbols: [] }],
      },
    };
    assert.equal((await produceNativeEvidence(withUnknown)).status, "blocked");
  });

  it("does not exclude unchecked or observed incompatibilities", async () => {
    assert.equal(absent.state, "absent");
    assert.equal(absent.scope.complete, true);
    assert.equal(absent.negativeProof.snapshotSha256, snapshotSha256);
    assert.equal(observed.locations.length, 1);
    assert.equal((await produceNativeEvidence(base())).status, "blocked");
  });

  it("does not infer deployment from a caller-provided runtime", async () => {
    assert.equal((await produceNativeEvidence(base())).status, "blocked");
  });
});

// Compile-time reference fixtures: a negative check is only a complete,
// snapshot-bound scope; an observed use must identify at least one location.
import type {
  NativeEligibilityEvidence,
  NativeIncompatibleCheck,
  NativeMatchedApi,
  NativeSemanticCheck,
} from "./producer.js";

const inspected = {
  snapshotSha256,
  files: [source.file],
  calls: [source],
  complete: true as const,
};
const absent: NativeIncompatibleCheck = {
  patternId: "interceptors",
  state: "absent",
  scope: inspected,
  locations: [],
  negativeProof: {
    snapshotSha256,
    policy: "a".repeat(64),
    patternId: "interceptors",
    kind: "member-call",
    eligibility: "js-ts-pattern-files-v1",
    listingSha256: "b".repeat(64),
    files: [{ path: source.file, byteLength: 10, sha256: "c".repeat(64) }],
    sha256: "d".repeat(64),
  },
};
const observed: NativeIncompatibleCheck = {
  patternId: "interceptors",
  state: "observed",
  scope: { ...inspected, complete: false },
  locations: [source],
};
const matched: NativeMatchedApi = {
  packageName: "axios",
  binding: "axios",
  callTarget: "axios.get",
  api: "get",
  source,
  arguments: "inspected",
  options: "inspected",
  resolution: "direct",
};
const semantics: NativeSemanticCheck = {
  difference: AXIOS_FETCH_RULE.semanticDifferences[0]!,
  use: source,
  state: "inspected",
  inspectedSource: [source],
};
const evidence: NativeEligibilityEvidence = {
  version: 1,
  ruleId: AXIOS_FETCH_RULE.id,
  snapshotSha256,
  binding: "verified",
  policy: "a".repeat(64),
  declaration: { ...source, file: "package.json", line: 1 },
  referencesComplete: true,
  matchedApis: [matched],
  incompatibleChecks: [absent, observed],
  deploymentTargets: [
    {
      binding: "verified",
      target: "production",
      runtime: "node",
      minimumVersion: "22.0.0",
      declaration: { ...source, file: "package.json", line: 1 },
      declarationText: '"node": ">=22"',
      authority: "deployment",
    },
  ],
  semanticChecks: [semantics],
};

// These type fixtures are compiled by the core test and typecheck builds.
// eslint-disable-next-line no-constant-condition
if (false) {
  // @ts-expect-error observed evidence requires a non-empty location tuple
  const observedWithoutLocation: NativeIncompatibleCheck = {
    patternId: "interceptors",
    state: "observed",
    scope: inspected,
    locations: [],
  };
  // @ts-expect-error absence requires scope.complete true
  const absentWithoutCompleteScope: NativeIncompatibleCheck = {
    patternId: "interceptors",
    state: "absent",
    scope: { ...inspected, complete: false as const },
    locations: [],
    negativeProof: {
      snapshotSha256,
      policy: "a".repeat(64),
      patternId: "interceptors",
      kind: "member-call",
      eligibility: "js-ts-pattern-files-v1",
      listingSha256: "b".repeat(64),
      files: [{ path: source.file, byteLength: 10, sha256: "c".repeat(64) }],
      sha256: "d".repeat(64),
    },
  };
  // @ts-expect-error absence requires a bounded snapshot-bound negative proof
  const absentWithoutProof: NativeIncompatibleCheck = {
    patternId: "interceptors",
    state: "absent",
    scope: inspected,
    locations: [],
  };
  void observedWithoutLocation;
  void absentWithoutCompleteScope;
  void absentWithoutProof;
}

it("carries bounded negative-check proof and matched/semantic source identity", () => {
  assert.deepEqual(absent.scope, inspected);
  assert.equal(absent.negativeProof.snapshotSha256, snapshotSha256);
  assert.equal(absent.negativeProof.files[0]?.path, source.file);
  assert.equal(evidence.snapshotSha256, matched.source.snapshotSha256);
  assert.equal(matched.callTarget, "axios.get");
  assert.equal(matched.arguments, "inspected");
  assert.equal(matched.options, "inspected");
  assert.equal(semantics.use.snapshotSha256, snapshotSha256);
  assert.equal(semantics.inspectedSource[0]?.file, source.file);
  assert.equal((evidence.incompatibleChecks[1] as typeof observed).locations.length, 1);
});
