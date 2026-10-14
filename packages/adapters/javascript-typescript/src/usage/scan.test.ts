import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SPECIFIER_MATCHES_PER_STRING,
  MAX_STRINGS_PER_FILE,
  MAX_STRING_CHARS,
  scanSource,
} from "./scan.js";

const byPkg = (file: string, text: string) =>
  scanSource(file, text).references.filter((r) => r.packageName && !r.stringReference);
const stringRefs = (file: string, text: string) =>
  scanSource(file, text)
    .references.filter((r) => r.stringReference)
    .map((r) => [r.packageName, r.line]);

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

  it("collects many distinct member symbols in linear time", () => {
    const count = 50_000;
    const text = [
      'import * as api from "example";',
      ...Array.from({ length: count }, (_, i) => `api.member${i}();`),
      "api.member0(); api.member49999();",
    ].join("\n");
    const start = performance.now();
    const refs = byPkg("a.ts", text);
    const elapsed = performance.now() - start;
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0]?.symbols, [
      "*",
      ...Array.from({ length: count }, (_, i) => `member${i}`),
    ]);
    assert.ok(elapsed < 2_000, `member symbol collection took ${Math.round(elapsed)}ms`);
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

  it("covers import.meta.resolve and jest/vi module mock specifiers", () => {
    const refs = byPkg(
      "a.test.ts",
      [
        `const p = import.meta.resolve("webpack/package.json");`,
        `jest.mock("axios");`,
        `jest.unmock("lodash");`,
        `const actual = jest.requireActual("node-fetch");`,
        `jest.createMockFromModule("semver");`,
        `vi.mock("lodash-es");`,
        `vi.doMock("debug");`,
        `vi.unmock("chalk");`,
        `vi.doUnmock("ora");`,
        `const dyn = which(); jest.mock(dyn);`,
        `obj.mock("not-a-dep");`,
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.form, r.line]),
      [
        ["webpack", "require", 1],
        ["axios", "require", 2],
        ["lodash", "require", 3],
        ["node-fetch", "require", 4],
        ["semver", "require", 5],
        ["lodash-es", "require", 6],
        ["debug", "require", 7],
        ["chalk", "require", 8],
        ["ora", "require", 9],
      ],
    );
    // Non-literal specifiers still register as unknown-form references.
    const all = scanSource("a.test.ts", `const dyn = which(); jest.mock(dyn);`).references;
    assert.equal(all.length, 1);
    assert.deepEqual([all[0]?.packageName, all[0]?.form, all[0]?.line], [undefined, "unknown", 1]);
  });

  it("reads literal bracket members like the dot forms for resolve and mock calls", () => {
    const pairs: [string, string][] = [
      ['require.resolve("a")', 'require["resolve"]("a")'],
      ['jest.mock("a")', 'jest["mock"]("a")'],
      ['jest.mock("a")', 'jest[`mock`]("a")'],
      ['vi.doMock("a")', 'vi["doMock"]("a")'],
      ['import.meta.resolve("a")', 'import.meta["resolve"]("a")'],
    ];
    for (const [dot, bracket] of pairs) {
      const expected = scanSource("a.ts", dot).references.map((r) => [
        r.packageName,
        r.form,
        r.symbols,
      ]);
      assert.equal(expected.length, 1, dot);
      assert.deepEqual(
        scanSource("a.ts", bracket).references.map((r) => [r.packageName, r.form, r.symbols]),
        expected,
        bracket,
      );
    }
    // Names that are not literal, not a supported member, or not a supported receiver stay unmatched.
    for (const text of [
      'jest[name]("a")',
      'jest["nope"]("a")',
      'obj["mock"]("a")',
      'constructor["call"]("a")',
      'jest[`m${x}`]("a")',
      'require["resolve"]()',
    ]) {
      assert.deepEqual(byPkg("a.ts", text), [], text);
    }
  });

  it("covers the remaining jest module factories and async vi imports", () => {
    const refs = byPkg(
      "a.test.ts",
      [
        `jest.doMock("axios");`,
        `jest.dontMock("lodash");`,
        `jest.deepUnmock("underscore");`,
        `const mock = jest.requireMock("node-fetch");`,
        `jest.genMockFromModule("semver");`,
        `jest.setMock("debug", {});`,
        `const actual = await vi.importActual("chalk");`,
        `const mocked = await vi.importMock("ora");`,
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => [r.packageName, r.form, r.line, r.symbols]),
      [
        ["axios", "require", 1, ["jest.doMock"]],
        ["lodash", "require", 2, ["jest.dontMock"]],
        ["underscore", "require", 3, ["jest.deepUnmock"]],
        ["node-fetch", "require", 4, ["jest.requireMock"]],
        ["semver", "require", 5, ["jest.genMockFromModule"]],
        ["debug", "require", 6, ["jest.setMock"]],
        ["chalk", "dynamic", 7, ["vi.importActual"]],
        ["ora", "dynamic", 8, ["vi.importMock"]],
      ],
    );
    // Bracket members read like the dot forms.
    for (const [dot, bracket] of [
      ['jest.doMock("a")', 'jest["doMock"]("a")'],
      ['jest.requireMock("a")', 'jest["requireMock"]("a")'],
      ['vi.importActual("a")', 'vi["importActual"]("a")'],
    ] as [string, string][]) {
      const expected = scanSource("a.test.ts", dot).references.map((r) => [
        r.packageName,
        r.form,
        r.symbols,
      ]);
      assert.equal(expected.length, 1, dot);
      assert.deepEqual(
        scanSource("a.test.ts", bracket).references.map((r) => [r.packageName, r.form, r.symbols]),
        expected,
        bracket,
      );
    }
    // Non-literal specifiers still register as unknown-form references.
    const all = scanSource("a.test.ts", `const dyn = which(); jest.doMock(dyn);`).references;
    assert.equal(all.length, 1);
    assert.deepEqual([all[0]?.packageName, all[0]?.form, all[0]?.line], [undefined, "unknown", 1]);
  });

  it("does not read module names from decoys of the new factory calls", () => {
    const none = [
      `jest.doMock();`,
      `jest.doUnmock("a");`,
      `jest.dontMock();`,
      `vi.dontMock("a");`,
      `jest.setMock();`,
      `vi.importActual();`,
      `jest.importActual("a");`,
      `jest.importMock("a");`,
      `vi.requireMock("a");`,
      `vi.setMock("a", {});`,
      `vi.genMockFromModule("a");`,
      `other.doMock("a");`,
      `other.importActual("a");`,
      `doMock("a");`,
      `importActual("a");`,
      `jest.doMock;`,
      `vi.importActual;`,
      `jest[name]("a");`,
      `vi.constructor.importActual("a");`,
    ];
    for (const source of none) {
      assert.deepEqual(scanSource("a.test.ts", source).references, [], source);
    }
    // A spread first argument reads like the existing jest.mock contract.
    const shape = (source: string) =>
      scanSource("a.test.ts", source).references.map((r) => [r.packageName, r.form]);
    assert.deepEqual(shape(`jest.doMock(...names);`), shape(`jest.mock(...names);`));
  });

  it("reads createRequire with a literal bracket member like the dot form", () => {
    const forms = (callee: string) => [
      `const r = ${callee}(import.meta.url); r("demo");`,
      `${callee}(import.meta.url)("demo");`,
    ];
    for (const bracket of ['module["createRequire"]', "module[`createRequire`]"]) {
      forms(bracket).forEach((text, index) => {
        const expected = byPkg("a.ts", forms("module.createRequire")[index]!).map((r) => [
          r.packageName,
          r.form,
        ]);
        assert.deepEqual(expected, [["demo", "require"]]);
        assert.deepEqual(
          byPkg("a.ts", text).map((r) => [r.packageName, r.form]),
          expected,
          text,
        );
      });
    }
    // Dynamic, substituted or other member names do not create a require function.
    for (const callee of ["module[name]", "module[`create${x}`]", 'module["createRequires"]']) {
      for (const text of forms(callee)) assert.deepEqual(byPkg("a.ts", text), [], text);
    }
  });

  it("finds createRequire aliases written with escape sequences", () => {
    const head = 'import * as mod from "node:module"; ';
    const demo = (text: string) =>
      byPkg("a.ts", text)
        .map((r) => r.packageName)
        .filter((name) => name === "demo");
    const cases = [
      String.raw`import { create\u0052equire } from "node:module"; const r = create\u0052equire(import.meta.url); r("demo");`,
      String.raw`import { create\u{52}equire } from "node:module"; const r = create\u{52}equire(import.meta.url); r("demo");`,
      String.raw`${head}const r = mod["create\u0052equire"](import.meta.url); r("demo");`,
      String.raw`${head}const r = mod["create\x52equire"](import.meta.url); r("demo");`,
      `${head}const r = mod[\`create\\x52equire\`](import.meta.url); r("demo");`,
      // Direct call and plain controls.
      String.raw`${head}mod["create\u0052equire"](import.meta.url)("demo");`,
      `${head}const r = mod.createRequire(import.meta.url); r("demo");`,
    ];
    for (const text of cases) assert.deepEqual(demo(text), ["demo"], text);
    // An escape that does not spell createRequire is not a require function.
    for (const text of [
      String.raw`${head}const r = mod["create\u0052equires"](import.meta.url); r("demo");`,
      String.raw`${head}const r = mod["other\x52"](import.meta.url); r("demo");`,
    ]) {
      assert.deepEqual(demo(text), [], text);
    }
  });

  it("sees through parentheses around recognised callees, receivers and aliases", () => {
    const head = 'import { createRequire } from "node:module"; import module from "node:module"; ';
    const found = (text: string) =>
      byPkg("a.ts", `${head}${text}`)
        .map((r) => r.packageName)
        .filter((name) => name === "demo");
    for (const text of [
      '(require)("demo");',
      '((require))("demo");',
      '(require.resolve)("demo");',
      '(require)["resolve"]("demo");',
      '(import.meta).resolve("demo");',
      '(jest).mock("demo");',
      '(jest.mock)("demo");',
      '(vi["doMock"])("demo");',
      'const r = (createRequire(import.meta.url)); r("demo");',
      'const r = ((module.createRequire)(import.meta.url)); r("demo");',
      '(createRequire(import.meta.url))("demo");',
      '(createRequire)(import.meta.url)("demo");',
      '(module["createRequire"])(import.meta.url)("demo");',
    ]) {
      assert.deepEqual(found(text), ["demo"], text);
    }
    // Plain forms and dynamic imports keep working.
    for (const text of ['require("demo");', 'import("demo");', '(import("demo"));']) {
      assert.deepEqual(found(text), ["demo"], text);
    }
    // Sequences, conditionals and other computed callees stay unmatched.
    for (const text of [
      '(0, require)("demo");',
      '(a ? require : b)("demo");',
      '(require || other)("demo");',
      '(require, other)("demo");',
      '(a, jest).mock("demo");',
    ]) {
      assert.deepEqual(found(text), [], text);
    }
  });

  it("records the string evidence it did not examine, and only then", () => {
    const filler = (n: number) => '"x",'.repeat(n);
    const list = (n: number) => `const v = [${filler(n)}"demo/runtime.js"];`;
    // Exactly at the string limit: the last string is still examined.
    const atLimit = scanSource("a.ts", list(MAX_STRINGS_PER_FILE - 1));
    assert.equal(atLimit.incompleteStrings, undefined);
    assert.deepEqual(
      atLimit.references.filter((r) => r.stringReference).map((r) => r.packageName),
      ["demo"],
    );
    // One past it: a string went unexamined, so the result says so.
    const over = scanSource("a.ts", list(MAX_STRINGS_PER_FILE));
    assert.equal(over.references.filter((r) => r.stringReference).length, 0);
    assert.match(over.incompleteStrings?.join(" ") ?? "", /more than 20000 string literals/);
    // A long string is skipped unexamined and counted; one at the limit is read.
    const long = scanSource("a.ts", `const a = "${"x".repeat(MAX_STRING_CHARS + 1)}";`);
    assert.match(long.incompleteStrings?.join(" ") ?? "", /1 string over 100000 characters/);
    assert.equal(
      scanSource("a.ts", `const a = "${"x".repeat(MAX_STRING_CHARS)}";`).incompleteStrings,
      undefined,
    );
    // Exactly 50 specifier-like matches in one string is complete; a 51st is not.
    const imports = (n: number) =>
      "const code = `" + Array.from({ length: n }, (_, i) => `import "p${i}";`).join(" ") + "`;";
    const fifty = scanSource("a.ts", imports(MAX_SPECIFIER_MATCHES_PER_STRING));
    assert.equal(fifty.incompleteStrings, undefined);
    assert.equal(fifty.references.filter((r) => r.stringReference).length, 50);
    const fiftyOne = scanSource("a.ts", imports(MAX_SPECIFIER_MATCHES_PER_STRING + 1));
    assert.match(
      fiftyOne.incompleteStrings?.join(" ") ?? "",
      /more than 50 specifier-like matches/,
    );
    assert.equal(fiftyOne.references.filter((r) => r.stringReference).length, 50);
  });

  it("treats a renamed createRequire import from module or node:module as the factory", () => {
    const demo = (text: string) =>
      byPkg("a.mjs", text)
        .map((r) => r.packageName)
        .filter((name) => name === "demo");
    for (const from of ["node:module", "module"]) {
      const imp = `import { createRequire as mk } from "${from}"; `;
      for (const body of [
        'const r = mk(import.meta.url); r("demo");',
        'mk(import.meta.url)("demo");',
        'mk(import.meta.url).resolve("demo");',
        '(mk)(import.meta.url)("demo");',
        'const r = (mk(import.meta.url)); r("demo");',
        'const r = mk(import.meta.url); r.resolve("demo");',
      ]) {
        assert.deepEqual(demo(imp + body), ["demo"], imp + body);
      }
    }
    const decl = 'import { createRequire as mk } from "node:module";';
    // The import may come after its use, and the imported name may be a decoded escape or a string.
    assert.deepEqual(demo(`const r = mk(import.meta.url); r("demo"); ${decl}`), ["demo"]);
    assert.deepEqual(
      demo(
        String.raw`import { create\u0052equire as mk } from "node:module"; const r = mk(import.meta.url); r("demo");`,
      ),
      ["demo"],
    );
    assert.deepEqual(
      demo(
        `import { "createRequire" as mk } from "node:module"; const r = mk(import.meta.url); r("demo");`,
      ),
      ["demo"],
    );
    // Plain and member forms are unchanged.
    assert.deepEqual(
      demo('import { createRequire } from "node:module"; createRequire(import.meta.url)("demo");'),
      ["demo"],
    );
    assert.deepEqual(
      demo('import m from "node:module"; const r = m.createRequire(import.meta.url); r("demo");'),
      ["demo"],
    );
    // The binding alone is not a reference, and a wrong source, other name or type-only import does not count.
    assert.deepEqual(demo(`${decl} const r = mk(import.meta.url);`), []);
    for (const imp of [
      'import { createRequire as mk } from "./mod";',
      'import { createRequire as mk } from "node:fs";',
      'import { other as mk } from "node:module";',
      'import type { createRequire as mk } from "node:module";',
      'import { type createRequire as mk } from "node:module";',
    ]) {
      assert.deepEqual(demo(`${imp} const r = mk(import.meta.url); r("demo");`), [], imp);
    }
  });

  it("ignores inherited Object property names as mock-framework receivers", () => {
    const result = scanSource(
      "a.js",
      [
        'constructor.call("axios");',
        'toString.call("axios");',
        'hasOwnProperty.call("axios");',
        'valueOf.call("axios");',
        '__proto__.call("axios");',
        'jest.mock("axios");',
        'vi.mock("lodash");',
      ].join("\n"),
    );
    assert.deepEqual(
      result.references.map((r) => r.packageName),
      ["axios", "lodash"],
    );
  });

  it("records package references in string text as string references (vite plugin-legacy)", () => {
    const text = [
      `legacyPolyfills.add("regenerator-runtime/runtime.js");`,
      "const p = i.includes('/') ? `core-js/${i}` : `core-js/modules/${i}.js`;",
      'const code = `import "systemjs/dist/s.min.js";` + \'require("in-string")\';',
      `if (source.startsWith("@babel/runtime/")) {}`,
      `const words = ["debug", "url", "text/html"];`,
      `import real from "real-dep/sub";`,
      `const url = "https://cdn.example.com/x.js"; const rel = "./local/file.js";`,
    ].join("\n");
    assert.deepEqual(stringRefs("a.ts", text), [
      ["regenerator-runtime", 1],
      ["core-js", 2],
      ["systemjs", 3],
      ["in-string", 3],
      ["@babel/runtime", 4],
      ["text", 5],
    ]);
    // A real import's own specifier is not repeated as a string reference.
    assert.deepEqual(
      byPkg("a.ts", text).map((r) => r.packageName),
      ["real-dep"],
    );
  });

  it("flags syntax errors but still returns what it could read", () => {
    const res = scanSource("a.ts", `import a from "left-pad";\nconst = ;`);
    assert.equal(res.parseErrors, true);
    assert.equal(res.references[0]?.packageName, "left-pad");
  });
});

describe("scanSource JSDoc type imports in JavaScript", () => {
  const refs = (file: string, text: string) =>
    scanSource(file, text).references.filter((r) => r.packageName);

  it("records import() types and @import tags in .js files as type-only references", () => {
    const found = refs(
      "a.js",
      [
        `/** @type {import("lodash").Foo} */`,
        `let x;`,
        `/** @typedef {import("rxjs").Observable<number>} Obs */`,
        `/** @import { Thing } from "zod" */`,
        `/** @param {Array<import("dayjs")>} a */`,
        `function f(a) {}`,
      ].join("\n"),
    );
    assert.deepEqual(
      found.map((r) => [r.packageName, r.line, r.typeOnly, r.stringReference ?? false]),
      [
        ["lodash", 1, true, false],
        ["rxjs", 3, true, false],
        ["zod", 4, true, false],
        ["dayjs", 5, true, false],
      ],
    );
    assert.deepEqual(found[2]!.symbols, ["Thing"]);
  });

  it("does not read JSDoc in TypeScript files, comments or strings", () => {
    assert.deepEqual(refs("a.ts", `/** @type {import("lodash").Foo} */\nlet x: number;`), []);
    assert.deepEqual(refs("a.js", `// {import("lodash").Foo}\nconst s = 1;`), []);
  });
});
