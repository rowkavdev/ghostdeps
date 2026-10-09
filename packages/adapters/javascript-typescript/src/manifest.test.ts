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

it("optionalDependencies overrides duplicate runtime entries like npm", () => {
  const result = parseManifestText(
    JSON.stringify({
      dependencies: { shared: "1", required: "1" },
      optionalDependencies: { shared: "2" },
    }),
    rootProject,
    "package.json",
  );
  assert.deepEqual(
    result.dependencies.map((dep) => [dep.name, dep.constraint, dep.kind]),
    [
      ["required", "1", "runtime"],
      ["shared", "2", "optional"],
    ],
  );
});

it("classifies GitHub shorthand commit and semver refs as git dependencies", () => {
  for (const raw of [
    "user/repo#main",
    "user/repo#feature/branch",
    "user/repo#v1.2.3",
    "user/repo#semver:^1.0.0",
    "user/repo#deadbeef",
  ]) {
    assert.deepEqual(classifySpecifier(raw), { type: "git", detail: raw }, raw);
    const parsed = parseManifestText(
      JSON.stringify({ dependencies: { hosted: raw } }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(parsed.dependencies[0]?.specifier, { type: "git", detail: raw });
  }
  for (const raw of ["@scope/pkg", "^1.0.0", "latest", "../local", "one/two/three"]) {
    assert.notEqual(classifySpecifier(raw)?.type, "git", raw);
  }
});

it("retains empty dependency constraints as npm wildcard declarations", () => {
  const result = parseManifestText(
    JSON.stringify({
      dependencies: { runtime: "" },
      devDependencies: { dev: "" },
      peerDependencies: { peer: "" },
      optionalDependencies: { optional: "", invalid: null },
    }),
    rootProject,
    "package.json",
  );
  assert.deepEqual(
    result.dependencies.map((dep) => [dep.name, dep.constraint, dep.kind]),
    [
      ["runtime", "", "runtime"],
      ["dev", "", "dev"],
      ["peer", "", "peer"],
      ["optional", "", "optional"],
    ],
  );
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0]?.statement.includes('"invalid"'));
});

it("classifies bare local dependency paths without treating them as registry constraints", () => {
  for (const raw of [
    "../local",
    "./local",
    "/opt/local",
    "~/local",
    "../../local",
    "./local/package.tgz",
  ]) {
    assert.deepEqual(classifySpecifier(raw), { type: "file", detail: raw }, raw);
    const parsed = parseManifestText(
      JSON.stringify({ dependencies: { local: raw } }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(parsed.dependencies[0]?.specifier, { type: "file", detail: raw });
  }
  for (const raw of ["@scope/pkg", "^1.0.0", "latest", "user/repo"]) {
    assert.notEqual(classifySpecifier(raw)?.type, "file", raw);
  }
});

it("retains GitHub shorthand with an empty ref as a git dependency", () => {
  const raw = "user/repo#";
  assert.deepEqual(classifySpecifier(raw), { type: "git", detail: raw });
  assert.equal(classifySpecifier("@scope/pkg#")?.type, undefined);
});

it("retains whitespace inside GitHub shorthand semver selectors", () => {
  for (const raw of ["user/repo#semver:>=1 <2", "user/repo#semver:^1 || ^2"]) {
    assert.deepEqual(classifySpecifier(raw), { type: "git", detail: raw }, raw);
  }
  // Deliberate divergence from npa (which classes "user/repo#feature branch"
  // as git): shorthand whitespace refs must use semver:.
  for (const raw of ["user/repo#feature branch", "user/repo extra", "@scope/pkg#semver:>=1 <2"]) {
    assert.equal(classifySpecifier(raw), undefined, raw);
  }
});

it("classifies hosted git URL specifiers as git dependencies (#861)", () => {
  // Positive and negative cases grounded against npm's owning parser: npa
  // 12.0.2 and 14.0.0 give identical verdicts for every one of these forms
  // (probed over 34 forms through the npa() entry npm install uses).
  // Note npa applies NO known-host check to scp-style remotes: any
  // user@host.tld:path is git, even unrecognised hosts, absolute paths and
  // deep repository paths.
  for (const raw of [
    "git@github.com:org/repo.git",
    "git@github.com:org/repo",
    "git@github.com:org/repo#branch",
    "git@gitlab.com:group/sub/repo",
    "user@bitbucket.org:org/repo",
    "git@gist.github.com:abc123",
    "git@git.sr.ht:~user/repo",
    "git@github.com:o/r/",
    "git@github.com:o/r:weird",
    "git@github.com:org/repo/sub",
    "user@host.co:org/repo",
    "user@host.co:/absolute/path",
    "git@sourcehut.org:~user/repo",
    "ssh://git@github.com/org/repo.git",
    "ssh://git@github.com:2222/org/repo.git",
    "ssh://github.com/org/repo",
    "ssh://git@gitlab.com/org/repo",
    "ssh://git@github.com/o/r#main",
    "ssh://git@gist.github.com/abc123",
    "ssh://git@github.com/o/r/",
  ]) {
    assert.deepEqual(classifySpecifier(raw), { type: "git", detail: raw }, raw);
    const parsed = parseManifestText(
      JSON.stringify({ dependencies: { hosted: raw } }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(parsed.dependencies[0]?.specifier, { type: "git", detail: raw });
  }
  // npa rejects these outright (unsupported protocol or invalid URL), so npm
  // could not install them as git either: ssh:// to hosts no provider
  // recognises, a port out of range, and non-URL "protocol:" shapes.
  for (const raw of [
    "user@host:repo/foo@bar:latest",
    "foo@bar:https://example.com",
    "ssh://foo",
    "ssh://git@custom.host.co/x/y.git",
    "ssh://evilgithub.com/x/y",
    "ssh://git@github.com:99999/x/y",
  ]) {
    assert.notEqual(classifySpecifier(raw)?.type, "git", raw);
  }
});

it("classifies dot-prefixed directory specifiers as file sources", () => {
  for (const raw of [".", "..", ".tag", "..tag", ".hidden", "..."]) {
    assert.deepEqual(classifySpecifier(raw), { type: "file", detail: raw }, raw);
    const result = parseManifestText(
      JSON.stringify({ dependencies: { local: raw } }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(result.dependencies[0]?.specifier, { type: "file", detail: raw });
  }
  for (const raw of ["latest", "1.2.3"]) {
    assert.equal(classifySpecifier(raw), undefined, raw);
  }
});

it("classifies absolute drive-letter dependency paths as file sources", () => {
  for (const raw of ["C:/local", "C:\\local", "d:/packages/pkg", "d:\\packages\\pkg"]) {
    assert.deepEqual(classifySpecifier(raw), { type: "file", detail: raw }, raw);
    const result = parseManifestText(
      JSON.stringify({ dependencies: { local: raw } }),
      rootProject,
      "package.json",
    );
    assert.deepEqual(result.dependencies[0]?.specifier, { type: "file", detail: raw });
  }
  for (const raw of ["C:tag", "latest", "1.2.3"]) {
    assert.equal(classifySpecifier(raw), undefined, raw);
  }
});
