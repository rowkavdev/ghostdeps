import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { memoryHandle } from "../testing/fs-handle.js";
import { analyseScript, commandWords, findScriptUsages, mentions, scriptGaps } from "./scripts.js";

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

  it("removes shell line continuations before finding command words", () => {
    assert.deepEqual(commandWords("npx \\\n tsc -b"), ["tsc"]);
    assert.deepEqual(commandWords("cross-env \\\n FOO=1 tsc -b"), ["cross-env", "tsc"]);
    assert.deepEqual(commandWords("ts\\\nc -b"), ["tsc"]);
    assert.deepEqual(commandWords('sh -c "ts\\\nc -b"'), ["tsc"]);
    assert.deepEqual(commandWords("'ts\\\nc' -b"), ["ts\\\nc"]);
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

  it("treats a nodemon script file as a file gap, not a command (#858)", () => {
    const a = analyseScript("nodemon -w src server.js --port 3000");
    assert.deepEqual(a.words, ["nodemon"]);
    assert.deepEqual(a.gaps, ["nodemon runs server.js; commands it spawns are not read"]);
    assert.deepEqual(analyseScript("nodemon").gaps, []);
    assert.deepEqual(commandWords('nodemon --exec "ts-node src/index.ts"'), ["nodemon", "ts-node"]);
  });

  it("reads a cross-env-shell command string as commands (#858)", () => {
    assert.deepEqual(commandWords('cross-env-shell NODE_ENV=test "tsc -b && vitest run"'), [
      "cross-env-shell",
      "tsc",
      "vitest",
    ]);
    assert.deepEqual(commandWords("cross-env-shell FOO=1 eslint ."), ["cross-env-shell", "eslint"]);
    assert.deepEqual(commandWords("cross-env FOO=1 jest"), ["cross-env", "jest"]);
  });

  it("reads concurrently's quoted arguments as commands", () => {
    assert.deepEqual(commandWords('concurrently -k -s first "tsc -w" "autocannon -c 100 x"'), [
      "concurrently",
      "tsc",
      "autocannon",
    ]);
    assert.deepEqual(commandWords('conc "npm:lint" "vitest"'), ["conc", "vitest"]);
    assert.deepEqual(analyseScript('concurrently --weird "tsc"').gaps, [
      "concurrently: unrecognised flag --weird",
    ]);
  });

  it("mentions finds a package named anywhere, including subpaths", () => {
    assert.deepEqual(
      mentions("borp --reporter=@jsumners/line-reporter", "@jsumners/line-reporter"),
      ["@jsumners/line-reporter"],
    );
    assert.deepEqual(mentions("NODE_OPTIONS='--import=tsx/esm' ava", "tsx"), ["tsx/esm"]);
    assert.deepEqual(mentions("node -r ts-node/register x.ts", "ts-node"), ["ts-node/register"]);
    assert.deepEqual(mentions("tsxx build", "tsx"), []);
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
    const clean = ctx({
      "package.json": JSON.stringify({
        scripts: { b: "tsc && rm -rf tmp", t: "vitest" },
        devDependencies: { typescript: "5", vitest: "2" },
      }),
    });
    assert.deepEqual(await scriptGaps(clean, dep("typescript")), []);
    const gappy = ctx({
      "package.json": JSON.stringify({
        scripts: { b: "tsc", ci: "sh ci.sh" },
        devDependencies: { typescript: "5" },
      }),
    });
    assert.deepEqual(await scriptGaps(gappy, dep("typescript")), [
      'package.json script "ci": sh runs ci.sh, which is not read',
    ]);
  });

  it("workspace members inherit root scripts: usages and gaps", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        scripts: { lint: "eslint .", gen: "sh gen.sh" },
        devDependencies: { eslint: "9" },
      }),
      "packages/a/package.json": JSON.stringify({
        scripts: { t: "vitest" },
        devDependencies: { vitest: "2" },
      }),
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

  it("a command no declared dependency's bin explains is a gap when bins are guessed", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        scripts: { up: "ncu -u", fmt: "prettier -w ." },
        devDependencies: { "npm-check-updates": "17", prettier: "3" },
      }),
    });
    assert.deepEqual(await scriptGaps(context, dep("prettier")), [
      'package.json script "up": command "ncu" is not matched to a declared dependency\'s bin',
    ]);
  });

  it("yarn/pnpm calls to the manifest's own scripts are not unmatched commands", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        scripts: { lint: "eslint .", "test:unit": "vitest", ci: "yarn lint && pnpm test:unit" },
        devDependencies: { eslint: "9", vitest: "2" },
      }),
    });
    assert.deepEqual(await scriptGaps(context, dep("eslint")), []);
  });

  it("with lockfile bin data for every dependency, unmatched commands are global tools", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        scripts: { up: "ncu -u", ship: "flyctl deploy" },
        devDependencies: { "npm-check-updates": "17" },
      }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/npm-check-updates": { version: "17.1.0", bin: { ncu: "b.js" } },
        },
      }),
    });
    assert.deepEqual(await scriptGaps(context, dep("npm-check-updates")), []);
    assert.deepEqual(
      (await findScriptUsages(context, dep("npm-check-updates"))).map((u) => u.symbols),
      [["ncu"]],
    );
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

  it("credits a bin after a shell line continuation without an unmatched gap", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        scripts: { build: "npx \\\n tsc -b" },
        devDependencies: { typescript: "5" },
      }),
    });
    assert.deepEqual(
      (await findScriptUsages(context, dep("typescript"))).map((u) => u.symbols),
      [["tsc"]],
    );
    assert.deepEqual(await scriptGaps(context, dep("typescript")), []);
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

it("respects backslash parity before LF inside double quotes", () => {
  for (const count of [1, 2, 3, 4]) {
    const script = '"ts' + "\\".repeat(count) + '\nc" -b';
    const expected = "ts" + "\\".repeat(Math.floor(count / 2)) + (count % 2 ? "" : "\n") + "c";
    assert.deepEqual(commandWords(script), [expected]);
  }
});

it("finds bins dispatched through yarn workspace", () => {
  assert.deepEqual(commandWords("yarn workspace web tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords("yarn --cwd . workspace web exec tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords("yarn workspace web run build"), []);
  assert.deepEqual(commandWords("yarn workspace web add react"), []);
});

it("credits a workspace-dispatched TypeScript bin in the root script", async () => {
  const context = ctx({
    "package.json": JSON.stringify({
      scripts: { build: "yarn workspace web tsc -b" },
      devDependencies: { typescript: "5" },
    }),
  });
  assert.deepEqual(
    (await findScriptUsages(context, dep("typescript"))).map((u) => u.symbols),
    [["tsc"]],
  );
  assert.deepEqual(await scriptGaps(context, dep("typescript")), []);
});

it("skips Yarn flags after the workspace selector before the dispatched bin", () => {
  assert.deepEqual(commandWords("yarn workspace web --silent tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords("yarn workspace web --cwd ./web exec tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords("yarn workspace web --silent run build"), []);
});

it("finds npm exec command words after package and call options", () => {
  assert.deepEqual(commandWords("npm exec --package typescript -- tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords("npm exec --package=typescript -- tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords('npm exec --package typescript -c "tsc -b"'), ["tsc"]);
  assert.deepEqual(commandWords("npm exec --yes -- tsc -b"), ["tsc"]);
});

it("credits npm exec's actual command rather than its package option", async () => {
  const context = ctx({
    "package.json": JSON.stringify({
      scripts: { build: "npm exec --package typescript -- tsc -b" },
      devDependencies: { typescript: "5" },
    }),
  });
  assert.deepEqual(
    (await findScriptUsages(context, dep("typescript"))).map((u) => u.symbols),
    [["tsc", "typescript"]],
  );
  assert.deepEqual(await scriptGaps(context, dep("typescript")), []);
});

it("handles npm exec's short package alias without crediting the option value as a bin", () => {
  assert.deepEqual(commandWords("npm exec -p typescript -- tsc -b"), ["tsc"]);
  assert.deepEqual(commandWords("npm exec -p=typescript -- tsc -b"), ["tsc"]);
});

describe("shell keywords and wrappers", () => {
  const words = (s: string) => analyseScript(s).words;
  it("reads the command after if/then/else/do/!/{", () => {
    assert.deepEqual(words("if tsc -p .; then eslint .; else prettier .; fi"), [
      "tsc",
      "eslint",
      "prettier",
    ]);
    assert.deepEqual(words("! tsc -p ."), ["tsc"]);
    assert.deepEqual(words("while true; do vitest; done"), ["true", "vitest"]);
    assert.deepEqual(words("{ tsc -p .; }"), ["tsc"]);
  });
  it("ignores loop headers and closers", () => {
    assert.deepEqual(words("for f in a b; do eslint $f; done"), ["eslint"]);
    assert.deepEqual(analyseScript("for f in a b; do eslint $f; done").gaps, []);
  });
  it("sees through xargs and sudo", () => {
    assert.deepEqual(words("xargs -n 1 tsc"), ["tsc"]);
    assert.deepEqual(words("sudo -u root eslint ."), ["eslint"]);
  });
});
