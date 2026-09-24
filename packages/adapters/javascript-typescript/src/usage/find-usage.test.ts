import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_FILE_READ_BYTES } from "@ghostdeps/core";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { fixtureHandle, memoryHandle } from "../testing/fs-handle.js";
import {
  MAX_SOURCE_BYTES,
  MAX_OUTSIDE_PROJECT_RECORDS,
  MAX_UNRESOLVED_PER_FILE,
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
      "packages/a/package.json": "{}",
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
