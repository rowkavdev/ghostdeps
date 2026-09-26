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
  deploymentTargets: [{ target: "production", runtime: "node" }],
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
    // Type fixtures describe states explicitly. Neither is a validated negative check.
    const scope = { snapshotSha256, files: [source.file], calls: [source], complete: false };
    const unchecked = {
      patternId: "interceptors",
      scope,
      state: "unchecked" as const,
      locations: [],
    };
    const observed = { ...unchecked, state: "observed" as const, locations: [source] };
    assert.notEqual(unchecked.state, "absent");
    assert.notEqual(observed.state, "absent");
    assert.equal((await produceNativeEvidence(base())).status, "blocked");
  });

  it("blocks unknown deployment target leads rather than treating Node CI as production", async () => {
    assert.equal(
      (
        await produceNativeEvidence({
          ...base(),
          deploymentTargets: [{ target: "edge", runtime: "unknown" }],
        })
      ).status,
      "blocked",
    );
  });
});
