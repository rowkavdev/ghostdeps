import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanSource } from "./scan.js";

const byPkg = (file: string, text: string) =>
  scanSource(file, text).references.filter((r) => r.packageName);

describe("scanSource", () => {
  it("records static imports with symbols and 1-based lines", () => {
    const refs = byPkg(
      "a.ts",
      [
        `import fs from "node:fs";`,
        `import axios from "axios";`,
        `import { get as g, post } from "axios";`,
        `import * as _ from "lodash";`,
        `import "reflect-metadata";`,
        `axios.get("/x"); _.chunk([], 2);`,
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.line, r.form, r.symbols]),
      [
        ["axios", 2, "static", ["default", "get"]],
        ["axios", 3, "static", ["get", "post"]],
        ["lodash", 4, "static", ["*", "chunk"]],
        ["reflect-metadata", 5, "static", []],
      ],
    );
  });

  it("records require() with destructured and member-accessed symbols", () => {
    const refs = byPkg(
      "a.cjs",
      [
        `const express = require("express");`,
        `const { v4, validate } = require("uuid");`,
        `const chalkRed = require("chalk").red;`,
        `express.Router();`,
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.form, r.symbols]),
      [
        ["express", "require", ["default", "Router"]],
        ["uuid", "require", ["v4", "validate"]],
        ["chalk", "require", ["red"]],
      ],
    );
  });

  it("marks dynamic import() as dynamic and non-literal targets as unknown", () => {
    const refs = scanSource(
      "a.mjs",
      [
        `const m = await import("dayjs");`,
        "const n = await import(`zod`);",
        `const p = await import(name);`,
        `const q = require(dir + "/x");`,
      ].join("\n"),
    ).references;
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.form, r.specifier]),
      [
        ["dayjs", "dynamic", "dayjs"],
        ["zod", "dynamic", "zod"],
        [undefined, "unknown", undefined],
        [undefined, "unknown", undefined],
      ],
    );
  });

  it("covers re-exports, import-equals, require.resolve and type-only imports", () => {
    const refs = byPkg(
      "a.ts",
      [
        `export { z } from "zod";`,
        `export * from "rxjs";`,
        `import pino = require("pino");`,
        `import type { Config } from "vite";`,
        `const p = require.resolve("webpack/package.json");`,
        `type T = typeof import("esbuild");`,
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.form, r.typeOnly, r.reExport]),
      [
        ["zod", "static", false, true],
        ["rxjs", "static", false, true],
        ["pino", "require", false, false],
        ["vite", "static", true, false],
        ["webpack", "require", false, false],
        ["esbuild", "static", true, false],
      ],
    );
  });

  it("parses TSX and JSX", () => {
    const refs = byPkg("c.tsx", `import React from "react";\nexport const A = () => <div/>;`);
    assert.equal(refs[0]?.packageName, "react");
    const jsx = byPkg("c.jsx", `import { h } from "preact";\nexport const B = () => <p/>;`);
    assert.equal(jsx[0]?.packageName, "preact");
  });

  it("ignores import-like text in strings and comments", () => {
    const refs = byPkg(
      "a.js",
      `// import x from "commented";\nconst s = 'require("in-string")';\n/* import("block") */`,
    );
    assert.deepEqual(refs, []);
  });

  it("does not treat a user-defined require() member or unrelated calls as imports", () => {
    const refs = byPkg("a.js", `obj.require("not-a-dep");\nfoo("bar");`);
    assert.deepEqual(refs, []);
  });

  it("treats createRequire-bound functions as require (vite plugin-legacy, pnpapi)", () => {
    const refs = byPkg(
      "a.mjs",
      [
        `import { createRequire } from "node:module";`,
        `import module from "node:module";`,
        `const _require = createRequire(import.meta.url);`,
        `const version = _require("core-js/package.json").version;`,
        `_require.resolve("systemjs/dist/s.min.js");`,
        `const pnp = createRequire(import.meta.url)("pnpapi");`,
        `module.createRequire(import.meta.url)("via-module");`,
        `const other = makeThing(); other("not-a-dep");`,
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.form, r.line]),
      [
        ["core-js", "require", 4],
        ["systemjs", "require", 5],
        ["pnpapi", "require", 6],
        ["via-module", "require", 7],
      ],
    );
    assert.deepEqual(refs[0]?.symbols, ["version"]);
  });

  it("flags syntax errors but still returns what it could read", () => {
    const res = scanSource("a.ts", `import a from "left-pad";\nconst = ;`);
    assert.equal(res.parseErrors, true);
    assert.equal(res.references[0]?.packageName, "left-pad");
  });
});
