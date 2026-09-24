import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { fixtureHandle, memoryHandle } from "../testing/fs-handle.js";
import { MAX_SOURCE_BYTES, findUsage, usageLimitations } from "./find-usage.js";

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
});
