import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, ProjectRef, RepositoryHandle } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "./adapter.js";
import { classifySpecifier, parseManifest, parseManifestText } from "./manifest.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

const rootProject: ProjectRef = {
  path: ".",
  ecosystem: "javascript-typescript",
  packageManagers: [],
};

function contextFor(repository: RepositoryHandle): AdapterContext {
  return { repository, network: { mode: "offline" } };
}

describe("package.json parser (issue #26)", () => {
  it("parses the basic-unused fixture into the Dependency model", async () => {
    const result = await parseManifest(fixtureHandle("js", "basic-unused"), rootProject);
    assert.deepEqual(result.errors, []);
    assert.equal(result.dependencies.length, 1);
    const dep = result.dependencies[0];
    assert.equal(dep?.name, "left-pad");
    assert.equal(dep?.constraint, "^1.3.0");
    assert.equal(dep?.kind, "runtime");
    assert.equal(dep?.declaredIn, "package.json");
    assert.equal(dep?.project, rootProject);
    assert.equal(dep?.specifier, undefined);
  });

  it("maps all four dependency kinds", () => {
    const result = parseManifestText(
      JSON.stringify({
        dependencies: { a: "^1.0.0" },
        devDependencies: { b: "~2.0.0" },
        peerDependencies: { c: ">=3.0.0" },
        optionalDependencies: { d: "4.0.0" },
      }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.dependencies.map((dep) => [dep.name, dep.kind]),
      [
        ["a", "runtime"],
        ["b", "dev"],
        ["c", "peer"],
        ["d", "optional"],
      ],
    );
  });

  it("records workspace, file, link and git specifiers without executing them", () => {
    assert.deepEqual(classifySpecifier("workspace:*"), {
      type: "workspace",
      detail: "workspace:*",
    });
    assert.deepEqual(classifySpecifier("workspace:^1.0.0"), {
      type: "workspace",
      detail: "workspace:^1.0.0",
    });
    assert.deepEqual(classifySpecifier("file:../local"), { type: "file", detail: "file:../local" });
    assert.deepEqual(classifySpecifier("link:../linked"), {
      type: "link",
      detail: "link:../linked",
    });
    assert.deepEqual(classifySpecifier("git+ssh://git@github.com/u/r.git"), {
      type: "git",
      detail: "git+ssh://git@github.com/u/r.git",
    });
    assert.deepEqual(classifySpecifier("github:u/r"), { type: "git", detail: "github:u/r" });
    assert.deepEqual(classifySpecifier("someuser/somerepo"), {
      type: "git",
      detail: "someuser/somerepo",
    });
  });

  it("keeps registry constraints plain, including scoped names, aliases and tags", () => {
    assert.equal(classifySpecifier("^1.2.3"), undefined);
    assert.equal(classifySpecifier("*"), undefined);
    assert.equal(classifySpecifier("latest"), undefined);
    assert.equal(classifySpecifier("1.2.3"), undefined);
    assert.deepEqual(classifySpecifier("npm:real-pkg@^1.0.0"), {
      type: "registry",
      detail: "npm alias: npm:real-pkg@^1.0.0",
    });
    assert.equal(classifySpecifier("https://example.com/pkg-1.0.0.tgz")?.type, "registry");
  });

  it("degrades on malformed JSON instead of crashing", () => {
    const result = parseManifestText("{ not json", rootProject, "package.json");
    assert.deepEqual(result.dependencies, []);
    assert.ok(result.errors.some((entry) => entry.kind === "manifest-malformed"));
  });

  it("degrades on a non-object manifest", () => {
    const result = parseManifestText('["not", "an", "object"]', rootProject, "package.json");
    assert.deepEqual(result.dependencies, []);
    assert.ok(result.errors.some((entry) => entry.kind === "manifest-malformed"));
  });

  it("skips entries without string constraints and says so", () => {
    const result = parseManifestText(
      JSON.stringify({ dependencies: { good: "^1.0.0", bad: 42 } }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(
      result.dependencies.map((dep) => dep.name),
      ["good"],
    );
    assert.ok(
      result.errors.some(
        (entry) => entry.kind === "manifest-entry-skipped" && entry.statement.includes('"bad"'),
      ),
    );
  });

  it("reports a missing manifest as evidence, not an exception", async () => {
    const result = await parseManifest(memoryHandle({}), rootProject);
    assert.deepEqual(result.dependencies, []);
    assert.ok(result.errors.some((entry) => entry.kind === "manifest-missing"));
  });

  it("parses workspace member manifests with their own declaredIn path", async () => {
    const member: ProjectRef = {
      path: "packages/app",
      ecosystem: "javascript-typescript",
      packageManagers: [],
    };
    const result = await parseManifest(
      memoryHandle({ "packages/app/package.json": '{ "dependencies": { "x": "^1.0.0" } }' }),
      member,
    );
    assert.equal(result.dependencies[0]?.declaredIn, "packages/app/package.json");
    assert.equal(result.dependencies[0]?.project, member);
  });

  it("adapter.listDirectDependencies parses every detected project", async () => {
    const adapter = createJavaScriptTypeScriptAdapter();
    const handle = memoryHandle({
      "package.json": '{ "dependencies": { "root-dep": "^1.0.0" } }',
      "src/index.js": "export {};",
      "packages/app/package.json": '{ "devDependencies": { "member-dep": "^2.0.0" } }',
      "packages/app/src/index.ts": "export {};",
    });
    const context = contextFor(handle);
    const detection = await adapter.detect(context);
    const deps = await adapter.listDirectDependencies(context, detection.projects);
    assert.deepEqual(deps.map((dep) => [dep.name, dep.kind]).sort(), [
      ["member-dep", "dev"],
      ["root-dep", "runtime"],
    ]);
  });
});
