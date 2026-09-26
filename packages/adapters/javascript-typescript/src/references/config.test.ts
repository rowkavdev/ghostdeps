import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { memoryHandle } from "../testing/fs-handle.js";
import {
  MAX_CONFIG_BYTES,
  MAX_CONFIG_STRING_NOTES,
  configStringNotes,
  expandShorthand,
  findConfigUsages,
  packageOf,
  unreadConfigs,
} from "./config.js";

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
const unread = async (context: AdapterContext, path = ".") =>
  (await unreadConfigs(context, dep("anything", path))).map((u) => `${u.file}:${u.reason}`).sort();
const via = async (context: AdapterContext, name: string, path = ".") =>
  (await findConfigUsages(context, dep(name, path))).map((u) => [u.via, u.file, u.line]);

describe("name helpers", () => {
  it("packageOf strips subpaths and rejects paths", () => {
    assert.equal(packageOf("@scope/pkg/sub"), "@scope/pkg");
    assert.equal(packageOf("ts-jest/presets/x"), "ts-jest");
    assert.equal(packageOf("./local"), undefined);
    assert.equal(packageOf("<rootDir>/x"), undefined);
  });

  it("expandShorthand follows tool naming rules", () => {
    assert.deepEqual(expandShorthand("react", "eslint-plugin"), ["react", "eslint-plugin-react"]);
    assert.deepEqual(expandShorthand("@typescript-eslint", "eslint-plugin"), [
      "@typescript-eslint/eslint-plugin",
    ]);
    assert.ok(expandShorthand("@babel/env", "babel-preset").includes("@babel/preset-env"));
    assert.deepEqual(expandShorthand("eslint-config-airbnb", "eslint-config"), [
      "eslint-config-airbnb",
    ]);
  });
});

describe("findConfigUsages", () => {
  it("config-only dependencies get via=config usage with the referencing line", async () => {
    const context = ctx({
      "package.json": JSON.stringify({ name: "app" }),
      ".eslintrc.json": `{\n  // legacy config\n  "extends": ["airbnb", "plugin:react/recommended"],\n  "plugins": ["@typescript-eslint"],\n  "parser": "@typescript-eslint/parser"\n}`,
      "tsconfig.json": `{"compilerOptions": {"types": ["node", "vitest/globals"]}}`,
    });
    assert.deepEqual(await via(context, "eslint-config-airbnb"), [["config", ".eslintrc.json", 3]]);
    assert.deepEqual(await via(context, "eslint-plugin-react"), [["config", ".eslintrc.json", 3]]);
    assert.deepEqual(await via(context, "@typescript-eslint/eslint-plugin"), [
      ["config", ".eslintrc.json", 4],
    ]);
    assert.deepEqual(await via(context, "@typescript-eslint/parser"), [
      ["config", ".eslintrc.json", 5],
    ]);
    assert.deepEqual(await via(context, "@types/node"), [["config", "tsconfig.json", 1]]);
    assert.deepEqual(await via(context, "vitest"), [["config", "tsconfig.json", 1]]);
    assert.deepEqual(await via(context, "lodash"), []);
  });

  it("reads package.json-embedded configs (babel, jest, prettier) and YAML rc files", async () => {
    const context = ctx({
      "package.json": JSON.stringify(
        {
          babel: { presets: [["@babel/env", { targets: "defaults" }]] },
          jest: { preset: "ts-jest", testEnvironment: "jsdom" },
          prettier: "@acme/prettier-config",
        },
        null,
        2,
      ),
      ".stylelintrc": "extends:\n  - standard\n",
    });
    assert.equal((await via(context, "@babel/preset-env")).length, 1);
    assert.equal((await via(context, "ts-jest")).length, 1);
    assert.equal((await via(context, "jest-environment-jsdom")).length, 1);
    assert.equal((await via(context, "@acme/prettier-config")).length, 1);
    assert.deepEqual(await via(context, "stylelint-config-standard"), [
      ["config", ".stylelintrc", 2],
    ]);
  });

  it("conventions: a tool's own config file, directory or package.json key", async () => {
    const context = ctx({
      "package.json": JSON.stringify({ "lint-staged": { "*.ts": "eslint" } }),
      ".husky/pre-commit": "npx lint-staged",
      "tailwind.config.ts": "export default {}",
    });
    assert.deepEqual(await via(context, "husky"), [["convention", ".husky/pre-commit", 1]]);
    assert.deepEqual(await via(context, "tailwindcss"), [["convention", "tailwind.config.ts", 1]]);
    assert.deepEqual(await via(context, "lint-staged"), [["convention", "package.json", 1]]);
  });

  it("is scoped to the dependency's own project directory", async () => {
    const context = ctx({
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/a/.babelrc": `{"plugins": ["macros"]}`,
    });
    assert.equal((await via(context, "babel-plugin-macros", "packages/a")).length, 1);
    assert.deepEqual(await via(context, "babel-plugin-macros"), []);
  });

  it("malformed, oversized and hostile configs add nothing and never throw", async () => {
    const context = ctx({
      "package.json": "{",
      ".eslintrc.json": `{"extends": `,
      ".babelrc": " ".repeat(MAX_CONFIG_BYTES + 1),
      "tsconfig.json": `{"compilerOptions": {"types": {"__proto__": ["x"]}}}`,
      ".prettierrc.yaml": "a: &a [*a]\n",
    });
    for (const name of ["x", "eslint-config-x", "prettier"]) {
      const usages = await findConfigUsages(context, dep(name));
      assert.ok(
        usages.every((u) => u.via === "convention"),
        name,
      );
    }
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });
});

describe("unreadConfigs (coverage for referenceAnalysisComplete)", () => {
  it("is empty when every present config was parsed", async () => {
    const context = ctx({
      "package.json": `{"prettier": {"plugins": ["x"]}}`,
      ".eslintrc.json": `{"extends": ["airbnb"]}`,
      "tsconfig.json": `{"compilerOptions": {"types": ["node"]}}`,
      "src/index.ts": "export {};",
    });
    assert.deepEqual(await unread(context), []);
  });

  it("reports malformed, oversized and unparsed package.json", async () => {
    const context = ctx({
      "package.json": "{",
      ".eslintrc.json": `{"extends": `,
      ".babelrc": " ".repeat(MAX_CONFIG_BYTES + 1),
    });
    assert.deepEqual(await unread(context), [
      ".babelrc:oversized",
      ".eslintrc.json:malformed",
      "package.json:malformed",
    ]);
  });

  it("reads JS/TS tool configs statically; only unreadable ones are reported (#149)", async () => {
    const context = ctx({
      "package.json": "{}",
      "eslint.config.mjs": "export default [];",
      "vite.config.ts": "export default { plugins: [] } satisfies object;",
      ".prettierrc.cjs": "module.exports = {",
      "webpack.config.js": "module.exports = require(process.env.CONFIG);",
      "rollup.config.mjs": "const p = 'rollup-plugin-' + name; export default {};",
      "jest.config.js": "module.exports = require('./jest.shared');",
      "src/app.config.ts": "export const x = 1;",
    });
    assert.deepEqual(await unread(context), [
      ".prettierrc.cjs:malformed",
      "jest.config.js:imports local module",
      "rollup.config.mjs:computed specifier",
      "webpack.config.js:computed specifier",
    ]);
  });

  it("credits string literals in JS/TS configs with the tool's shorthand rules (#149)", async () => {
    const context = ctx({
      "package.json": "{}",
      ".eslintrc.cjs": `module.exports = {
  extends: ["airbnb", "plugin:react/recommended"],
  plugins: ["@typescript-eslint"],
  rules: { "@stylistic/indent": "error", "import/no-cycle": "off" },
};`,
      "babel.config.js": `module.exports = (api) => ({ presets: [["@babel/env", {}]] });`,
      "vite.config.ts": [
        `import { defineConfig } from "vite";`,
        `const root = \`\${__dirname}/src\`;`,
        `export default defineConfig({ optimizeDeps: { include: ["lodash-es"] }, root });`,
      ].join("\n"),
      "next.config.mjs": `import base from "../../eslint.config.js"; export default { transpilePackages: ["ui-kit"] };`,
    });
    // vite.config imports the "vite" package and there is no lockfile.
    assert.deepEqual(await unread(context), ["vite.config.ts:imports shared config package"]);
    assert.deepEqual(await via(context, "eslint-config-airbnb"), [["config", ".eslintrc.cjs", 2]]);
    assert.deepEqual(await via(context, "eslint-plugin-react"), [["config", ".eslintrc.cjs", 2]]);
    assert.deepEqual(await via(context, "@typescript-eslint/eslint-plugin"), [
      ["config", ".eslintrc.cjs", 3],
    ]);
    // A rule id is not a package reference.
    assert.deepEqual(await via(context, "@stylistic/eslint-plugin"), []);
    assert.deepEqual(await via(context, "eslint-plugin-import"), []);
    assert.deepEqual(await via(context, "@babel/preset-env"), [["config", "babel.config.js", 1]]);
    assert.deepEqual(await via(context, "lodash-es"), [["config", "vite.config.ts", 3]]);
    assert.deepEqual(await via(context, "ui-kit"), [["config", "next.config.mjs", 1]]);
    // vite.config's own strings get no eslint-style expansion.
    assert.deepEqual(await via(context, "eslint-plugin-lodash-es"), []);
  });

  it("workspace members inherit root configs: references and coverage gaps", async () => {
    const context = ctx({
      "package.json": "{}",
      ".eslintrc.json": `{"plugins": ["import"]}`,
      "eslint.config.js": "export default [;",
      "packages/a/package.json": "{}",
    });
    assert.deepEqual(await via(context, "eslint-plugin-import", "packages/a"), [
      ["config", ".eslintrc.json", 1],
    ]);
    assert.deepEqual(await unread(context, "packages/a"), ["eslint.config.js:malformed"]);
  });
});

describe("JS/TS config string contract (#149, lead guardrails)", () => {
  it("a declared dep named only inside a config string is credited via=config", async () => {
    const context = ctx({
      "package.json": "{}",
      "vite.config.ts": `export default { optimizeDeps: { include: ["only-in-config"] } };`,
    });
    assert.deepEqual(await via(context, "only-in-config"), [["config", "vite.config.ts", 1]]);
  });

  it("outside a tool's own config, matching is exact: no subpath, prefix or substring", async () => {
    const context = ctx({
      "package.json": "{}",
      "vite.config.ts": `export default { a: "pkg/sub", b: "prefix-pkg", c: "some pkg", d: "@s/p/x" };`,
    });
    for (const name of ["pkg", "prefix", "@s/p", "some"])
      assert.deepEqual(await via(context, name), []);
    assert.deepEqual(await via(context, "prefix-pkg"), [["config", "vite.config.ts", 1]]);
  });

  // The documented shorthands, and only in the tool's own config files.
  const shorthands = [
    [".eslintrc.cjs", "airbnb", "eslint-config-airbnb"],
    ["eslint.config.js", "react", "eslint-plugin-react"],
    ["eslint.config.js", "plugin:react/recommended", "eslint-plugin-react"],
    ["eslint.config.js", "@scope", "@scope/eslint-plugin"],
    ["eslint.config.js", "@scope/foo", "@scope/eslint-config-foo"],
    ["babel.config.js", "@babel/env", "@babel/preset-env"],
    [".babelrc.js", "module:metro", "babel-preset-metro"],
    ["babel.config.cjs", "transform-runtime", "babel-plugin-transform-runtime"],
    ["stylelint.config.mjs", "standard", "stylelint-config-standard"],
    ["commitlint.config.js", "conventional", "commitlint-config-conventional"],
    ["jest.config.ts", "jsdom", "jest-environment-jsdom"],
  ] as const;
  for (const [config, value, pkg] of shorthands) {
    it(`${config}: "${value}" credits ${pkg}; the same string in vite.config.ts does not`, async () => {
      const text = `export default { x: ${JSON.stringify(value)} };`;
      assert.deepEqual(await via(ctx({ "package.json": "{}", [config]: text }), pkg), [
        ["config", config, 1],
      ]);
      assert.deepEqual(await via(ctx({ "package.json": "{}", "vite.config.ts": text }), pkg), []);
    });
  }

  it("a plugin map names packages as identifier keys: postcss.config.js plugins (#397)", async () => {
    const context = ctx({
      "package.json": "{}",
      "postcss.config.js":
        "module.exports = {\n  plugins: {\n    autoprefixer: {},\n    'postcss-preset-env': {},\n  },\n};",
    });
    assert.deepEqual(await via(context, "autoprefixer"), [["config", "postcss.config.js", 3]]);
    assert.deepEqual(await via(context, "postcss-preset-env"), [
      ["config", "postcss.config.js", 4],
    ]);
  });

  it("shorthand properties are not credited by key; their own require is (#397)", async () => {
    const context = ctx({
      "package.json": "{}",
      "postcss.config.js":
        'const autoprefixer = require("autoprefixer");\nmodule.exports = { plugins: { autoprefixer } };',
    });
    const usages = await findConfigUsages(context, dep("autoprefixer"));
    assert.equal(usages.length, 1);
    assert.equal(usages[0]!.symbols[0], "postcss.config import");
  });

  it("object keys match exactly: no subpath, prefix or case-folded credit (#397)", async () => {
    const context = ctx({
      "package.json": "{}",
      "postcss.config.js": "module.exports = { plugins: { autoprefixer: {}, AutoPrefixer: {} } };",
    });
    assert.deepEqual(await via(context, "autoprefixer"), [["config", "postcss.config.js", 1]]);
    assert.deepEqual(await via(context, "prefixer"), []);
    assert.deepEqual(await via(context, "autoprefix"), []);
  });

  it("a config importing a package is unread without a lockfile, read with one (#201 review)", async () => {
    const files = {
      "package.json": JSON.stringify({
        devDependencies: { "@acme/eslint-config": "1.0.0", globals: "1.0.0" },
      }),
      "eslint.config.js": `import acme from "@acme/eslint-config";\nimport path from "node:path";\nexport default [...acme];`,
    };
    assert.deepEqual(await unread(ctx(files)), ["eslint.config.js:imports shared config package"]);
    const lock = JSON.stringify({
      name: "x",
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { "@acme/eslint-config": "1.0.0", globals: "1.0.0" } },
        "node_modules/@acme/eslint-config": {
          version: "1.0.0",
          dev: true,
          peerDependencies: { globals: "*" },
        },
        "node_modules/globals": { version: "1.0.0", dev: true },
      },
    });
    assert.deepEqual(await unread(ctx({ ...files, "package-lock.json": lock })), []);
    // yarn.lock graphs carry no peer edges (classic never records them).
    const yarnLock = [
      "# yarn lockfile v1",
      "",
      '"@acme/eslint-config@1.0.0":',
      '  version "1.0.0"',
      "",
      "globals@1.0.0:",
      '  version "1.0.0"',
      "",
    ].join("\n");
    assert.deepEqual(await unread(ctx({ ...files, "yarn.lock": yarnLock })), [
      "eslint.config.js:imports shared config package",
    ]);
    // Only builtins and local configs imported: read regardless of a lockfile.
    assert.deepEqual(
      await unread(
        ctx({
          "package.json": "{}",
          "eslint.config.js": `import path from "node:path"; export default [];`,
        }),
      ),
      [],
    );
  });
});

describe("nested configs and discovery conventions", () => {
  it("reads nested tsconfig variants and per-folder configs, but not a member project's", async () => {
    const context = ctx({
      "package.json": "{}",
      "test/types/tsconfig.json": `{"extends": "fastify-tsconfig"}`,
      "tsconfig.build.json": `{"extends": "@tsconfig/node22/tsconfig.json"}`,
      "packages/a/package.json": "{}",
      "packages/a/.eslintrc.json": `{"plugins": ["only-a"]}`,
    });
    assert.deepEqual(await via(context, "fastify-tsconfig"), [
      ["config", "test/types/tsconfig.json", 1],
    ]);
    assert.deepEqual(await via(context, "@tsconfig/node22"), [
      ["config", "tsconfig.build.json", 1],
    ]);
    assert.deepEqual(await via(context, "eslint-plugin-only-a"), []);
  });

  it("known JS tool configs are read at any depth; other nested *.config.ts are source", async () => {
    const context = ctx({
      "package.json": "{}",
      "test/bundler/webpack.config.js": "module.exports = require(dynamic);",
      "src/app.config.ts": "export const x = 1;",
    });
    assert.deepEqual(
      (await unreadConfigs(context, dep("x"))).map((u) => `${u.file}:${u.reason}`),
      ["test/bundler/webpack.config.js:computed specifier"],
    );
  });

  it("size-limit credits discovered @size-limit/* presets; simple-git-hooks key is a convention", async () => {
    const context = ctx({
      "package.json": JSON.stringify({
        "size-limit": [],
        "simple-git-hooks": { "pre-commit": "x" },
      }),
    });
    assert.deepEqual(await via(context, "@size-limit/preset-small-lib"), [
      ["convention", "package.json", 1],
    ]);
    assert.deepEqual(await via(context, "simple-git-hooks"), [["convention", "package.json", 1]]);
    assert.deepEqual(await via(context, "@size-limitx/other"), []);
  });
});

describe("config-string capability notes (#205, #201 follow-up)", () => {
  const none = async () => false;
  it("one note per string-credited dependency, naming the first string; none for other config refs", async () => {
    const context = ctx({
      "package.json": "{}",
      "vite.config.ts": `export default {\n  optimizeDeps: { include: ["only-in-config"] },\n  x: "only-in-config",\n};`,
      "next.config.mjs": `export default { transpilePackages: ["ui-kit"] };`,
      ".eslintrc.json": `{"plugins": ["import"]}`,
    });
    const notes = await configStringNotes(
      context,
      [dep("only-in-config"), dep("ui-kit"), dep("eslint-plugin-import"), dep("not-referenced")],
      none,
    );
    assert.deepEqual(notes, [
      {
        dependency: "only-in-config",
        statement:
          "credited by a string in vite.config.ts:2 (+ 1 more); JS/TS config files are read statically for package names, never run",
      },
      {
        dependency: "ui-kit",
        statement:
          "credited by a string in next.config.mjs:1; JS/TS config files are read statically for package names, never run",
      },
    ]);
  });

  it("a name declared in several projects gets one note; unreadable configs give none", async () => {
    const context = ctx({
      "package.json": "{}",
      "vite.config.ts": `export default { include: ["shared"] };`,
      "packages/a/package.json": "{}",
      "packages/a/vite.config.ts": `export default { include: ["shared"] };`,
      "packages/b/package.json": "{}",
      "packages/b/vite.config.ts": "export default [;",
    });
    const notes = await configStringNotes(
      context,
      [dep("shared"), dep("shared", "packages/a"), dep("broken-only", "packages/b")],
      none,
    );
    assert.deepEqual(
      notes.map((n) => [n.dependency, n.statement.split(";")[0]]),
      [["shared", "credited by a string in packages/a/vite.config.ts:1 (+ 1 more)"]],
    );
  });

  it("judged per declaring project: strings from a project with other usage are not cited", async () => {
    const context = ctx({
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/a/vite.config.ts": `export default { include: ["both"] };`,
      "packages/b/package.json": "{}",
      "packages/b/vite.config.ts": `export default { include: ["both", "used"] };`,
    });
    const seen: string[][] = [];
    const notes = await configStringNotes(
      context,
      [dep("both", "packages/a"), dep("both", "packages/b"), dep("used", "packages/b")],
      async (d, strings) => {
        seen.push([d.name, d.project.path, [...strings].join(",")]);
        return d.project.path === "packages/b";
      },
    );
    assert.deepEqual(notes, [
      {
        dependency: "both",
        statement:
          "credited by a string in packages/a/vite.config.ts:1; JS/TS config files are read statically for package names, never run",
      },
    ]);
    // Each project is checked with its own credited strings.
    assert.deepEqual(seen, [
      ["both", "packages/a", "packages/a/vite.config.ts:1"],
      ["both", "packages/b", "packages/b/vite.config.ts:1"],
      ["used", "packages/b", "packages/b/vite.config.ts:1"],
    ]);
  });

  it("an import in a config is real usage: credited, but never a string-only note", async () => {
    const context = ctx({
      "package.json": "{}",
      "vite.config.ts": `import { URL } from "url";\nconst r = require("req-pkg");\nexport default { alias: { x: "str-pkg" } };`,
    });
    assert.deepEqual(await via(context, "url"), [["config", "vite.config.ts", 1]]);
    assert.deepEqual(await via(context, "req-pkg"), [["config", "vite.config.ts", 2]]);
    const notes = await configStringNotes(
      context,
      [dep("url"), dep("req-pkg"), dep("str-pkg")],
      none,
    );
    assert.deepEqual(
      notes.map((n) => n.dependency),
      ["str-pkg"],
    );
  });

  it("bounded per run", async () => {
    const names = Array.from({ length: MAX_CONFIG_STRING_NOTES + 5 }, (_, i) => `p${i}`);
    const context = ctx({
      "package.json": "{}",
      "vite.config.ts": `export default { include: ${JSON.stringify(names)} };`,
    });
    const notes = await configStringNotes(
      context,
      names.map((n) => dep(n)),
      none,
    );
    assert.equal(notes.length, MAX_CONFIG_STRING_NOTES);
  });
});
