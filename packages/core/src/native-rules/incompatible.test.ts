import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FsRepositoryHandle } from "../engine/scanner/handle.js";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
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
const rule: NativeRule = { ...AXIOS_FETCH_RULE, incompatibleUses: ["timeout"] };
const inspected = (change: Partial<NativePatternInspection> = {}): NativePatternInspection => ({
  patternId: "timeout",
  kind: "option-key-value",
  inspectedFiles: ["src/a.ts", "src/b.ts"],
  inspectedBytes: Object.values(files).reduce((n, v) => n + Buffer.byteLength(v), 0),
  capped: false,
  observations: [],
  uninspectable: [],
  state: "not-observed",
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
    const result = await run([inspected()]);
    assert.equal(result.status, "pass");
    assert.equal(result.binding, "verified");
    assert.equal(result.lineageVerification, "adapter-asserted");
    const check = result.checks[0]!;
    assert.equal(check.state, "absent");
    if (check.state !== "absent") return;
    assert.equal(check.scope.complete, true);
    assert.deepEqual(
      check.negativeProof.files.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.match(check.negativeProof.sha256, /^[a-f0-9]{64}$/);
    assert.equal(check.negativeProof.policy, policy);
    assert.equal((await run([inspected()])).checks[0]?.state, "absent");
  });
  it("observed blocks with every verified location, including repeats", async () => {
    const first = cited(),
      second = { ...first };
    const result = await run([inspected({ state: "observed", observations: [first, second] })]);
    assert.equal(result.status, "blocked");
    assert.equal(result.checks[0]?.state, "observed");
    if (result.checks[0]?.state === "observed") assert.equal(result.checks[0].locations.length, 2);
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
    const empty = await run([inspected({ inspectedFiles: [], inspectedBytes: 0 })], {
      "README.md": "hello",
    });
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
      assert.equal(result.status, "pass");
    } finally {
      await rm(root, { recursive: true, force: true });
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
