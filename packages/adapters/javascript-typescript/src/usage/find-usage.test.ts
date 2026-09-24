import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_FILE_READ_BYTES } from "@ghostdeps/core";
import type { AdapterContext, Dependency, ProjectRef, SourceLineChanges } from "@ghostdeps/core";
import { fixtureHandle, memoryHandle } from "../testing/fs-handle.js";
import { MAX_SCRIPT_BLOCKS_PER_FILE } from "./embedded.js";
import {
  MAX_SOURCE_BYTES,
  MAX_OUTSIDE_PROJECT_RECORDS,
  MAX_UNRESOLVED_PER_FILE,
  findRemovedUsages,
  findUsage,
  usageLimitations,
} from "./find-usage.js";

const project = (path: string): ProjectRef => ({
  path,
  ecosystem: "javascript-typescript",
  packageManagers: [],
});
const dep = (name: string, path = "."): Dependency => ({
  name,
  constraint: "*",
  kind: "runtime",
  project: project(path),
  declaredIn: path === "." ? "package.json" : `${path}/package.json`,
});
const ctx = (files: Record<string, string>): AdapterContext => ({
  repository: memoryHandle(files),
  network: { mode: "offline" },
});

describe("findUsage", () => {
  it("fixture js/basic-unused: left-pad has no usage", async () => {
    const context: AdapterContext = {
      repository: fixtureHandle("js", "basic-unused"),
      network: { mode: "offline" },
    };
    assert.deepEqual(await findUsage(context, dep("left-pad")), []);
  });

  it("fixture js/usage-static-and-require: every form is found with file/line", async () => {
    const context: AdapterContext = {
      repository: fixtureHandle("js", "usage-static-and-require"),
      network: { mode: "offline" },
    };
    const axios = await findUsage(context, dep("axios"));
    assert.deepEqual(
      axios.map((u) => [u.file, u.line, u.form]),
      [["src/client.ts", 1, "static"]],
    );
    assert.deepEqual(axios[0]?.symbols, ["default", "get", "post"]);
    const uuid = await findUsage(context, dep("uuid"));
    assert.deepEqual(
      uuid.map((u) => [u.file, u.form, u.symbols]),
      [["src/ids.cjs", "require", ["v4"]]],
    );
    const scoped = await findUsage(context, dep("@scope/util"));
    assert.deepEqual(
      scoped.map((u) => u.file),
      ["src/client.ts"],
    );
    assert.deepEqual(await findUsage(context, dep("left-pad")), []);
  });

  it("fixture js/usage-dynamic: literal import() is usage, non-literal is a limitation", async () => {
    const context: AdapterContext = {
      repository: fixtureHandle("js", "usage-dynamic"),
      network: { mode: "offline" },
    };
    const dayjs = await findUsage(context, dep("dayjs"));
    assert.deepEqual(
      dayjs.map((u) => u.form),
      ["dynamic"],
    );
    const limits = await usageLimitations(context, ".");
    assert.ok(limits.some((e) => e.kind === "dynamic-import-unresolved" && e.line === 5));
  });

  it("attributes files to the nearest workspace package", async () => {
    const context = ctx({
      "package.json": "{}",
      "index.js": `require("root-only");`,
      "packages/a/package.json": JSON.stringify({
        dependencies: { "root-only": "1", "a-only": "1" },
      }),
      "packages/a/src/x.ts": `import "a-only";\nimport "root-only";`,
    });
    assert.deepEqual(
      (await findUsage(context, dep("root-only"))).map((u) => u.file),
      ["index.js"],
    );
    assert.deepEqual(
      (await findUsage(context, dep("root-only", "packages/a"))).map((u) => u.file),
      ["packages/a/src/x.ts"],
    );
    assert.deepEqual(await findUsage(context, dep("a-only")), []);
  });

  it("credits an ancestor project's declaration from nested projects that do not declare it (vite)", async () => {
    const context = ctx({
      "package.json": JSON.stringify({ devDependencies: { execa: "1", shared: "1" } }),
      "packages/a/package.json": JSON.stringify({ dependencies: { shared: "1" } }),
      "packages/a/__tests__/cli.spec.ts": `import { execaCommandSync } from "execa";\nimport "shared";`,
      "packages/a/b/package.json": "{}",
      "packages/a/b/t.ts": `import "shared";`,
    });
    // execa: undeclared in packages/a, so it resolves to the root's copy.
    assert.deepEqual(
      (await findUsage(context, dep("execa"))).map((u) => u.file),
      ["packages/a/__tests__/cli.spec.ts"],
    );
    // shared: packages/a declares it, so packages/a and packages/a/b resolve to packages/a, not the root.
    assert.deepEqual(await findUsage(context, dep("shared")), []);
    assert.deepEqual(
      (await findUsage(context, dep("shared", "packages/a"))).map((u) => u.file),
      ["packages/a/__tests__/cli.spec.ts", "packages/a/b/t.ts"],
    );
  });

  it("nested projects' limitations weaken an ancestor's completeness, never a sibling's", async () => {
    const context = ctx({
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/a/x.js": `require(name);`,
      "packages/b/package.json": "{}",
    });
    const kinds = async (p: string) =>
      (await usageLimitations(context, p)).map((e) => `${e.kind}:${e.file}`);
    assert.deepEqual(await kinds("."), ["dynamic-import-unresolved:packages/a/x.js"]);
    assert.deepEqual(await kinds("packages/a"), ["dynamic-import-unresolved:packages/a/x.js"]);
    assert.deepEqual(await kinds("packages/b"), []);
    const [propagated] = await usageLimitations(context, ".");
    assert.match(
      propagated!.statement,
      /import gap in nested project packages\/a; it can fall through to the root project/,
    );
    const [own] = await usageLimitations(context, "packages/a");
    assert.doesNotMatch(own!.statement, /nested project/);
  });

  it("a gap in a project never reaches its nested projects (no downward propagation)", async () => {
    const context = ctx({
      "package.json": "{}",
      "index.js": `require(name);`,
      "packages/a/package.json": "{}",
      "packages/a/x.js": `import "ok";`,
    });
    assert.deepEqual(await usageLimitations(context, "packages/a"), []);
    assert.equal((await usageLimitations(context, ".")).length, 1);
  });

  it("@types/foo is used wherever foo is referenced, even when foo is not declared (pnpapi)", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        devDependencies: { "@types/pnpapi": "1", "@types/babel__core": "1" },
      }),
      "src/packages.ts": [
        `import { createRequire } from "node:module";`,
        `let pnp: typeof import("pnpapi") | undefined;`,
        `pnp = createRequire(import.meta.url)("pnpapi");`,
      ].join("\n"),
      "src/b.ts": `import type { TransformOptions } from "@babel/core";`,
    });
    const pnp = await findUsage(context, dep("@types/pnpapi"));
    assert.deepEqual(
      pnp.map((u) => [u.line, u.typeOnly]),
      [
        [2, true],
        [3, true],
      ],
    );
    assert.deepEqual(
      (await findUsage(context, dep("@types/babel__core"))).map((u) => u.file),
      ["src/b.ts"],
    );
  });

  it("scans script blocks in HTML pages and Vue, Svelte and Astro components (vite)", async () => {
    const context = ctx({
      "package.json": "{}",
      "index.html": [
        "<!doctype html>",
        "<div>no imports here: import 'not-a-dep'</div>",
        '<script type="module">',
        "  import { createStore } from 'vuex'",
        "  import css from 'normalize.css?inline'",
        "</script>",
        '<script type="importmap">{"imports":{"ignored":"x"}}</script>',
        "<SCRIPT>require('classic')</SCRIPT>",
      ].join("\n"),
      "Community.vue": [
        '<script setup lang="ts">',
        "import { Icon } from '@iconify/vue'",
        "</script>",
        "<template><Icon /></template>",
      ].join("\n"),
      "App.svelte": `<script context="module">\nexport { x } from "svelte-dep";\n</script>\n<h1>hi</h1>`,
      "Page.astro": `---\nimport Layout from "astro-dep";\n---\n<Layout><script>import "astro-client-dep";</script></Layout>`,
    });
    const at = async (name: string) =>
      (await findUsage(context, dep(name))).map((u) => `${u.file}:${u.line}`);
    assert.deepEqual(await at("vuex"), ["index.html:4"]);
    assert.deepEqual(await at("normalize.css"), ["index.html:5"]);
    assert.deepEqual(await at("classic"), ["index.html:8"]);
    assert.deepEqual(await at("ignored"), []);
    assert.deepEqual(await at("not-a-dep"), []);
    assert.deepEqual(await at("@iconify/vue"), ["Community.vue:2"]);
    assert.deepEqual(await at("svelte-dep"), ["App.svelte:2"]);
    assert.deepEqual(await at("astro-dep"), ["Page.astro:2"]);
    assert.deepEqual(await at("astro-client-dep"), ["Page.astro:4"]);
  });

  it("bounds script blocks per file and reports the rest", async () => {
    const context = ctx({
      "package.json": "{}",
      "many.html": Array.from(
        { length: MAX_SCRIPT_BLOCKS_PER_FILE + 5 },
        (_, i) => `<script>import "p${i}"</script>`,
      ).join("\n"),
    });
    assert.equal((await findUsage(context, dep(`p${MAX_SCRIPT_BLOCKS_PER_FILE - 1}`))).length, 1);
    assert.deepEqual(await findUsage(context, dep(`p${MAX_SCRIPT_BLOCKS_PER_FILE}`)), []);
    const limits = await usageLimitations(context, ".");
    assert.ok(limits.some((e) => e.kind === "script-blocks-unscanned" && e.file === "many.html"));
  });

  it("marks type-only references with Usage.typeOnly and leaves runtime imports unmarked", async () => {
    const context = ctx({
      "package.json": "{}",
      "a.ts": [
        `import type { Config } from "vite";`,
        `export type { Plugin } from "vite";`,
        `type E = typeof import("esbuild");`,
        `import { build } from "esbuild";`,
        `import { type Schema, parse } from "zod";`,
      ].join("\n"),
    });
    const vite = await findUsage(context, dep("vite"));
    assert.deepEqual(
      vite.map((u) => [u.line, u.typeOnly]),
      [
        [1, true],
        [2, true],
      ],
    );
    const esbuild = await findUsage(context, dep("esbuild"));
    assert.deepEqual(
      esbuild.map((u) => [u.line, u.typeOnly]),
      [
        [3, true],
        [4, undefined],
      ],
    );
    // Inline `type` modifiers keep the import at runtime under verbatimModuleSyntax.
    const zod = await findUsage(context, dep("zod"));
    assert.equal(zod[0]?.typeOnly, undefined);
  });

  it("never scans node_modules and skips oversized files with a limitation", async () => {
    const context = ctx({
      "package.json": "{}",
      "node_modules/x/index.js": `require("hidden");`,
      "big.js": `require("big-dep");` + " ".repeat(MAX_SOURCE_BYTES),
    });
    assert.deepEqual(await findUsage(context, dep("hidden")), []);
    assert.deepEqual(await findUsage(context, dep("big-dep")), []);
    const limits = await usageLimitations(context, ".");
    assert.ok(limits.some((e) => e.kind === "file-too-large" && e.file === "big.js"));
  });

  it("does not execute anything: hostile source is parsed as text", async () => {
    const context = ctx({
      "package.json": "{}",
      "evil.js": `process.exit(1); require("child_process").execSync("touch /tmp/pwned"); import("pwn");`,
    });
    const usages = await findUsage(context, dep("pwn"));
    assert.equal(usages.length, 1);
  });

  it("skips core-excluded directories and minified bundles", async () => {
    const context = ctx({
      "package.json": "{}",
      "dist/index.js": `require("from-dist");`,
      "vendor/lib.js": `require("from-vendor");`,
      "public/app.min.js": `require("from-min");`,
      "src/index.js": `require("from-src");`,
    });
    for (const name of ["from-dist", "from-vendor", "from-min"]) {
      assert.deepEqual(await findUsage(context, dep(name)), [], name);
    }
    assert.equal((await findUsage(context, dep("from-src"))).length, 1);
  });

  it("does not attribute files outside every package.json project, and says so", async () => {
    const context = ctx({
      "scripts/tool.js": `require("stray");`,
      "packages/a/package.json": "{}",
      "packages/a/index.js": `require("stray");`,
    });
    assert.deepEqual(await findUsage(context, dep("stray")), []);
    assert.deepEqual(
      (await findUsage(context, dep("stray", "packages/a"))).map((u) => u.file),
      ["packages/a/index.js"],
    );
    const limits = await usageLimitations(context, "packages/a");
    assert.ok(
      limits.some((e) => e.kind === "file-outside-project" && e.file === "scripts/tool.js"),
    );
  });

  it("caps unresolved dynamic-import limitations per file and summarises the rest", async () => {
    const extra = 7;
    const lines = Array.from(
      { length: MAX_UNRESOLVED_PER_FILE + extra },
      (_, i) => `import(name${i});`,
    );
    const context = ctx({ "package.json": "{}", "many.js": lines.join("\n") });
    const limits = await usageLimitations(context, ".");
    assert.equal(
      limits.filter((e) => e.kind === "dynamic-import-unresolved").length,
      MAX_UNRESOLVED_PER_FILE,
    );
    const summary = limits.filter((e) => e.kind === "dynamic-import-unresolved-summary");
    assert.equal(summary.length, 1);
    assert.match(summary[0]!.statement, new RegExp(`^${extra} more`));
  });

  it("scopes the scan cache to the analysis context, not the handle", async () => {
    const files: Record<string, string> = { "package.json": "{}", "a.js": `require("first");` };
    const repository = memoryHandle(files);
    const job1: AdapterContext = { repository, network: { mode: "offline" } };
    assert.equal((await findUsage(job1, dep("first"))).length, 1);
    files["a.js"] = `require("second");`;
    // Same job: memoised. New job on the same long-lived handle: rescanned.
    assert.equal((await findUsage(job1, dep("second"))).length, 0);
    const job2: AdapterContext = { repository, network: { mode: "offline" } };
    assert.equal((await findUsage(job2, dep("second"))).length, 1);
    assert.equal((await findUsage(job2, dep("first"))).length, 0);
  });

  it("bounds outside-project limitations: 1,000 unowned files x 5 projects", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) files[`generated/f${i}.js`] = `require("x");`;
    const projects = ["a", "b", "c", "d", "e"].map((p) => `packages/${p}`);
    for (const p of projects) {
      files[`${p}/package.json`] = "{}";
      files[`${p}/index.js`] = `require("y");`;
    }
    const context = ctx(files);
    for (const p of projects) {
      const limits = await usageLimitations(context, p);
      const outside = limits.filter((e) => e.kind === "file-outside-project");
      assert.equal(outside.length, MAX_OUTSIDE_PROJECT_RECORDS, p);
      const summary = limits.filter((e) => e.kind === "file-outside-project-summary");
      assert.equal(summary.length, 1, p);
      assert.match(summary[0]!.statement, /^1000 source files/);
      assert.ok(limits.length <= MAX_OUTSIDE_PROJECT_RECORDS + 1, p);
    }
  });

  it("attributes unreadable and oversized files to their owning project only", async () => {
    const context = ctx({
      "packages/a/package.json": "{}",
      "packages/a/big.js": " ".repeat(MAX_SOURCE_BYTES + 1),
      "packages/b/package.json": "{}",
    });
    assert.ok(
      (await usageLimitations(context, "packages/a")).some((e) => e.kind === "file-too-large"),
    );
    assert.deepEqual(await usageLimitations(context, "packages/b"), []);
  });

  it("parse cap never exceeds core's read cap", () => {
    assert.ok(MAX_SOURCE_BYTES <= MAX_FILE_READ_BYTES);
  });

  it("fixture js/usage-path-aliases: aliases resolve to repo files, workspace deps keep usage", async () => {
    const context: AdapterContext = {
      repository: fixtureHandle("js", "usage-path-aliases"),
      network: { mode: "offline" },
    };
    // "utils/log" is a tsconfig alias to src/utils/log.ts, not the npm "utils" package.
    assert.deepEqual(await findUsage(context, dep("utils")), []);
    assert.deepEqual(
      (await findUsage(context, dep("zod"))).map((u) => u.file),
      ["src/index.ts"],
    );
    // The "*" -> node_modules fallback never hides real package usage.
    assert.equal((await findUsage(context, dep("zod"))).length, 1);
    // Workspace-internal package: imports stay usage of the declared workspace dep.
    assert.deepEqual(
      (await findUsage(context, dep("@acme/ui", "apps/web"))).map((u) => u.file),
      ["apps/web/src/page.tsx"],
    );
    // An alias in a package that extends the root base still resolves (no "@lib" package usage).
    assert.deepEqual(await findUsage(context, dep("@lib/db", "apps/web")), []);
  });

  it("aliases only hide specifiers that resolve to repository files", async () => {
    const context = ctx({
      "package.json": "{}",
      "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"lodash/*":["src/lodash/*"]}}}`,
      "src/lodash/local.ts": "",
      "a.ts": `import "lodash/local";\nimport "lodash/get";`,
    });
    assert.deepEqual(
      (await findUsage(context, dep("lodash"))).map((u) => u.line),
      [2],
    );
  });

  it("a malformed tsconfig is a limitation for its project and aliases are simply not applied", async () => {
    const context = ctx({
      "package.json": "{}",
      "tsconfig.json": `{"compilerOptions": `,
      "a.ts": `import "utils/x";`,
    });
    assert.equal((await findUsage(context, dep("utils"))).length, 1);
    const limits = await usageLimitations(context, ".");
    assert.ok(limits.some((e) => e.kind === "tsconfig-malformed" && e.file === "tsconfig.json"));
  });
});

describe("findRemovedUsages (#168, PR mode)", () => {
  const prCtx = (
    files: Record<string, string>,
    changes: SourceLineChanges[] | undefined,
  ): AdapterContext => ({
    repository: memoryHandle(files),
    network: { mode: "offline" },
    ...(changes ? { pullRequestSourceChanges: changes } : {}),
  });
  const removed = (path: string, lines: [number, string][]): SourceLineChanges => ({
    path,
    removedLines: lines.map(([line, text]) => ({ line, text })),
    addedLines: [],
  });
  const at = (u: { file: string; line: number; removedInPr?: boolean; form: string }[]) =>
    u.map((x) => `${x.file}:${x.line}:${x.form}:${x.removedInPr}`);

  it("is empty on full scans (no source changes)", async () => {
    const context = prCtx({ "package.json": "{}", "a.ts": `import "x";` }, undefined);
    assert.deepEqual(await findRemovedUsages(context, dep("x")), []);
  });

  it("marks static imports, re-exports and literal requires on removed lines", async () => {
    const context = prCtx({ "package.json": "{}", "src/a.ts": "" }, [
      removed("src/a.ts", [
        [3, `import d from "dropped";`],
        [7, `export { x } from "dropped/sub";`],
        [9, `const r = require("dropped");`],
        [10, `import k from "kept";`],
      ]),
    ]);
    assert.deepEqual(at(await findRemovedUsages(context, dep("dropped"))), [
      "src/a.ts:3:static:true",
      "src/a.ts:7:static:true",
      "src/a.ts:9:require:true",
    ]);
    assert.deepEqual(at(await findRemovedUsages(context, dep("kept"))), [
      "src/a.ts:10:static:true",
    ]);
  });

  it("recognises a multi-line import removed as consecutive lines", async () => {
    const context = prCtx({ "package.json": "{}" }, [
      removed("src/gone.ts", [
        [20, "import {"],
        [21, "  a,"],
        [22, "  b,"],
        [23, `} from "multi";`],
      ]),
    ]);
    const u = await findRemovedUsages(context, dep("multi"));
    assert.deepEqual(at(u), ["src/gone.ts:20:static:true"]);
    assert.deepEqual(u[0]?.symbols, ["a", "b"]);
  });

  it("never matches dynamic imports, strings, comments or non-source files", async () => {
    const context = prCtx({ "package.json": "{}" }, [
      removed("src/a.ts", [
        [1, `const m = await import("dyn");`],
        [2, `// import x from "commented";`],
        [3, `const s = "import y from 'stringy'";`],
        [4, `import(name);`],
      ]),
      removed("README.md", [[1, `import z from "docs";`]]),
    ]);
    for (const name of ["dyn", "commented", "stringy", "docs"]) {
      assert.deepEqual(await findRemovedUsages(context, dep(name)), [], name);
    }
  });

  it("ignores specifiers a tsconfig alias resolves to repository files (#29)", async () => {
    const context = prCtx(
      {
        "package.json": "{}",
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
        }),
        "src/db.ts": "export {};",
      },
      [removed("src/a.ts", [[1, `import db from "@app/db";`]])],
    );
    assert.deepEqual(await findRemovedUsages(context, dep("@app/db")), []);
  });

  it("follows project ownership: nearest declaring project, falling through to ancestors", async () => {
    const files = {
      "package.json": JSON.stringify({ devDependencies: { execa: "1", shared: "1" } }),
      "packages/a/package.json": JSON.stringify({ dependencies: { shared: "1" } }),
    };
    const context = prCtx(files, [
      removed("packages/a/t.ts", [
        [1, `import { execa } from "execa";`],
        [2, `import "shared";`],
      ]),
    ]);
    assert.deepEqual(at(await findRemovedUsages(context, dep("execa"))), [
      "packages/a/t.ts:1:static:true",
    ]);
    assert.deepEqual(await findRemovedUsages(context, dep("shared")), []);
    assert.deepEqual(at(await findRemovedUsages(context, dep("shared", "packages/a"))), [
      "packages/a/t.ts:2:static:true",
    ]);
  });

  it("hostile diff text is parsed, never executed", async () => {
    const context = prCtx({ "package.json": "{}" }, [
      removed("src/evil.js", [
        [1, `process.exit(1); require("child_process").execSync("touch /tmp/pwned");`],
      ]),
    ]);
    const u = await findRemovedUsages(context, dep("child_process"));
    assert.deepEqual(u, []);
  });
});
