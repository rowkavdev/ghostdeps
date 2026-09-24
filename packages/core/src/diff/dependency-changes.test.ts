import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  diffDeclaredDependencies,
  extractDependencyChanges,
  isSafeRepositoryPath,
  type ReadDeclaredDependencies,
} from "./dependency-changes.js";
import { classifyDependencyFile } from "./dependency-files.js";
import { parseUnifiedDiff } from "./unified.js";
import type { Dependency, DependencyKind, ProjectRef } from "../types/index.js";

const project: ProjectRef = { path: ".", ecosystem: "javascript-typescript", packageManagers: [] };
const testData = (path: string): string =>
  readFileSync(new URL(`../../test/diffs/${path}`, import.meta.url), "utf8");

/**
 * Test stand-in for the JS/TS adapter's listDirectDependencies(): reads the
 * dependency sections of a package.json. Real parsing lives in the adapter.
 */
function packageJsonDependencies(text: string, declaredIn: string): Dependency[] {
  const json = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const sections: [string, DependencyKind][] = [
    ["dependencies", "runtime"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"],
  ];
  return sections.flatMap(([section, kind]) =>
    Object.entries(json[section] ?? {}).map(([name, constraint]) => ({
      name,
      constraint,
      kind,
      project,
      declaredIn,
    })),
  );
}

const readRecorded: ReadDeclaredDependencies = async (side, path) =>
  packageJsonDependencies(testData(`js-add-axios/${side}/${path}`), path);

const dep = (name: string, constraint: string, kind: DependencyKind = "runtime"): Dependency => ({
  name,
  constraint,
  kind,
  project,
  declaredIn: "package.json",
});

describe("extractDependencyChanges on a recorded package.json PR", async () => {
  const result = await extractDependencyChanges(
    parseUnifiedDiff(testData("js-add-axios.diff")),
    readRecorded,
  );

  it("finds added, removed and version-changed direct dependencies", () => {
    assert.deepEqual(
      result.changes.map((c) => [c.change, c.name, c.before?.constraint, c.after?.constraint]),
      [
        ["added", "axios", undefined, "^1.7.0"],
        ["changed", "lodash", "^4.17.20", "^4.17.21"],
        ["removed", "vitest", "^2.0.0", undefined],
      ],
    );
  });

  it("marks added dependencies for usage analysis", () => {
    const axios = result.changes.find((c) => c.name === "axios");
    assert.equal(axios?.usageCheck, "pending");
    assert.equal(axios?.after?.kind, "runtime");
    assert.equal(result.changes.find((c) => c.name === "lodash")?.usageCheck, undefined);
  });

  it("reports the lockfile change and the changed source lines", () => {
    assert.deepEqual(result.manifestsChanged, ["package.json"]);
    assert.deepEqual(result.lockfilesChanged, [
      {
        path: "pnpm-lock.yaml",
        ecosystem: "javascript-typescript",
        packageManager: "pnpm",
        status: "modified",
      },
    ]);
    assert.deepEqual(result.manifestsWithoutLockfileChange, []);
    const index = result.changedSourceFiles.find((f) => f.path === "src/index.js");
    assert.deepEqual(index?.addedLines, [
      { line: 2, text: 'import axios from "axios";' },
      { line: 4, text: "export const get = (u) => axios.get(u);" },
    ]);
    assert.ok(
      !result.changedSourceFiles.some((f) => f.path === "logo.png" || f.path === "gone.js"),
    );
    assert.deepEqual(result.limitations, []);
  });
});

describe("extractDependencyChanges edge cases", () => {
  const manifestOnly = parseUnifiedDiff(
    'diff --git a/web/package.json b/web/package.json\n--- a/web/package.json\n+++ b/web/package.json\n@@ -1 +1 @@\n-{}\n+{"dependencies":{"x":"1"}}\n',
  );

  it("flags a manifest change with no lockfile change", async () => {
    const result = await extractDependencyChanges(manifestOnly, async (side) =>
      side === "base" ? [] : [dep("x", "1")],
    );
    assert.deepEqual(result.manifestsWithoutLockfileChange, ["web/package.json"]);
  });

  it("counts a workspace-root lockfile for a nested manifest", async () => {
    const workspace = parseUnifiedDiff(
      "diff --git a/packages/web/package.json b/packages/web/package.json\n--- a/packages/web/package.json\n+++ b/packages/web/package.json\n@@ -1 +1 @@\n-{}\n+{}\n" +
        "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-a\n+b\n" +
        "diff --git a/crates/x/Cargo.toml b/crates/x/Cargo.toml\n--- a/crates/x/Cargo.toml\n+++ b/crates/x/Cargo.toml\n@@ -1 +1 @@\n-a\n+b\n" +
        "diff --git a/web2/yarn.lock b/web2/yarn.lock\n--- a/web2/yarn.lock\n+++ b/web2/yarn.lock\n@@ -1 +1 @@\n-a\n+b\n",
    );
    const result = await extractDependencyChanges(workspace, async (side) =>
      side === "base" ? [] : [dep("x", "1")],
    );
    // pnpm-lock.yaml at the root covers packages/web; nothing covers the Rust
    // crate, and a sibling directory's lockfile does not count.
    assert.deepEqual(result.manifestsWithoutLockfileChange, ["crates/x/Cargo.toml"]);
  });

  it("never passes unsafe diff paths to readDeclared", async () => {
    const hostile = parseUnifiedDiff(
      "diff --git a/../../etc/package.json b/../../etc/package.json\n--- a/../../etc/package.json\n+++ b/../../etc/package.json\n@@ -1 +1 @@\n-a\n+b\n" +
        'diff --git "a/x\\033[2J/package.json" "b/x\\033[2J/package.json"\n--- "a/x\\033[2J/package.json"\n+++ "b/x\\033[2J/package.json"\n@@ -1 +1 @@\n-a\n+b\n' +
        "diff --git a/src/../../evil.js b/src/../../evil.js\n--- a/src/../../evil.js\n+++ b/src/../../evil.js\n@@ -1 +1 @@\n-a\n+b\n",
    );
    const reads: string[] = [];
    const result = await extractDependencyChanges(hostile, async (_side, path) => {
      reads.push(path);
      return [];
    });
    assert.deepEqual(reads, []);
    assert.deepEqual(result.changedSourceFiles, []);
    assert.equal(
      result.limitations.filter((l) => l.startsWith("Skipped a file with an unsafe path")).length,
      3,
    );
    assert.ok(!result.limitations.join(" ").includes(String.fromCharCode(27)));
  });

  it("records a limitation instead of guessing when a manifest can't be read", async () => {
    const result = await extractDependencyChanges(manifestOnly, async (side) =>
      side === "head" ? undefined : [],
    );
    assert.deepEqual(result.changes, []);
    assert.match(
      result.limitations[0] ?? "",
      /Could not read the dependencies in web\/package.json \(head\)/,
    );
  });

  it("treats a new manifest as all-added and a deleted one as all-removed", async () => {
    const added = parseUnifiedDiff(
      "diff --git a/package.json b/package.json\nnew file mode 100644\n--- /dev/null\n+++ b/package.json\n@@ -0,0 +1 @@\n+{}\n",
    );
    const deleted = parseUnifiedDiff(
      "diff --git a/package.json b/package.json\ndeleted file mode 100644\n--- a/package.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-{}\n",
    );
    const reads: string[] = [];
    const read: ReadDeclaredDependencies = async (side) => {
      reads.push(side);
      return [dep("a", "1")];
    };
    assert.deepEqual(
      (await extractDependencyChanges(added, read)).changes.map((c) => c.change),
      ["added"],
    );
    assert.deepEqual(
      (await extractDependencyChanges(deleted, read)).changes.map((c) => c.change),
      ["removed"],
    );
    assert.deepEqual(reads, ["head", "base"]);
  });

  it("carries diff truncation into limitations", async () => {
    const result = await extractDependencyChanges(
      parseUnifiedDiff(testData("js-add-axios.diff"), { maxFiles: 2 }),
      readRecorded,
    );
    assert.match(result.limitations.join(" "), /too large/);
  });
});

describe("diffDeclaredDependencies", () => {
  it("treats a kind move as one change", () => {
    const changes = diffDeclaredDependencies([dep("ts", "5", "dev")], [dep("ts", "5")], {
      ecosystem: "javascript-typescript",
      head: "package.json",
    });
    assert.deepEqual(changes, [
      {
        change: "changed",
        name: "ts",
        ecosystem: "javascript-typescript",
        manifest: "package.json",
        before: { constraint: "5", kind: "dev" },
        after: { constraint: "5", kind: "runtime" },
      },
    ]);
  });

  it("pairs kind moves correctly when many dependencies change", () => {
    const base = [dep("a", "1", "dev"), dep("b", "1"), dep("c", "1", "dev")];
    const head = [dep("a", "1"), dep("c", "2", "dev"), dep("d", "1")];
    assert.deepEqual(
      diffDeclaredDependencies(base, head, { ecosystem: "x", head: "p" }).map(
        (c) => `${c.change} ${c.name}`,
      ),
      ["changed a", "removed b", "changed c", "added d"],
    );
  });

  it("returns nothing when only unrelated fields changed", () => {
    assert.deepEqual(
      diffDeclaredDependencies([dep("a", "1")], [dep("a", "1")], { ecosystem: "x", head: "p" }),
      [],
    );
  });
});

describe("isSafeRepositoryPath", () => {
  it("accepts normal relative paths", () => {
    for (const p of ["package.json", "packages/a/package.json", "src/..hidden/x.ts", "a/b..c"]) {
      assert.equal(isSafeRepositoryPath(p), true, p);
    }
  });
  it("rejects traversal, absolute, backslash and control-character paths", () => {
    for (const p of [
      "",
      "../x",
      "a/../../x",
      "a/..",
      "/etc/passwd",
      "C:/x",
      "a\\b",
      "a\u0000b",
      "a\u001b[2Jb",
      "a\u007fb",
    ]) {
      assert.equal(isSafeRepositoryPath(p), false, JSON.stringify(p));
    }
  });
});

describe("classifyDependencyFile", () => {
  it("knows manifests and lockfiles across ecosystems", () => {
    assert.equal(classifyDependencyFile("packages/a/package.json")?.role, "manifest");
    assert.equal(classifyDependencyFile("yarn.lock")?.packageManager, "yarn");
    assert.equal(classifyDependencyFile("api/uv.lock")?.ecosystem, "python");
    assert.equal(classifyDependencyFile("requirements-dev.txt")?.role, "manifest");
    assert.equal(classifyDependencyFile("requirements/base.txt")?.role, "manifest");
    assert.equal(classifyDependencyFile("Cargo.lock")?.ecosystem, "rust");
    assert.equal(classifyDependencyFile("go.sum")?.role, "lockfile");
  });

  it("ignores vendored copies, lookalikes and prototype keys", () => {
    assert.equal(classifyDependencyFile("node_modules/x/package.json"), undefined);
    assert.equal(classifyDependencyFile("vendor/github.com/x/go.mod"), undefined);
    assert.equal(classifyDependencyFile("src/package.json.bak"), undefined);
    assert.equal(classifyDependencyFile("constructor"), undefined);
    assert.equal(classifyDependencyFile("__proto__"), undefined);
  });
});
