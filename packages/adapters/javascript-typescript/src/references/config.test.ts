import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef } from "@ghostdeps/core";
import { memoryHandle } from "../testing/fs-handle.js";
import { MAX_CONFIG_BYTES, expandShorthand, findConfigUsages, packageOf } from "./config.js";

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
