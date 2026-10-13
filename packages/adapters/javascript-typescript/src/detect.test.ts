import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAdapterContractTests } from "@ghostdeps/core";
import type { AdapterContext, RepositoryHandle } from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "./adapter.js";
import {
  DETECTION_CONFIDENCE_THRESHOLD,
  MAX_DETECT_COMPONENT_READS_PER_ROOT,
  detectJavaScriptTypeScript,
} from "./detect.js";
import { MAX_SCRIPT_BLOCKS_PER_FILE } from "./usage/embedded.js";
import { fixtureHandle, memoryHandle } from "./testing/fs-handle.js";

function contextFor(repository: RepositoryHandle): AdapterContext {
  return { repository, network: { mode: "offline" } };
}

describe("js/ts ecosystem detection (issue #24)", () => {
  it("detects a real JS project above threshold and lists what was found", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(fixtureHandle("js", "basic-unused")),
    );
    assert.ok(result.confidence >= DETECTION_CONFIDENCE_THRESHOLD);
    assert.deepEqual(
      result.projects.map((project) => project.path),
      ["."],
    );
    assert.equal(result.projects[0]?.ecosystem, "javascript-typescript");
    assert.ok(result.evidence.some((entry) => entry.kind === "manifest-found"));
    assert.ok(result.evidence.some((entry) => entry.kind === "source-files"));
  });

  it("scores package.json-without-source below threshold and skips it with a reason", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(fixtureHandle("js", "package-json-without-js")),
    );
    assert.ok(result.confidence < DETECTION_CONFIDENCE_THRESHOLD);
    assert.equal(result.projects.length, 0);
    assert.ok(result.evidence.some((entry) => entry.kind === "no-js-ts-source"));
    const skipped = result.evidence.find((entry) => entry.kind === "project-skipped");
    assert.ok(skipped, "a below-threshold root must carry its skip reason as evidence");
    assert.match(skipped.statement, /below the detection threshold/);
  });

  it("returns zero confidence and no projects when no manifest exists", async () => {
    const result = await detectJavaScriptTypeScript(contextFor(memoryHandle({})));
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.projects, []);
    assert.deepEqual(result.evidence, []);
  });

  it("ignores vendored package.json copies and vendored source", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "src/index.js": "export {};",
          "node_modules/left-pad/package.json": "{}",
          "node_modules/left-pad/index.js": "module.exports = 1;",
        }),
      ),
    );
    assert.deepEqual(
      result.projects.map((project) => project.path),
      ["."],
    );
    const sourceEvidence = result.evidence.find((entry) => entry.kind === "source-files");
    assert.match(sourceEvidence?.statement ?? "", /1 JS\/TS source file/);
  });

  it("assigns nested source to the nearest project root in a monorepo", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": '{ "workspaces": ["packages/*"] }',
          "packages/app/package.json": "{}",
          "packages/app/src/index.ts": "export {};",
        }),
      ),
    );
    // A declared workspace root with sourced members is a real project root
    // (its devDependencies matter); the member owns its own source.
    assert.deepEqual(
      result.projects.map((project) => project.path),
      [".", "packages/app"],
    );
    assert.ok(result.evidence.some((entry) => entry.kind === "workspace-root"));
  });

  it("still skips a manifest-only root that declares no workspace", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "packages/app/package.json": "{}",
          "packages/app/src/index.ts": "export {};",
        }),
      ),
    );
    assert.deepEqual(
      result.projects.map((project) => project.path),
      ["packages/app"],
    );
    assert.ok(
      result.evidence.some(
        (entry) => entry.kind === "project-skipped" && entry.statement.includes("repository root"),
      ),
    );
  });

  it("does not treat declaration-only packages as meaningful source", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "types/index.d.ts": "export declare const x: number;",
        }),
      ),
    );
    assert.ok(result.confidence < DETECTION_CONFIDENCE_THRESHOLD);
    assert.equal(result.projects.length, 0);
  });

  it("treats .d.mts and .d.cts declarations like .d.ts, and keeps real .mts/.cts source", async () => {
    const decl = "export interface Item { value: string }";
    const pkg = '{"name":"types-only","dependencies":{"demo":"^1"}}';
    const detect = (files: Record<string, string>) =>
      detectJavaScriptTypeScript(contextFor(memoryHandle(files)));
    for (const file of ["types/index.d.ts", "types/index.d.mts", "types/index.d.cts"]) {
      const result = await detect({ "package.json": pkg, [file]: decl });
      assert.equal(result.confidence, 0.3, file);
      assert.deepEqual(result.projects, [], file);
    }
    for (const file of ["src/index.mts", "src/index.cts", "src/index.ts"]) {
      const result = await detect({ "package.json": pkg, [file]: decl });
      assert.equal(result.confidence, 0.7, file);
      assert.equal(result.projects.length, 1, file);
    }
    // A declaration file beside real source does not stop detection.
    const mixed = await detect({
      "package.json": pkg,
      "types/index.d.mts": decl,
      "src/index.ts": decl,
    });
    assert.equal(mixed.confidence, 0.7);
    assert.equal(mixed.projects.length, 1);
  });

  it("degrades confidence on a malformed manifest instead of crashing", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{ not json",
          "src/index.ts": "export {};",
        }),
      ),
    );
    assert.ok(result.evidence.some((entry) => entry.kind === "manifest-malformed"));
    // Source exists, so detection still passes at exactly threshold.
    assert.equal(result.confidence, DETECTION_CONFIDENCE_THRESHOLD);
  });

  it("scores tsconfig and lockfiles as supporting evidence", async () => {
    const plain = await detectJavaScriptTypeScript(
      contextFor(memoryHandle({ "package.json": "{}", "src/index.js": "export {};" })),
    );
    const supported = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": "{}",
          "src/index.js": "export {};",
          "tsconfig.json": "{}",
          "pnpm-lock.yaml": "lockfileVersion: '9.0'",
        }),
      ),
    );
    assert.ok(supported.confidence > plain.confidence);
    assert.ok(supported.evidence.some((entry) => entry.kind === "tsconfig-found"));
    assert.ok(supported.evidence.some((entry) => entry.kind === "lockfile-found"));
  });
});

// The shared contract suite (ADR 0002) must pass against our fixtures.
runAdapterContractTests(
  createJavaScriptTypeScriptAdapter(),
  contextFor(fixtureHandle("js", "basic-unused")),
);

describe("detection counts components with an embedded script as source", () => {
  const pkg = '{"dependencies":{"demo":"^1"}}';
  const detect = (files: Record<string, string>) =>
    detectJavaScriptTypeScript(contextFor(memoryHandle({ "package.json": pkg, ...files })));
  const SCRIPT = '<script>import "demo";</script>';

  for (const [file, body] of [
    ["src/App.vue", `<template><div/></template>\n${SCRIPT}`],
    ["src/App.svelte", `${SCRIPT}\n<p>hi</p>`],
    ["src/Page.astro", `---\nimport "demo";\n---\n<p>hi</p>`],
    ["src/Page2.astro", `<p>hi</p>\n${SCRIPT}`],
    ["src/App.vue", '<script setup lang="ts">const x: number = 1;</script>'],
  ] as const) {
    it(`detects a root whose only source is ${file}`, async () => {
      const result = await detect({ [file]: body });
      assert.deepEqual(
        result.projects.map((project) => project.path),
        ["."],
      );
      assert.equal(result.confidence, 0.7);
      assert.match(
        result.evidence.find((e) => e.kind === "source-files")?.statement ?? "",
        /1 JS\/TS source file\(s\).*1 component/,
      );
    });
  }

  it("does not promote components, pages and scripts that carry no meaningful script", async () => {
    for (const files of [
      { "src/App.vue": "<template><div/></template>" },
      { "src/App.vue": "<script></script>\n<template/>" },
      { "src/App.vue": "<script>   \n  </script>" },
      { "src/App.svelte": "<script/>\n<p>hi</p>" },
      { "src/Page.astro": "<p>hi</p>" },
      { "src/Page.astro": "---\n---\n<p>hi</p>" },
      { "src/App.vue": '<script type="text/template"><div></div></script>' },
      { "src/index.html": SCRIPT },
      { "src/index.htm": SCRIPT },
      { "src/types.d.ts": "export {};" },
    ]) {
      const result = await detect(files);
      assert.equal(result.confidence, 0.3, JSON.stringify(files));
      assert.deepEqual(result.projects, []);
    }
  });

  it("keeps nearest-root ownership and the workspace-root rule for member components", async () => {
    const result = await detectJavaScriptTypeScript(
      contextFor(
        memoryHandle({
          "package.json": '{"workspaces":["apps/*"]}',
          "apps/web/package.json": pkg,
          "apps/web/src/App.vue": SCRIPT,
          "apps/docs/package.json": pkg,
          "apps/docs/src/Page.astro": "<p>no script</p>",
        }),
      ),
    );
    assert.deepEqual(result.projects.map((project) => project.path).sort(), [".", "apps/web"]);
  });

  it("ignores components under excluded directories", async () => {
    const result = await detect({ "node_modules/x/App.vue": SCRIPT, "dist/App.svelte": SCRIPT });
    assert.equal(result.confidence, 0.3);
  });

  it("keeps a root whose components cannot be classified instead of reporting no source", async () => {
    const unverified = (result: Awaited<ReturnType<typeof detect>>) =>
      result.evidence.some((e) => e.kind === "component-source-unverified");
    // Over the per-root read budget with no script seen so far.
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_DETECT_COMPONENT_READS_PER_ROOT; i++) {
      many[`src/a${String(i).padStart(5, "0")}.vue`] = "<template/>";
    }
    many["src/zz.vue"] = SCRIPT;
    const capped = await detect(many);
    assert.equal(capped.confidence, 0.3);
    assert.ok(unverified(capped));
    // A component over the size ceiling.
    const big = `<script>import "demo"; // ${"x".repeat(1_000_001)}</script>`;
    const oversize = await detect({ "src/Big.vue": big });
    assert.equal(oversize.confidence, 0.3);
    assert.ok(unverified(oversize));
    // More script blocks than the extractor keeps: 200 empty ones, then a real import.
    const blocks = `${"<script> </script>".repeat(MAX_SCRIPT_BLOCKS_PER_FILE)}${SCRIPT}`;
    const dropped = await detect({ "src/Many.vue": blocks });
    assert.equal(dropped.confidence, 0.3);
    assert.ok(unverified(dropped));
    // A readable, fully classified script-less component is still not promoted.
    assert.equal((await detect({ "src/App.vue": "<template/>" })).confidence, 0.3);
  });

  it("does not let one root's components starve another root", async () => {
    const files: Record<string, string> = {
      "apps/a/package.json": pkg,
      "apps/z/package.json": pkg,
      "apps/z/src/App.vue": SCRIPT,
    };
    for (let i = 0; i < MAX_DETECT_COMPONENT_READS_PER_ROOT; i++) {
      files[`apps/a/src/c${String(i).padStart(5, "0")}.vue`] = "<template/>";
    }
    const result = await detectJavaScriptTypeScript(contextFor(memoryHandle(files)));
    assert.ok(result.projects.some((project) => project.path === "apps/z"));
    // Reversed: the many-component root sorts last, the scripted one first.
    const reversed: Record<string, string> = {
      "apps/a/package.json": pkg,
      "apps/a/src/App.vue": SCRIPT,
      "apps/z/package.json": pkg,
    };
    for (let i = 0; i < MAX_DETECT_COMPONENT_READS_PER_ROOT + 5; i++) {
      reversed[`apps/z/src/c${String(i).padStart(5, "0")}.vue`] = "<template/>";
    }
    const back = await detectJavaScriptTypeScript(contextFor(memoryHandle(reversed)));
    assert.ok(back.projects.some((project) => project.path === "apps/a"));
  });

  it("states a limitation for every root left unread by the run-wide ceiling", async () => {
    const files: Record<string, string> = {};
    for (let r = 0; r < 20; r++) {
      const root = `apps/r${String(r).padStart(2, "0")}`;
      files[`${root}/package.json`] = pkg;
      for (let i = 0; i < 600; i++)
        files[`${root}/src/c${String(i).padStart(4, "0")}.vue`] = "<template/>";
    }
    const result = await detectJavaScriptTypeScript(contextFor(memoryHandle(files)));
    const limited = result.evidence
      .filter((e) => e.kind === "component-source-unverified")
      .map((e) => `${e.file} ${e.statement}`);
    // Fair scheduling: every root got reads, and every root left with unread components is flagged.
    assert.equal(limited.length, 20);
  });

  it("flags truncated script blocks even when a kept block counts", async () => {
    const text = `${SCRIPT}${"<script> </script>".repeat(MAX_SCRIPT_BLOCKS_PER_FILE)}`;
    const result = await detect({ "package.json": pkg, "src/Big.vue": text });
    assert.equal(result.confidence, 0.7);
    assert.ok(result.evidence.some((e) => e.kind === "component-source-unverified"));
  });

  it("does not claim there is no source for a root it could not fully check", async () => {
    const big = `<script>import "demo"; // ${"x".repeat(1_000_001)}</script>`;
    const result = await detect({ "package.json": pkg, "src/Big.vue": big });
    assert.equal(result.confidence, 0.3);
    const absence = result.evidence.find((e) => e.kind === "no-js-ts-source");
    assert.ok(absence && !/has no meaningful/.test(absence.statement));
    assert.match(absence.statement, /not ruled out/);
    const clean = await detect({ "package.json": pkg, "src/App.vue": "<template/>" });
    assert.match(
      clean.evidence.find((e) => e.kind === "no-js-ts-source")!.statement,
      /has no meaningful/,
    );
  });

  it("keeps the uncertainty when another component already counted", async () => {
    const files: Record<string, string> = {
      "package.json": pkg,
      "src/A.vue": SCRIPT,
      "src/Many.vue": `${"<script> </script>".repeat(MAX_SCRIPT_BLOCKS_PER_FILE)}${SCRIPT}`,
    };
    const result = await detect(files);
    assert.ok(result.confidence >= 0.5);
    assert.ok(result.evidence.some((e) => e.kind === "component-source-unverified"));
  });

  it("stops reading components once a root already has the full source bonus", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`src/c${i}.vue`] = SCRIPT;
    const result = await detect(files);
    assert.equal(result.confidence, 0.8);
  });
});
