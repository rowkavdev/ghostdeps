import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GITHUB_COMPARE_FILE_LIMIT,
  pullRequestContext,
  type PullRequestClient,
} from "./changes.js";

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

  it("treats a modified file with no hunks as a silently cut diff", async () => {
    const diff = `${DIFF}diff --git a/src/huge.ts b/src/huge.ts
index 5555555..6666666 100644
`;
    const client = fakeClient({
      diff,
      files: {
        [`${BASE}:package.json`]: manifest({ "left-pad": "^1.0.0" }),
        [`${HEAD}:package.json`]: manifest({ "left-pad": "^1.3.0", axios: "^1.7.0" }),
      },
    });
    const ctx = await pullRequestContext(client, PR);
    assert.equal(ctx.complete, false);
    assert.match(ctx.dependencyChanges.limitations.join("\n"), /may be incomplete/);
  });

  it("treats a diff at GitHub's file limit as possibly cut", async () => {
    let diff = "";
    for (let i = 0; i < GITHUB_COMPARE_FILE_LIMIT; i++) {
      diff += `diff --git a/src/f${i}.ts b/src/f${i}.ts
index 1111111..2222222 100644
--- a/src/f${i}.ts
+++ b/src/f${i}.ts
@@ -1 +1 @@
-a
+b
`;
    }
    const ctx = await pullRequestContext(fakeClient({ diff }), PR);
    assert.equal(ctx.complete, false);
    assert.match(ctx.dependencyChanges.limitations.join("\n"), /GitHub's limit/);
  });

  it("does not flag a pure rename as cut", async () => {
    const diff = `diff --git a/src/a.ts b/src/b.ts
similarity index 100%
rename from src/a.ts
rename to src/b.ts
`;
    const ctx = await pullRequestContext(fakeClient({ diff }), PR);
    assert.deepEqual(ctx.dependencyChanges.limitations, []);
    assert.equal(ctx.complete, true);
  });
});

const SCOPED_DIFF = `diff --git a/fixtures/demo/package.json b/fixtures/demo/package.json
index 1111111..2222222 100644
--- a/fixtures/demo/package.json
+++ b/fixtures/demo/package.json
@@ -2,5 +2,6 @@
   "name": "fixture",
   "dependencies": {
-    "left-pad": "^1.0.0"
+    "left-pad": "^1.3.0",
+    "axios": "^1.7.0"
   }
 }
diff --git a/fixtures/demo/source.ts b/fixtures/demo/source.ts
new file mode 100644
index 0000000..7777777 100644
--- /dev/null
+++ b/fixtures/demo/source.ts
@@ -0,0 +1,2 @@
+import axios from "axios";
+export const get = (u: string) => axios.get(u);
diff --git a/fixtures-old/package.json b/fixtures-old/package.json
index 3333333..4444444 100644
--- a/fixtures-old/package.json
+++ b/fixtures-old/package.json
@@ -2,5 +2,6 @@
   "name": "legacy",
   "dependencies": {
-    "debug": "^4.0.0"
+    "debug": "^4.3.0",
+    "axios": "^1.7.0"
   }
 }
diff --git a/package.json b/package.json
index 5555555..6666666 100644
--- a/package.json
+++ b/package.json
@@ -2,5 +2,6 @@
   "name": "demo",
   "dependencies": {
-    "chalk": "^4.0.0"
+    "chalk": "^4.1.2",
+    "axios": "^1.7.0"
   }
 }
diff --git a/src/http.ts b/src/http.ts
new file mode 100644
index 0000000..3333333 100644
--- /dev/null
+++ b/src/http.ts
@@ -0,0 +1,2 @@
+import axios from "axios";
+export const get = (u: string) => axios.get(u);
`;

const scopedFiles = {
  [`${BASE}:fixtures/demo/package.json`]: manifest({ "left-pad": "^1.0.0" }),
  [`${HEAD}:fixtures/demo/package.json`]: manifest({ "left-pad": "^1.3.0", axios: "^1.7.0" }),
  [`${BASE}:fixtures-old/package.json`]: manifest({ debug: "^4.0.0" }),
  [`${HEAD}:fixtures-old/package.json`]: manifest({ debug: "^4.3.0", axios: "^1.7.0" }),
  [`${BASE}:package.json`]: manifest({ chalk: "^4.0.0" }),
  [`${HEAD}:package.json`]: manifest({ chalk: "^4.1.2", axios: "^1.7.0" }),
};

describe("pullRequestContext fixture scope (#354)", () => {
  it("drops changes under excluded roots and discloses them by count", async () => {
    const client = fakeClient({ diff: SCOPED_DIFF, files: scopedFiles });
    const ctx = await pullRequestContext(client, PR, ["fixtures"]);
    assert.equal(ctx.complete, true);
    assert.deepEqual(ctx.dependencyChanges.manifestsChanged.sort(), [
      "fixtures-old/package.json",
      "package.json",
    ]);
    assert.deepEqual([...new Set(ctx.dependencyChanges.changes.map((c) => c.manifest))].sort(), [
      "fixtures-old/package.json",
      "package.json",
    ]);
    assert.deepEqual(
      ctx.dependencyChanges.changedSourceFiles.map((f) => f.path),
      ["src/http.ts"],
    );
    assert.deepEqual(
      ctx.dependencyChanges.sourceLineChanges.map((f) => f.path),
      ["src/http.ts"],
    );
    assert.deepEqual(ctx.excludedChanged, {
      count: 2,
      examples: ["fixtures/demo/package.json", "fixtures/demo/source.ts"],
    });
  });

  it("matches roots on component boundaries only", async () => {
    const client = fakeClient({ diff: SCOPED_DIFF, files: scopedFiles });
    const ctx = await pullRequestContext(client, PR, ["fixtures", "fixtures-old"]);
    assert.deepEqual(ctx.dependencyChanges.manifestsChanged, ["package.json"]);
    assert.deepEqual(ctx.excludedChanged, {
      count: 3,
      examples: [
        "fixtures-old/package.json",
        "fixtures/demo/package.json",
        "fixtures/demo/source.ts",
      ],
    });
  });

  it("scopes nothing and counts nothing without roots", async () => {
    const client = fakeClient({ diff: SCOPED_DIFF, files: scopedFiles });
    const ctx = await pullRequestContext(client, PR, []);
    assert.equal(ctx.dependencyChanges.manifestsChanged.length, 3);
    assert.deepEqual(ctx.excludedChanged, { count: 0, examples: [] });
  });

  it("counts nothing when the diff is unavailable", async () => {
    const ctx = await pullRequestContext(fakeClient({ diff: { status: 406 } }), PR, ["fixtures"]);
    assert.equal(ctx.complete, false);
    assert.deepEqual(ctx.excludedChanged, { count: 0, examples: [] });
  });

  it("filters lockfile and lockfile-gap records under excluded roots (#354)", async () => {
    const diff = `diff --git a/fixtures/demo/package.json b/fixtures/demo/package.json
index 1111111..2222222 100644
--- a/fixtures/demo/package.json
+++ b/fixtures/demo/package.json
@@ -1 +1 @@
-{"name":"fixture","dependencies":{"left-pad":"^1.0.0"}}
+{"name":"fixture","dependencies":{"left-pad":"^1.3.0"}}
diff --git a/fixtures/demo/package-lock.json b/fixtures/demo/package-lock.json
index 3333333..4444444 100644
--- a/fixtures/demo/package-lock.json
+++ b/fixtures/demo/package-lock.json
@@ -1 +1 @@
-{"lockfileVersion":3}
+{"lockfileVersion":3,"extra":1}
diff --git a/package.json b/package.json
index 5555555..6666666 100644
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"name":"demo","dependencies":{"chalk":"^4.0.0"}}
+{"name":"demo","dependencies":{"chalk":"^4.1.2"}}
`;
    const client = fakeClient({
      diff,
      files: {
        [`${BASE}:fixtures/demo/package.json`]: manifest({ "left-pad": "^1.0.0" }),
        [`${HEAD}:fixtures/demo/package.json`]: manifest({ "left-pad": "^1.3.0" }),
        [`${BASE}:package.json`]: manifest({ chalk: "^4.0.0" }),
        [`${HEAD}:package.json`]: manifest({ chalk: "^4.1.2" }),
      },
    });
    const ctx = await pullRequestContext(client, PR, ["fixtures"]);
    assert.equal(ctx.complete, true);
    assert.deepEqual(ctx.dependencyChanges.lockfilesChanged, []);
    assert.deepEqual(ctx.dependencyChanges.manifestsWithoutLockfileChange, ["package.json"]);
    assert.deepEqual(ctx.dependencyChanges.manifestsChanged, ["package.json"]);
    assert.deepEqual(ctx.excludedChanged, {
      count: 2,
      examples: ["fixtures/demo/package-lock.json", "fixtures/demo/package.json"],
    });
  });

  it("excludes both sides of a rename crossing the fixture boundary (#354)", async () => {
    const diff = `diff --git a/fixtures/old.ts b/src/moved.ts
similarity index 60%
rename from fixtures/old.ts
rename to src/moved.ts
index 1111111..2222222 100644
--- a/fixtures/old.ts
+++ b/src/moved.ts
@@ -1,2 +1,3 @@
 import leftPad from "left-pad";
 console.log(leftPad("x", 3));
+console.log("moved");
diff --git a/src/other.ts b/fixtures/archived.ts
similarity index 60%
rename from src/other.ts
rename to fixtures/archived.ts
index 3333333..4444444 100644
--- a/src/other.ts
+++ b/fixtures/archived.ts
@@ -1,2 +1,3 @@
 import leftPad from "left-pad";
 console.log(leftPad("y", 3));
+console.log("archived");
`;
    const ctx = await pullRequestContext(fakeClient({ diff }), PR, ["fixtures"]);
    assert.equal(ctx.complete, true);
    assert.deepEqual(ctx.dependencyChanges.changedSourceFiles, []);
    assert.deepEqual(ctx.dependencyChanges.sourceLineChanges, []);
    assert.deepEqual(ctx.excludedChanged, {
      count: 2,
      examples: ["fixtures/archived.ts", "fixtures/old.ts"],
    });
  });
});

describe("partial manifest parsing", () => {
  for (const invalid of ['{"dependencies":{"axios":42}}', '{"dependencies":[]}']) {
    it(`does not claim complete PR context after skipped manifest entries: ${invalid}`, async () => {
      const client = fakeClient({
        files: {
          [`${BASE}:package.json`]: invalid,
          [`${HEAD}:package.json`]: manifest({ axios: "^1.7.0" }),
        },
      });
      const ctx = await pullRequestContext(client, PR);
      assert.equal(ctx.complete, false);
      assert.deepEqual(ctx.dependencyChanges.changes, []);
      assert.match(ctx.dependencyChanges.limitations.join("\n"), /package\.json \(base\)/);
    });
  }
});
