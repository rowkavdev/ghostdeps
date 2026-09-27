import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FsRepositoryHandle } from "../engine/scanner/handle.js";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import { UUID_RANDOMUUID_RULE } from "./uuid-randomuuid.js";
import { CLONEDEEP_STRUCTUREDCLONE_RULE } from "./clonedeep-structuredclone.js";
import type { NativeRule } from "./index.js";
import { collectNativeIncompatibleEvidence, type NativePatternInspection } from "./incompatible.js";
import { mintNativeSnapshot } from "./snapshot.js";
const policy = "a".repeat(64);
const files = {
  "src/a.ts": 'import axios from "axios";\naxios.get("/x", {timeout: 1000});\n',
  "src/b.ts": 'axios.get("/y");\n',
};
const repo = (content: Record<string, string> = files): RepositoryHandle => {
  const entries: RepositoryTreeEntry[] = Object.keys(content).map((file) => ({
    path: file,
    kind: "file",
  }));
  return {
    listEntries: async () => ({ entries, complete: true, limitations: [], policy }),
    readFileBytes: async (file) => Buffer.from(content[file]!),
    listFiles: async () => Object.keys(content),
    readFile: async (file) => content[file]!,
    exists: async (file) => file in content,
  };
};
const rule: NativeRule = {
  ...AXIOS_FETCH_RULE,
  incompatibleUses: ["timeout"],
  incompatiblePatternKinds: { timeout: "option-key-value" },
};
const whereLooked = (content: Record<string, string> = files) => ({
  eligibility: "js-ts-pattern-files-v1" as const,
  files: Object.keys(content)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((file) => ({
      path: file,
      byteLength: Buffer.byteLength(content[file]!),
      sha256: createHash("sha256").update(content[file]!).digest("hex"),
    })),
  calls: Object.entries(content)
    .filter(([f]) => f.endsWith(".ts"))
    .flatMap(([file, value]) => {
      const marker =
        file === "src/a.ts"
          ? value.includes("timeout: 1000")
            ? 'axios.get("/x", {timeout: 1000})'
            : 'axios.get("/x")'
          : 'axios.get("/y")';
      const start = Buffer.from(value).indexOf(marker);
      return start < 0 ? [] : [{ file, start, end: start + Buffer.byteLength(marker) }];
    }),
  unchecked: [],
});
const inspected = (change: Partial<NativePatternInspection> = {}): NativePatternInspection => ({
  patternId: "timeout",
  kind: "option-key-value",
  inspectedFiles: ["src/a.ts", "src/b.ts"],
  inspectedBytes: Object.values(files).reduce((n, v) => n + Buffer.byteLength(v), 0),
  capped: false,
  uninspectable: [],
  state: "observed",
  observations: [cited()],
  whereLooked: whereLooked(),
  ...change,
});
const cited = () => {
  const start = Buffer.from(files["src/a.ts"]).indexOf("timeout: 1000");
  return { file: "src/a.ts", start, end: start + Buffer.byteLength("timeout: 1000") };
};
async function run(records: NativePatternInspection[], content: Record<string, string> = files) {
  const repository = repo(content),
    binding = await mintNativeSnapshot(repository);
  assert.equal(binding.status, "verified");
  return collectNativeIncompatibleEvidence(repository, rule, binding.snapshotSha256, records);
}
describe("native incompatible evidence (#446)", () => {
  it("absent requires complete enumerated scope and a deterministic aggregate proof", async () => {
    const clean = {
      "src/a.ts": 'import axios from "axios";\naxios.get("/x");\n',
      "src/b.ts": files["src/b.ts"],
    };
    const record = inspected({
      state: "not-observed",
      observations: [],
      inspectedBytes: Object.values(clean).reduce((n, v) => n + Buffer.byteLength(v), 0),
      whereLooked: whereLooked(clean),
    });
    const result = await run([record], clean);
    assert.equal(result.status, "pass");
    assert.equal(result.binding, "verified");
    assert.equal(result.lineageVerification, "core-reconstructed");
    const check = result.checks[0]!;
    assert.equal(check.state, "absent");
    if (check.state !== "absent") return;
    assert.equal(check.scope.complete, true);
    assert.equal(check.scope.calls.length, 2);
    assert.deepEqual(
      check.negativeProof.files.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.match(check.negativeProof.sha256, /^[a-f0-9]{64}$/);
    assert.equal(check.negativeProof.policy, policy);
    assert.equal((await run([record], clean)).checks[0]?.state, "absent");
  });
  it("rejects adapter kind substitution even with a complete byte-perfect scope", async () => {
    const result = await run([inspected({ kind: "property-chain" })]);
    assert.equal(result.status, "blocked");
    assert.equal(result.checks[0]?.state, "unchecked");
    assert.equal(result.blocking[0]?.reason, "missing-inspection");
    const repository = repo();
    const binding = await mintNativeSnapshot(repository);
    assert.equal(binding.status, "verified");
    const { incompatiblePatternKinds: _unused, ...withoutMapping } = rule;
    void _unused;
    const noMapping = await collectNativeIncompatibleEvidence(
      repository,
      withoutMapping,
      binding.snapshotSha256,
      [inspected()],
    );
    assert.equal(noMapping.status, "blocked");
    assert.equal(noMapping.checks[0]?.state, "unchecked");
  });
  it("observed blocks with every verified location, including repeats", async () => {
    const first = cited();
    const result = await run([inspected({ state: "observed", observations: [first] })]);
    assert.equal(result.status, "blocked");
    assert.equal(result.checks[0]?.state, "observed");
    if (result.checks[0]?.state === "observed") assert.equal(result.checks[0].locations.length, 1);
  });
  it("uninspectable, unchecked, caps and incomplete file lists cannot be absent", async () => {
    for (const record of [
      inspected({ state: "uninspectable", uninspectable: [{ ...cited(), note: "computed" }] }),
      inspected({ capped: true }),
      inspected({ inspectedFiles: ["src/a.ts"] }),
      inspected({ inspectedBytes: 0 }),
      inspected({ observations: [], state: "observed" }),
    ]) {
      const result = await run([record]);
      assert.equal(result.status, "blocked");
      assert.equal(result.checks[0]?.state, "unchecked");
    }
    const missing = await run([]);
    assert.equal(missing.status, "blocked");
    assert.equal(missing.checks[0]?.state, "unchecked");
    const giant = { "src/a.ts": "x".repeat(1_000_001), "src/b.ts": files["src/b.ts"] };
    const cap = await run(
      [
        inspected({
          inspectedBytes:
            Buffer.byteLength(giant["src/a.ts"]) + Buffer.byteLength(giant["src/b.ts"]),
        }),
      ],
      giant,
    );
    assert.equal(cap.status, "blocked");
    assert.equal(cap.checks[0]?.state, "unchecked");
  });
  it("rejects forged or out-of-bounds cited observations", async () => {
    for (const observation of [
      { ...cited(), end: 10000 },
      { ...cited(), file: "other.ts" },
      { ...cited(), start: 0, end: 5 },
    ]) {
      const result = await run([inspected({ state: "observed", observations: [observation] })]);
      assert.equal(result.status, "blocked");
      assert.equal(result.checks[0]?.state, "unchecked");
    }
  });
  it("binds empty eligible scope to the listing and handles a real scanner repository", async () => {
    const empty = await run(
      [
        inspected({
          inspectedFiles: [],
          inspectedBytes: 0,
          state: "not-observed",
          observations: [],
          whereLooked: whereLooked({ "README.md": "hello" }),
        }),
      ],
      { "README.md": "hello" },
    );
    assert.equal(empty.status, "pass");
    if (empty.checks[0]?.state === "absent")
      assert.deepEqual(empty.checks[0].negativeProof.files, []);
    const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-incompat-"));
    try {
      await mkdir(path.join(root, "src"));
      for (const [file, value] of Object.entries(files))
        await writeFile(path.join(root, file), value);
      const repository = await FsRepositoryHandle.open(root),
        binding = await mintNativeSnapshot(repository);
      assert.equal(binding.status, "verified");
      const result = await collectNativeIncompatibleEvidence(
        repository,
        rule,
        binding.snapshotSha256,
        [inspected()],
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.checks[0]?.state, "observed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("re-enumerates calls and occurrences, not just matching the asserted file digests", async () => {
    const clean = { "src/a.ts": 'axios.get("/x");\n', "src/b.ts": 'axios.get("/y");\n' };
    const base = inspected({
      state: "not-observed",
      observations: [],
      inspectedFiles: ["src/a.ts", "src/b.ts"],
      inspectedBytes: Object.values(clean).reduce((n, v) => n + Buffer.byteLength(v), 0),
      whereLooked: whereLooked(clean),
    });
    assert.equal((await run([base], clean)).lineageVerification, "core-reconstructed");
    const omittedCall = { ...base, whereLooked: { ...base.whereLooked!, calls: [] } };
    const wrongDigest = {
      ...base,
      whereLooked: {
        ...base.whereLooked!,
        files: [
          { ...base.whereLooked!.files[0]!, sha256: "0".repeat(64) },
          base.whereLooked!.files[1]!,
        ],
      },
    };
    const { whereLooked: _missing, ...withoutLooked } = base;
    void _missing;
    for (const record of [omittedCall, wrongDigest, withoutLooked]) {
      const result = await run([record], clean);
      assert.equal(result.status, "blocked");
      assert.equal(result.lineageVerification, "adapter-asserted");
      assert.equal(result.blocking[0]?.reason, "incomplete-scope");
    }
    const hidden = { ...clean, "src/b.ts": 'axios.get("/y", {timeout: 3});\n' };
    const hiddenRecord = {
      ...base,
      inspectedBytes: Object.values(hidden).reduce((n, v) => n + Buffer.byteLength(v), 0),
      whereLooked: whereLooked(hidden),
    };
    const hiddenResult = await run([hiddenRecord], hidden);
    assert.equal(hiddenResult.status, "blocked");
    assert.equal(hiddenResult.checks[0]?.state, "unchecked");
    assert.equal(hiddenResult.lineageVerification, "adapter-asserted");
    const malformed = { ...clean, "src/b.ts": 'axios.get("/y";\n' };
    const malformedRecord = {
      ...base,
      inspectedBytes: Object.values(malformed).reduce((n, v) => n + Buffer.byteLength(v), 0),
      whereLooked: whereLooked(malformed),
    };
    assert.equal((await run([malformedRecord], malformed)).status, "blocked");
    const method = {
      ...clean,
      "src/a.ts": 'const options = {timeout() { return 1000; }}; axios.get("/x", options);\n',
    };
    const methodRecord = {
      ...base,
      inspectedBytes: Object.values(method).reduce((n, v) => n + Buffer.byteLength(v), 0),
      whereLooked: whereLooked(method),
    };
    const methodResult = await run([methodRecord], method);
    assert.equal(methodResult.status, "blocked");
    assert.equal(methodResult.checks[0]?.state, "unchecked");
    assert.equal(methodResult.lineageVerification, "adapter-asserted");
    assert.equal(methodResult.blocking[0]?.reason, "incomplete-scope");
  });
  it("keeps unsupported seed-rule concepts unchecked while checking literal syntax", async () => {
    for (const seed of [AXIOS_FETCH_RULE, UUID_RANDOMUUID_RULE, CLONEDEEP_STRUCTUREDCLONE_RULE]) {
      assert.ok(seed.incompatiblePatternKinds);
      assert.ok(Object.keys(seed.incompatiblePatternKinds).length > 0);
      assert.ok(
        Object.keys(seed.incompatiblePatternKinds).every((p) => seed.incompatibleUses.includes(p)),
      );
    }
    assert.equal(AXIOS_FETCH_RULE.incompatiblePatternKinds?.timeout, "option-key-value");
    assert.equal(UUID_RANDOMUUID_RULE.incompatiblePatternKinds?.parse, "member-call");
    assert.equal(
      CLONEDEEP_STRUCTUREDCLONE_RULE.incompatiblePatternKinds?.cloneDeepWith,
      "member-call",
    );
    for (const [seed, unsupported] of [
      [UUID_RANDOMUUID_RULE, "v4 options"],
      [CLONEDEEP_STRUCTUREDCLONE_RULE, "functions"],
    ] as const) {
      assert.equal(seed.incompatiblePatternKinds?.[unsupported], undefined);
      const empty = repo({ "README.md": "hello" });
      const binding = await mintNativeSnapshot(empty);
      assert.equal(binding.status, "verified");
      const result = await collectNativeIncompatibleEvidence(
        empty,
        seed,
        binding.snapshotSha256,
        [],
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.lineageVerification, "adapter-asserted");
      assert.ok(result.checks.some((c) => c.patternId === unsupported && c.state === "unchecked"));
    }
  });
  it("invalid snapshot remains caller-asserted, never seals", async () => {
    const result = await collectNativeIncompatibleEvidence(repo(), rule, "b".repeat(64), [
      inspected(),
    ]);
    assert.equal(result.status, "blocked");
    assert.equal(result.binding, "caller-asserted");
  });
});
