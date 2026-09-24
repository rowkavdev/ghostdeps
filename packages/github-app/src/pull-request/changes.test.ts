import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pullRequestContext, type PullRequestClient } from "./changes.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PR = { owner: "octo", repo: "demo", baseSha: BASE, headSha: HEAD };

const DIFF = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -2,5 +2,6 @@
   "name": "demo",
   "dependencies": {
-    "left-pad": "^1.0.0"
+    "left-pad": "^1.3.0",
+    "axios": "^1.7.0"
   }
 }
diff --git a/src/http.ts b/src/http.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/http.ts
@@ -0,0 +1,2 @@
+import axios from "axios";
+export const get = (u: string) => axios.get(u);
`;

const manifest = (deps: Record<string, string>): string =>
  JSON.stringify({ name: "demo", dependencies: deps }, null, 2);

function fakeClient(options: {
  diff?: string | { status: number };
  files?: Record<string, string | { status: number }>;
}): PullRequestClient & { reads: string[] } {
  const reads: string[] = [];
  const request = async (route: string, params: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
      assert.deepEqual(params.mediaType, { format: "diff" });
      assert.equal(params.basehead, `${BASE}...${HEAD}`);
      const diff = options.diff ?? DIFF;
      if (typeof diff !== "string") throw Object.assign(new Error("http"), diff);
      return { data: diff };
    }
    const key = `${String(params.ref)}:${String(params.path)}`;
    reads.push(key);
    const file = options.files?.[key];
    if (file === undefined) throw Object.assign(new Error("not found"), { status: 404 });
    if (typeof file !== "string") throw Object.assign(new Error("http"), file);
    return { data: file };
  };
  return { request: request as PullRequestClient["request"], reads };
}

describe("pullRequestContext", () => {
  it("reports added and changed dependencies with the source lines that use them", async () => {
    const client = fakeClient({
      files: {
        [`${BASE}:package.json`]: manifest({ "left-pad": "^1.0.0" }),
        [`${HEAD}:package.json`]: manifest({ "left-pad": "^1.3.0", axios: "^1.7.0" }),
      },
    });
    const ctx = await pullRequestContext(client, PR);
    const result = ctx.dependencyChanges;
    assert.deepEqual(client.reads.sort(), [`${BASE}:package.json`, `${HEAD}:package.json`]);
    const byName = Object.fromEntries(result.changes.map((c) => [c.name, c]));
    assert.equal(byName.axios?.change, "added");
    assert.equal(byName.axios?.usageCheck, "pending");
    assert.equal(byName["left-pad"]?.change, "changed");
    assert.equal(byName["left-pad"]?.before?.constraint, "^1.0.0");
    assert.equal(byName["left-pad"]?.after?.constraint, "^1.3.0");
    assert.deepEqual(result.manifestsChanged, ["package.json"]);
    assert.equal(result.changedSourceFiles[0]?.path, "src/http.ts");
    assert.deepEqual(result.limitations, []);
    assert.equal(ctx.complete, true);
    assert.deepEqual([...(ctx.added.get("src/http.ts") ?? [])], [1, 2]);
    assert.ok(ctx.added.get("package.json")?.size);
  });

  it("treats a malformed manifest as unknown, not as zero dependencies", async () => {
    const client = fakeClient({
      files: {
        [`${BASE}:package.json`]: "{ not json",
        [`${HEAD}:package.json`]: manifest({ "left-pad": "^1.3.0", axios: "^1.7.0" }),
      },
    });
    const ctx = await pullRequestContext(client, PR);
    const result = ctx.dependencyChanges;
    assert.deepEqual(result.changes, []);
    assert.match(result.limitations.join("\n"), /package\.json \(base\)/);
    assert.equal(ctx.complete, false);
  });

  it("treats an unreadable manifest as unknown", async () => {
    const client = fakeClient({
      files: { [`${HEAD}:package.json`]: { status: 500 } },
    });
    const ctx = await pullRequestContext(client, PR);
    const result = ctx.dependencyChanges;
    assert.deepEqual(result.changes, []);
    assert.equal(result.limitations.length, 1);
  });

  it("does not read manifests other ecosystems own", async () => {
    const diff = `diff --git a/requirements.txt b/requirements.txt
index 1111111..2222222 100644
--- a/requirements.txt
+++ b/requirements.txt
@@ -1 +1,2 @@
 requests==2.32.0
+flask==3.0.0
`;
    const client = fakeClient({ diff });
    const ctx = await pullRequestContext(client, PR);
    const result = ctx.dependencyChanges;
    assert.deepEqual(client.reads, []);
    assert.deepEqual(result.changes, []);
  });

  it("says so when GitHub refuses a diff that is too large", async () => {
    const ctx = await pullRequestContext(fakeClient({ diff: { status: 406 } }), PR);
    const result = ctx.dependencyChanges;
    assert.deepEqual(result.changes, []);
    assert.match(result.limitations[0] ?? "", /too large/);
  });

  it("says so when the diff cannot be fetched", async () => {
    const ctx = await pullRequestContext(fakeClient({ diff: { status: 502 } }), PR);
    const result = ctx.dependencyChanges;
    assert.match(result.limitations[0] ?? "", /could not be fetched/);
  });

  it("does not read manifests above the size ceiling", async () => {
    const client = fakeClient({
      files: {
        [`${BASE}:package.json`]: manifest({ "left-pad": "^1.0.0" }),
        [`${HEAD}:package.json`]: " ".repeat(1_000_001),
      },
    });
    const ctx = await pullRequestContext(client, PR);
    const result = ctx.dependencyChanges;
    assert.deepEqual(result.changes, []);
    assert.match(result.limitations.join("\n"), /package\.json \(head\)/);
  });
});
