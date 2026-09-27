import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FsRepositoryHandle, type Dependency, type RepositoryHandle } from "@ghostdeps/core";
import { evaluateNativeProduction } from "./evaluate-production.js";

const dependency: Dependency = {
  name: "axios",
  constraint: "^1.0.0",
  kind: "runtime",
  declaredIn: "package.json",
  project: { path: ".", ecosystem: "javascript-typescript", packageManagers: [] },
};
const ordinary =
  'import axios from "axios";\nasync function f() { const res = await axios.get("/x"); if (res.status === 200) return res.data; }\n';
const targets = (minVersion = "22.0.0") =>
  JSON.stringify({
    schemaVersion: 1,
    complete: true,
    targets: [{ id: "production", runtime: "node", minVersion }],
  });
async function fixture(
  source: Record<string, string>,
  run: (repository: RepositoryHandle) => Promise<void>,
  minVersion = "22.0.0",
) {
  const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-native-production-"));
  try {
    const files = {
      "package.json": '{"dependencies":{"axios":"^1.0.0"}}',
      "ghostdeps.targets.json": targets(minVersion),
      ...source,
    };
    for (const [name, value] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), value);
    }
    await run(await FsRepositoryHandle.open(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const evaluate = (repo: RepositoryHandle) => evaluateNativeProduction(repo, [dependency]);
const blocked = async (repo: RepositoryHandle, pillar: string, reason?: string) => {
  const result = await evaluate(repo);
  assert.deepEqual(result.findings, []);
  assert.equal(result.evaluations[0]?.status, "blocked", JSON.stringify(result.evaluations));
  const item = result.evaluations[0];
  if (item?.status === "blocked") {
    assert.equal(item.pillar, pillar);
    if (reason) assert.equal(item.reason, reason);
  }
};

describe("native production end to end (#462)", () => {
  it("produces a source-bound ordinary Axios finding with locations and excluded pattern evidence", async () => {
    await fixture({ "src/a.ts": ordinary }, async (repo) => {
      const result = await evaluate(repo);
      assert.equal(result.evaluations[0]?.status, "produced", JSON.stringify(result.evaluations));
      assert.equal(result.findings[0]?.kind, "potentially-unnecessary");
      assert.ok(
        result.findings[0]?.evidence.some(
          (e) => e.kind === "native-api-matched" && e.file === "src/a.ts" && e.line === 2,
        ),
      );
      assert.ok(
        result.findings[0]?.evidence.some(
          (e) =>
            e.kind === "native-incompatibility-excluded" && e.statement.includes("timeout absent"),
        ),
      );
    });
  });
  it("does not infer a finding from an import with no call", async () => {
    await fixture({ "src/a.ts": 'import axios from "axios"; void axios;\n' }, async (repo) => {
      const result = await evaluate(repo);
      assert.deepEqual(result.findings, []);
      assert.equal(result.evaluations[0]?.status, "no-verdict");
    });
  });
  it("blocks a cited incompatible option", async () => {
    await fixture(
      { "src/a.ts": ordinary.replace('axios.get("/x")', 'axios.get("/x", { timeout: 100 })') },
      async (repo) => blocked(repo, "incompatible", "observed"),
    );
  });
  it("blocks a dynamically unchecked incompatible option", async () => {
    await fixture(
      { "src/a.ts": ordinary.replace('axios.get("/x")', 'axios.get("/x", { ...options })') },
      async (repo) => blocked(repo, "matched"),
    );
  });
  it("blocks an unchecked incompatible syntax even when the ordinary call is cited", async () => {
    await fixture(
      {
        "src/a.ts": ordinary,
        "src/config.ts": "const config = { ...settings }; void config;",
      },
      async (repo) => blocked(repo, "incompatible", "incomplete-scope"),
    );
  });
  it("blocks a below-floor deployment target", async () => {
    await fixture(
      { "src/a.ts": ordinary },
      async (repo) => blocked(repo, "deployment", "below-floor"),
      "18.0.0",
    );
  });
  it("accounts for barrel, local alias and simple wrapper chains as verified positives (#473)", async () => {
    await fixture(
      {
        "src/barrel.ts": 'export { get } from "axios";',
        "src/a.ts":
          'import {get} from "./barrel"; async function f(){ const res=await get("/x"); if(res.status) return res.data; }',
      },
      async (repo) => {
        const result = await evaluate(repo);
        assert.equal(result.evaluations[0]?.status, "produced", JSON.stringify(result.evaluations));
      },
    );
    // #462 fail-closed fixtures flipped to positive: the exact
    // statically-resolvable forms now carry full evidence end to end.
    await fixture(
      {
        "src/a.ts":
          'import axios from "axios"; const client=axios; async function f(){ const res=await client.get("/x"); if(res.status) return res.data; }',
      },
      async (repo) => {
        const result = await evaluate(repo);
        assert.equal(result.evaluations[0]?.status, "produced", JSON.stringify(result.evaluations));
        assert.ok(
          result.findings[0]?.evidence.some(
            (e) => e.kind === "native-api-matched" && e.file === "src/a.ts",
          ),
        );
      },
    );
    await fixture(
      {
        "src/a.ts":
          'import axios from "axios"; function client(url:string){ return axios.get(url); } async function f(){ const res=await client("/x"); if(res.status) return res.data; }',
      },
      async (repo) => {
        const result = await evaluate(repo);
        assert.equal(result.evaluations[0]?.status, "produced", JSON.stringify(result.evaluations));
        assert.ok(
          result.findings[0]?.evidence.some(
            (e) => e.kind === "native-api-matched" && e.file === "src/a.ts",
          ),
        );
      },
    );
  });
  it("keeps non-exact alias and wrapper forms fail-closed (#473)", async () => {
    // Mutated alias: a member write defeats binding provenance.
    await fixture(
      {
        "src/a.ts":
          'import axios from "axios"; const client=axios; client.get = (url:string) => url; async function f(){ const res=await client.get("/x"); if(res.status) return res.data; }',
      },
      async (repo) => blocked(repo, "matched", "unresolved-reference"),
    );
    // Opaque wrapper: the parameter mapping cannot be inspected.
    await fixture(
      {
        "src/a.ts":
          'import axios from "axios"; function client(url:string){ return axios.get(`${url}/x`); } async function f(){ const res=await client("/x"); if(res.status) return res.data; }',
      },
      async (repo) => blocked(repo, "matched", "uninspected-use"),
    );
  });
  it("blocks broken package-entry lineage", async () => {
    await fixture(
      {
        "src/a.ts":
          'const axios = unknown;\nasync function f() { const res = await axios.get("/x"); if (res.status === 200) return res.data; }\n',
      },
      async (repo) => {
        const result = await evaluate(repo);
        assert.deepEqual(result.findings, []);
        assert.notEqual(result.evaluations[0]?.status, "produced");
      },
    );
  });
  it("blocks a snapshot that changes after minting", async () => {
    await fixture({ "src/a.ts": ordinary }, async (repo) => {
      const read = repo.readFileBytes!.bind(repo);
      let calls = 0;
      const changed: RepositoryHandle = {
        ...repo,
        listFiles: repo.listFiles.bind(repo),
        readFile: repo.readFile.bind(repo),
        exists: repo.exists.bind(repo),
        listEntries: repo.listEntries!.bind(repo),
        readFileBytes: async (file, expected) => {
          if (file === "src/a.ts" && ++calls > 1) return Buffer.from(ordinary + "// changed\n");
          return read(file, expected);
        },
      };
      await blocked(changed, "snapshot");
    });
  });
});
