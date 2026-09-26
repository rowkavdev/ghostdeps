import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsRepositoryHandle } from "../engine/scanner/handle.js";
import { describe, it } from "node:test";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import type { NativeRule } from "./index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import { collectNativeMatchedApiEvidence, type NativeReferenceRecord } from "./matched-api.js";
import { mintNativeSnapshot } from "./snapshot.js";

const policy = "b".repeat(64);
const files: Record<string, string> = {
  "src/app.ts": 'import axios from "axios";\nconst a = axios;\na.get("/x");\n',
  "src/zero.ts": 'import { get } from "axios";\nget();\n',
  "src/members.ts":
    'import axios from "axios";\na.post("/x");\na.get("/x");\naxios.interceptors.request.use();\n',
  "src/target.ts": 'import { get } from "axios";\ntarget("get");\n',
  "src/barrel.ts": 'export { get } from "axios";\n',
  "package.json": '{"scripts":{"test":"axios --version"}}',
  ".appconfig.json": '{"axios":true}',
};
const repo = (content = files): RepositoryHandle => {
  const entries: RepositoryTreeEntry[] = Object.keys(content).map((path) => ({
    path,
    kind: "file",
  }));
  return {
    listEntries: async () => ({ entries, complete: true, limitations: [], policy }),
    readFileBytes: async (file) => Buffer.from(content[file]!),
    readFile: async (file) => content[file]!,
    listFiles: async () => Object.keys(content),
    exists: async (file) => file in content,
  };
};
const span = (file: string, needle: string) => {
  const start = Buffer.from(files[file]!).indexOf(Buffer.from(needle));
  assert.notEqual(start, -1);
  return { file, start, end: start + Buffer.byteLength(needle) };
};
const direct = (): NativeReferenceRecord => ({
  packageName: "axios",
  binding: "get",
  callTarget: "axios.get",
  api: "get",
  resolution: "direct",
  lineage: [
    { kind: "import", name: "axios", span: span("src/app.ts", 'import axios from "axios"') },
  ],
  arguments: "inspected",
  options: "inspected",
  span: span("src/app.ts", 'a.get("/x")'),
  argumentSpans: [span("src/app.ts", '"/x"')],
});
const script = (): NativeReferenceRecord => ({
  packageName: "axios",
  binding: "test",
  callTarget: "axios",
  api: "<script>",
  resolution: "script",
  lineage: [],
  arguments: "inspected",
  options: "inspected",
  span: span("package.json", '"axios --version"'),
});
const config = (): NativeReferenceRecord => ({
  ...script(),
  resolution: "config",
  api: "<config>",
  span: span(".appconfig.json", '"axios":true'),
});
const excluded: NativeRule = {
  ...AXIOS_FETCH_RULE,
  referenceSurface: {
    cli: "excluded",
    config: "covered",
    cliCitation: `${AXIOS_FETCH_RULE.id}: programmatic HTTP calls only; CLI excluded`,
  },
};
async function run(
  references: NativeReferenceRecord[],
  rule: NativeRule = AXIOS_FETCH_RULE,
  content = files,
  limitations: unknown[] = [],
) {
  const repository = repo(content);
  const binding = await mintNativeSnapshot(repository);
  assert.equal(binding.status, "verified");
  return collectNativeMatchedApiEvidence(repository, rule, binding.snapshotSha256, {
    packageName: "axios",
    references,
    limitations,
  });
}
describe("native matched-API pillar (#442)", () => {
  it("byte-rechecks direct, alias, and re-export call, lineage and argument citations", async () => {
    const alias: NativeReferenceRecord = {
      ...direct(),
      resolution: "alias",
      lineage: [
        ...direct().lineage,
        { kind: "alias", name: "a", span: span("src/app.ts", "const a = axios") },
      ],
    };
    const barrel: NativeReferenceRecord = {
      ...direct(),
      resolution: "re-export",
      lineage: [
        {
          kind: "re-export",
          name: "get",
          span: span("src/barrel.ts", 'export { get } from "axios"'),
        },
        ...direct().lineage,
      ],
    };
    const result = await run([direct(), alias, barrel]);
    assert.equal(result.status, "pass");
    assert.equal(result.binding, "verified");
    assert.equal(result.lineageVerification, "adapter-asserted");
    assert.equal(result.matchedApis.length, 3);
    assert.equal(result.matchedApis[2]?.lineage?.length, 2);
    assert.match(
      String((result.matchedApis[0]?.source.span as { sha256: string }).sha256),
      /^[a-f0-9]{64}$/,
    );
    assert.equal(result.matchedApis[0]?.argumentSources?.[0]?.line, 3);
  });
  it("blocks wrapper unknown, uninspected options, mixed unknown and scan limitations", async () => {
    const unknown: NativeReferenceRecord = {
      ...direct(),
      resolution: "indirect-unknown",
      note: "wrapper flow",
    };
    const result = await run([direct(), unknown, { ...direct(), options: "unknown" }]);
    assert.equal(result.status, "blocked");
    assert.equal(result.lineageVerification, "adapter-asserted");
    assert.equal(result.matchedApis.length, 1);
    assert.deepEqual(
      result.blocking.map((x) => x.reason),
      ["unresolved-reference", "uninspected-use"],
    );
    assert.equal(
      (await run([direct()], AXIOS_FETCH_RULE, files, [{ kind: "parse-error" }])).status,
      "blocked",
    );
  });
  it("blocks covered CLI and config, but accounts for explicitly excluded CLI with rule citation", async () => {
    assert.equal((await run([script()])).status, "blocked");
    assert.equal((await run([config()], excluded)).status, "blocked");
    const result = await run([direct(), script()], excluded);
    assert.equal(result.status, "pass");
    assert.equal(result.accounted[0]?.ruleId, AXIOS_FETCH_RULE.id);
    assert.equal(result.accounted[0]?.ruleCitation, excluded.referenceSurface?.cliCitation);
  });
  it("reads citations through the real scanner handle with expected file identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-matched-"));
    try {
      await mkdir(path.join(root, "src"));
      for (const [file, text] of Object.entries(files)) {
        await writeFile(path.join(root, file), text);
      }
      const repository = await FsRepositoryHandle.open(root);
      const binding = await mintNativeSnapshot(repository);
      assert.equal(binding.status, "verified");
      const result = await collectNativeMatchedApiEvidence(
        repository,
        AXIOS_FETCH_RULE,
        binding.snapshotSha256,
        { packageName: "axios", references: [direct()], limitations: [] },
      );
      assert.equal(result.status, "pass");
      assert.equal(result.matchedApis.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects two real-handle reviewer repros: import as call and missing argument citations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-repro-"));
    try {
      await mkdir(path.join(root, "src"));
      for (const [file, text] of Object.entries(files))
        await writeFile(path.join(root, file), text);
      const repository = await FsRepositoryHandle.open(root);
      const binding = await mintNativeSnapshot(repository);
      assert.equal(binding.status, "verified");
      const forged: NativeReferenceRecord[] = [
        { ...direct(), span: span("src/app.ts", 'import axios from "axios"'), argumentSpans: [] },
        { ...direct(), argumentSpans: [] },
      ];
      const result = await collectNativeMatchedApiEvidence(
        repository,
        AXIOS_FETCH_RULE,
        binding.snapshotSha256,
        { packageName: "axios", references: forged, limitations: [] },
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.matchedApis.length, 0);
      assert.deepEqual(
        result.blocking.map((b) => b.reason),
        ["citation-inconsistent", "citation-inconsistent"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("accepts true zero-arg calls; rejects overlaps, reordering and identifier only in argument", async () => {
    const zero: NativeReferenceRecord = {
      ...direct(),
      binding: "get",
      span: span("src/zero.ts", "get()"),
      argumentSpans: [],
      lineage: [
        { kind: "import", name: "get", span: span("src/zero.ts", 'import { get } from "axios"') },
      ],
    };
    assert.equal((await run([zero])).status, "pass");
    const twoText = 'a.get("/x", "get")';
    const twoFiles = { ...files, "src/app.ts": files["src/app.ts"]! + twoText };
    const call = {
      file: "src/app.ts",
      start: Buffer.byteLength(files["src/app.ts"]!),
      end: Buffer.byteLength(files["src/app.ts"]! + twoText),
    };
    const first = {
      file: call.file,
      start: call.start + Buffer.byteLength("a.get("),
      end: call.start + Buffer.byteLength('a.get("/x"'),
    };
    const second = {
      file: call.file,
      start: call.start + Buffer.byteLength('a.get("/x", '),
      end: call.end - 1,
    };
    const base: NativeReferenceRecord = { ...direct(), span: call, argumentSpans: [first, second] };
    assert.equal((await run([base], AXIOS_FETCH_RULE, twoFiles)).status, "pass");
    const wrong = [
      { ...base, argumentSpans: [first, { ...second, start: first.end - 1 }] },
      { ...base, argumentSpans: [second, first] },
      {
        ...zero,
        span: span("src/target.ts", 'target("get")'),
        argumentSpans: [span("src/target.ts", '"get"')],
      },
    ];
    for (const ref of wrong) {
      const result = await run([ref], AXIOS_FETCH_RULE, twoFiles);
      assert.equal(result.status, "blocked");
      assert.equal(result.blocking[0]?.reason, "citation-inconsistent");
    }
    const wordBoundary = {
      ...zero,
      span: span("src/target.ts", 'target("get")'),
      argumentSpans: [span("src/target.ts", '"get"')],
    };
    assert.equal((await run([wordBoundary])).blocking[0]?.reason, "citation-inconsistent");
  });
  it("requires the final member token to be the API, never a receiver or earlier member", async () => {
    const member = (text: string, api: string, argument: string | null): NativeReferenceRecord => ({
      ...direct(),
      api,
      callTarget: `axios.${api}`,
      binding: "a",
      span: span("src/members.ts", text),
      argumentSpans:
        argument === null
          ? []
          : [
              {
                ...span("src/members.ts", argument),
                start: Buffer.from(files["src/members.ts"]!).indexOf(
                  Buffer.from(argument),
                  Buffer.from(files["src/members.ts"]!).indexOf(Buffer.from(text)),
                ),
                end:
                  Buffer.from(files["src/members.ts"]!).indexOf(
                    Buffer.from(argument),
                    Buffer.from(files["src/members.ts"]!).indexOf(Buffer.from(text)),
                  ) + Buffer.byteLength(argument),
              },
            ],
    });
    const wrong = member('a.post("/x")', "get", '"/x"');
    const right = member('a.get("/x")', "get", '"/x"');
    const result = await run([wrong, right]);
    assert.equal(result.status, "blocked");
    assert.deepEqual(
      result.blocking.map((x) => x.reason),
      ["citation-inconsistent"],
    );
    assert.equal(result.matchedApis.length, 1);
    const chainRule: NativeRule = { ...AXIOS_FETCH_RULE, coveredApis: ["use", "get"] };
    const chain = member("axios.interceptors.request.use()", "use", null);
    assert.equal((await run([chain], chainRule)).status, "pass");
    const wrongChain = { ...chain, api: "get", callTarget: "axios.get" };
    assert.equal((await run([wrongChain], chainRule)).blocking[0]?.reason, "citation-inconsistent");
    assert.equal((await run([{ ...right, binding: "a.get" }])).status, "pass");
  });
  it("blocks false, missing, out-of-tree and changed byte citations", async () => {
    assert.equal(
      (await run([{ ...direct(), argumentSpans: [{ ...span("src/app.ts", '"/x"'), end: 999 }] }]))
        .status,
      "blocked",
    );
    assert.equal(
      (await run([{ ...direct(), span: undefined } as unknown as NativeReferenceRecord])).status,
      "blocked",
    );
    assert.equal(
      (await run([{ ...direct(), span: { file: "outside.ts", start: 0, end: 4 } }])).status,
      "blocked",
    );
    const stale = repo();
    const binding = await mintNativeSnapshot(stale);
    assert.equal(binding.status, "verified");
    const result = await collectNativeMatchedApiEvidence(
      repo({ ...files, "src/app.ts": "changed" }),
      AXIOS_FETCH_RULE,
      binding.snapshotSha256,
      { packageName: "axios", references: [direct()], limitations: [] },
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.binding, "caller-asserted");
    assert.equal(result.matchedApis.length, 0);
  });
});
