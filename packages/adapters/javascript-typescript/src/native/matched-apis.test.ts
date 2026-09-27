/**
 * Matched-API reference producer tests (#443). Fixtures cover every coverage
 * class the #56 definition names - direct, alias, wrapper, re-export,
 * script, config - plus the honest-unknown cases that must BLOCK.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryHandle } from "../testing/fs-handle.js";
import { findMatchedApiReferences } from "./matched-apis.js";
import type { MatchedApiReference } from "./matched-apis.js";

/** The bytes a span cites, exactly as core would re-read them. */
function cited(files: Record<string, string>, ref: MatchedApiReference): string {
  assert.ok(ref.span, `expected a span on ${ref.callTarget}`);
  const bytes = Buffer.from(files[ref.span.file]!, "utf8");
  return bytes.subarray(ref.span.start, ref.span.end).toString("utf8");
}

test("direct call: default import with argument and option AST citations", async () => {
  const files = {
    "src/api.ts": [
      'import axios from "axios";',
      "",
      'export const load = () => axios.get("/users", { params: { page: 1 }, timeout: 1000 });',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.limitations.length, 0);
  assert.equal(scan.references.length, 1);
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "direct");
  assert.equal(ref.callTarget, "axios.get");
  assert.equal(ref.api, "get");
  assert.equal(ref.binding, "get");
  assert.equal(ref.arguments, "inspected");
  assert.equal(ref.options, "inspected");
  assert.equal(ref.lineage.length, 1);
  assert.equal(ref.lineage[0]!.kind, "import");
  assert.ok(cited(files, ref).startsWith("axios.get("));
  assert.deepEqual(
    ref.argumentSpans!.map((s) =>
      Buffer.from(files["src/api.ts"]!, "utf8").subarray(s.start, s.end).toString("utf8"),
    ),
    ['"/users"', "{ params: { page: 1 }, timeout: 1000 }"],
  );
});

test("alias: named-import-as and const alias both resolve to the same target", async () => {
  const files = {
    "src/a.ts": [
      'import { get as g } from "axios";',
      'import axios from "axios";',
      "const ax = axios;",
      'g("/a");',
      'ax.post("/b", { a: 1 });',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 2);
  const [first, second] = scan.references;
  assert.equal(first!.resolution, "alias");
  assert.equal(first!.callTarget, "axios.get");
  assert.equal(first!.binding, "g");
  assert.equal(second!.resolution, "alias");
  assert.equal(second!.callTarget, "axios.post");
  assert.equal(second!.binding, "post");
});

test("require and destructured require bindings", async () => {
  const files = {
    "src/a.cjs": [
      'const axios = require("axios");',
      'const { get } = require("axios");',
      'axios.delete("/x");',
      'get("/y");',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 2);
  assert.equal(scan.references[0]!.resolution, "direct");
  assert.equal(scan.references[0]!.callTarget, "axios.delete");
  assert.equal(scan.references[1]!.resolution, "alias");
  assert.equal(scan.references[1]!.callTarget, "axios.get");
});

test("wrapper: local function wrapping the call, resolved through the wrapper graph", async () => {
  const files = {
    "src/http.ts": [
      'import axios from "axios";',
      "",
      "export function fetchUser(id: string) {",
      "  return axios.get(`/users/${id}`);",
      "}",
      "export function fetchUserName(id: string) {",
      "  return fetchUser(id);",
      "}",
      'const first = fetchUser("1");',
      'const second = fetchUserName("2");',
      "void first;",
      "void second;",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const inner = scan.references.filter((r) => r.resolution === "direct");
  assert.equal(inner.length, 1, "the inner package call is one direct record");
  const wrappers = scan.references.filter((r) => r.resolution === "wrapper");
  // fetchUser("1"), fetchUserName("2"), and fetchUser(id) inside fetchUserName's body.
  assert.equal(wrappers.length, 3, "each wrapper call site is cited");
  assert.ok(wrappers.every((r) => r.callTarget === "axios.get" && r.api === "get"));
  const chained = wrappers.find((r) => r.binding === "fetchUserName")!;
  assert.deepEqual(
    chained.lineage.map((h) => h.kind),
    ["wrapper", "wrapper", "import"],
    "fetchUserName resolves through fetchUser to the import",
  );
});

test("re-export: barrel file resolved to the package", async () => {
  const files = {
    "src/http.ts": 'export { get } from "axios";',
    "src/app.ts": ['import { get } from "./http";', 'get("/users");'].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "re-export");
  assert.equal(ref.callTarget, "axios.get");
  assert.deepEqual(
    ref.lineage.map((h) => h.kind),
    ["re-export", "import"],
  );
  assert.equal(ref.lineage[0]!.span.file, "src/http.ts");
});

test("re-export: star barrel", async () => {
  const files = {
    "src/http.ts": 'export * from "axios";',
    "src/app.ts": ['import { get } from "./http";', 'get("/users");'].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  assert.equal(scan.references[0]!.resolution, "re-export");
  assert.equal(scan.references[0]!.callTarget, "axios.get");
});

test("script: package.json script invoking the package CLI, cited from manifest bytes", async () => {
  const manifest = JSON.stringify(
    { name: "app", scripts: { build: "tsc -p . && echo done", test: "vitest run" } },
    null,
    2,
  );
  const files = { "package.json": manifest };
  const scan = await findMatchedApiReferences(memoryHandle(files), "typescript");
  assert.equal(scan.references.length, 1);
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "script");
  assert.equal(ref.binding, "build");
  assert.equal(cited(files, ref), '"tsc -p . && echo done"');
  assert.equal(ref.span!.file, "package.json");
});

test("config: parsed construct, never string match", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "app" }),
    ".eslintrc.json": JSON.stringify(
      { plugins: ["react"], extends: ["eslint:recommended"] },
      null,
      2,
    ),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "eslint-plugin-react");
  assert.equal(scan.references.length, 1);
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "config");
  assert.ok(cited(files, ref).includes('"react"'));
  assert.equal(ref.span!.file, ".eslintrc.json");
});

test("indirect-unknown: computed member access BLOCKS, never dropped", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "declare const method: string;",
      "axios[method]('/dynamic');",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "indirect-unknown");
  assert.equal(ref.api, "<computed>");
  assert.ok(ref.note);
});

test("indirect-unknown: dynamic import binding flow stays unknown", async () => {
  const files = {
    "src/a.ts": ['const axios = await import("axios");', 'axios.get("/x");'].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const dynamic = scan.references.filter((r) => r.api === "<dynamic-import>");
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0]!.resolution, "indirect-unknown");
});

test("options unknown: spread and computed keys block inspection", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "declare const extra: Record<string, unknown>;",
      'axios.get("/a", { ...extra });',
      'axios.get("/b", { ["k" + "1"]: 2 });',
      "axios.get('/c', makeConfig());",
      "declare function makeConfig(): object;",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 3);
  assert.ok(scan.references.every((r) => r.options === "unknown"));
});

test("options inspected via a local const options object", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "const opts = { timeout: 500, headers: { accept: " + '"application/json"' + " } };",
      'axios.get("/a", opts);',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  assert.equal(scan.references[0]!.options, "inspected");
});

test("byte-exact spans across multibyte and astral text", async () => {
  const files = {
    "src/a.ts": "// café 🚀\nimport axios from \"axios\";\naxios.get('/x');\n",
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const ref = scan.references[0]!;
  // The span must cite exactly the call bytes even though char and byte
  // offsets diverge before it (é is 2 bytes, the rocket 4).
  assert.equal(cited(files, ref), "axios.get('/x')");
  const charAt = files["src/a.ts"]!.indexOf("axios.get('/x')");
  assert.notEqual(ref.span!.start, charAt, "byte offset must differ from the char offset here");
});

test("other packages do not produce records", async () => {
  const files = {
    "src/a.ts": ['import express from "express";', "express();"].join("\n"),
    "package.json": JSON.stringify({ name: "app", scripts: { start: "node src/a.ts" } }),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 0);
});

test("unreadable config keeps coverage incomplete", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "app" }),
    "jest.config.js": "module.exports = { preset: ", // malformed executable config
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "ts-jest");
  assert.ok(
    scan.limitations.some((l) => l.kind === "matched-api-config-unread"),
    "malformed config is a blocking limitation",
  );
});

test("member-of-member chain is indirect-unknown, never silently dropped (review repro 1)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "axios.interceptors.request.use((config) => config);",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1, "the chain use must be cited, not dropped");
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "indirect-unknown");
  assert.ok(ref.span);
  assert.ok(ref.note?.includes("member-of-member"));
});

test("reassignable let alias is indirect-unknown, never silently dropped (review repro 1b)", async () => {
  const files = {
    "src/a.ts": ['import axios from "axios";', "let x = axios;", 'x.get("/x");'].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "indirect-unknown");
  assert.ok(ref.note?.includes("reassignable"));
});

test("parameter shadowing defeats the import binding (review repro 2)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function f(axios: unknown) {",
      '  axios.get("/x");',
      "}",
      'axios.get("/real");',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 2);
  const shadowed = scan.references.find((r) => cited(files, r).includes('"/x"'))!;
  assert.equal(shadowed.resolution, "indirect-unknown");
  assert.ok(shadowed.note?.includes("shadowed"));
  const real = scan.references.find((r) => cited(files, r).includes('"/real"'))!;
  assert.equal(real.resolution, "direct", "the unshadowed module-scope use stays direct");
});

test("block-scoped local const shadowing defeats the import binding (review repro 2b)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function f() {",
      "  const axios = { get: (url: string) => url };",
      '  axios.get("/x");',
      "}",
      "f();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  assert.equal(scan.references[0]!.resolution, "indirect-unknown");
  assert.ok(scan.references[0]!.note?.includes("shadowed"));
});

test("bare call of a callable package binding is cited, not dropped", async () => {
  const files = {
    "src/a.ts": ['import axios from "axios";', 'axios("/x", { method: "get" });'].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1);
  assert.equal(scan.references[0]!.resolution, "direct");
  assert.equal(scan.references[0]!.api, "<call>");
  assert.equal(scan.references[0]!.callTarget, "axios");
});

test("function-local const alias binds in its scope (review repro 3)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function f() {",
      "  const x = axios;",
      '  x.get("/x");',
      "}",
      "f();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  // The alias call inside f, plus f() cited as a wrapper call site.
  const ref = scan.references.find((r) => r.resolution === "alias");
  assert.ok(ref, "nested alias use must be cited, not dropped");
  assert.equal(ref!.callTarget, "axios.get");
  assert.deepEqual(
    ref!.lineage.map((h) => h.kind),
    ["import", "alias"],
  );
  assert.equal(scan.references.filter((r) => r.resolution === "wrapper").length, 1);
});

test("function-local destructure binds in its scope (review repro 3b)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function f() {",
      "  const { get } = axios;",
      '  get("/x");',
      "}",
      "f();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const ref = scan.references.find((r) => r.resolution === "alias");
  assert.ok(ref, "nested destructure use must be cited, not dropped");
  assert.equal(ref!.callTarget, "axios.get");
});

test("function-local require binds in its scope (review repro 3c)", async () => {
  const files = {
    "src/a.cjs": [
      "function f() {",
      '  const axios = require("axios");',
      '  axios.get("/x");',
      "}",
      "f();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const ref = scan.references.find((r) => r.resolution === "direct");
  assert.ok(ref, "nested require use must be cited, not dropped");
  assert.equal(ref!.callTarget, "axios.get");
});

test("nested alias does not leak out of its scope", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function f() {",
      "  const x = axios;",
      '  x.get("/inside");',
      "}",
      'const x = "plain-string";',
      "void x;",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1, "only the in-scope use is cited");
  assert.ok(cited(files, scan.references[0]!).includes("/inside"));
});

test("innermost scoped binding wins over the module binding", async () => {
  const files = {
    "src/a.ts": [
      'import { get } from "axios";',
      "function f() {",
      "  const g = get;",
      '  g("/x");',
      "}",
      "f();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const ref = scan.references.find((r) => r.resolution === "alias");
  assert.ok(ref);
  assert.equal(ref!.callTarget, "axios.get");
});

test("shadowed alias initializer never grounds a package citation (review repro 4)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function f(axios: unknown) {",
      "  const x = axios;",
      '  x.get("/shadow");',
      "}",
      "f();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const ref = scan.references.find((r) => cited(files, r).includes('"/shadow"'));
  assert.ok(ref, "the use must be cited, not dropped");
  assert.equal(ref!.resolution, "indirect-unknown", "x derives from the shadowing parameter");
  assert.ok(ref!.note?.includes("shadowed"));
  assert.ok(
    !scan.references.some((r) => r.resolution === "alias" && cited(files, r).includes('"/shadow"')),
    "no unsound alias citation",
  );
});

test("use before the alias declaration never resolves to it (review repro 4b)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      'x.get("/before");',
      "const x = axios;",
      'x.get("/after");',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const before = scan.references.find((r) => cited(files, r).includes('"/before"'))!;
  assert.equal(before.resolution, "indirect-unknown", "pre-declaration use cannot cite the alias");
  assert.ok(before.note?.includes("before its package-binding declaration"));
  const after = scan.references.find((r) => cited(files, r).includes('"/after"'))!;
  assert.equal(after.resolution, "alias", "the post-declaration use cites the alias");
});

test("local non-package initializer is unrelated, not unknown (review repro 5)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "const unrelated = { get() {} };",
      "const x = unrelated;",
      'x.get("/unrelated");',
      'axios.get("/real");',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1, "only the genuine package use is cited");
  assert.equal(scan.references[0]!.resolution, "direct");
  assert.ok(cited(files, scan.references[0]!).includes('"/real"'));
});

test("plain local value flow produces no package records (review repro 5b)", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      'const plain = "abc";',
      "const x = plain;",
      "x.toUpperCase();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 0, "no package flow: no reference and no unknown");
});

test("per-pattern inspections emit byte-exact observations and explicit not-observed", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const text =
    'import axios from "axios";\naxios.interceptors.request.use(x => x);\naxios.get("/", { timeout: 1000, responseType: "json" });\ntry { throw 1; } catch (error) { console.log(error.response, error.code); }\n';
  const patterns = [
    { patternId: "interceptors.request.use", kind: "member-call" as const },
    { patternId: "timeout", kind: "option-key-value" as const },
    { patternId: "responseType", kind: "option-key-value" as const },
    { patternId: "error.response", kind: "property-chain" as const },
    { patternId: "error.code", kind: "property-chain" as const },
    { patternId: "absent", kind: "option-key-value" as const },
  ];
  const records = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), patterns);
  assert.deepEqual(
    records.map((r) => r.state),
    ["observed", "observed", "observed", "observed", "observed", "not-observed"],
  );
  for (const record of records)
    for (const span of record.observations) {
      assert.equal(
        Buffer.from(text).subarray(span.start, span.end).toString(),
        record.patternId === "timeout"
          ? "timeout: 1000"
          : record.patternId === "responseType"
            ? 'responseType: "json"'
            : record.patternId === "error.response"
              ? "error.response"
              : record.patternId === "error.code"
                ? "error.code"
                : text.slice(span.start, span.end),
      );
    }
  assert.deepEqual(records[5]!.observations, []);
  assert.equal(records[5]!.capped, false);
});

test("pattern inspection marks bounded scan caps and does not imply completeness", async () => {
  const { inspectIncompatiblePatterns, MAX_PATTERN_BYTES } =
    await import("./pattern-inspections.js");
  const files = { "src/a.ts": `const timeout = 1;\n${" ".repeat(MAX_PATTERN_BYTES)}` };
  const [record] = await inspectIncompatiblePatterns(memoryHandle(files), [
    { patternId: "timeout", kind: "option-key-value" },
  ]);
  assert.equal(record!.capped, true);
  assert.deepEqual(record!.inspectedFiles, []);
  assert.equal(record!.state, "not-observed");
});

test("computed, dynamic, and spread option keys are uninspectable, not absent (#448)", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const fixtures = [
    [
      'import axios from "axios"; axios.get("/", { ["timeout"]: 1000 });',
      "computed option key may match timeout",
    ],
    [
      'import axios from "axios"; const key = "timeout"; axios.get("/", { [key]: 1000 });',
      "computed option key may match timeout",
    ],
    [
      'import axios from "axios"; const other = {}; axios.get("/", { ...other });',
      "object spread may hide option key timeout",
    ],
  ] as const;
  for (const [text, note] of fixtures) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId: "timeout", kind: "option-key-value" },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.observations.length, 0);
    assert.equal(record!.uninspectable.length, 1);
    assert.equal(record!.uninspectable[0]!.note, note);
    const cited = record!.uninspectable[0]!;
    assert.equal(
      Buffer.from(text).subarray(cited.start, cited.end).toString(),
      text.slice(cited.start, cited.end),
    );
  }
});

test("shorthand and method options are uninspectable", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  for (const [text, note] of [
    [
      'import axios from "axios"; axios.get("/", { timeout });',
      "shorthand option timeout has an unresolved value",
    ],
    [
      'import axios from "axios"; axios.get("/", { timeout() { return 1000; } });',
      "method option may hide or define timeout",
    ],
  ] as const) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId: "timeout", kind: "option-key-value" },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.uninspectable[0]!.note, note);
  }
});

test("computed interceptor members and error properties are uninspectable", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  for (const [text, patternId, kind] of [
    [
      'import axios from "axios"; axios.interceptors.request[method](() => {});',
      "interceptors.request.use",
      "member-call",
    ],
    ["try {} catch (error) { error[key]; }", "error.response", "property-chain"],
  ] as const) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId, kind },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.uninspectable.length, 1);
    const span = record!.uninspectable[0]!;
    assert.ok(Buffer.from(text).subarray(span.start, span.end).toString().length > 0);
  }
});

test("shorthand and method options are uninspectable", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  for (const [text, note] of [
    [
      'import axios from "axios"; axios.get("/", { timeout });',
      "shorthand option timeout has an unresolved value",
    ],
    [
      'import axios from "axios"; axios.get("/", { timeout() { return 1000; } });',
      "method option may hide or define timeout",
    ],
  ] as const) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId: "timeout", kind: "option-key-value" },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.uninspectable[0]!.note, note);
  }
});

test("computed interceptor members and error properties are uninspectable", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  for (const [text, patternId, kind] of [
    [
      'import axios from "axios"; axios.interceptors.request[method](() => {});',
      "interceptors.request.use",
      "member-call",
    ],
    ["try {} catch (error) { error[key]; }", "error.response", "property-chain"],
  ] as const) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId, kind },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.uninspectable.length, 1);
    const span = record!.uninspectable[0]!;
    assert.ok(Buffer.from(text).subarray(span.start, span.end).toString().length > 0);
  }
});

test("computed interceptor intermediate access and computed option methods are uninspectable", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const cases = [
    [
      'import axios from "axios"; axios.interceptors[which].use(() => {});',
      "interceptors.request.use",
      "member-call",
    ],
    ['import axios from "axios"; axios.get("/", { [key]() {} });', "timeout", "option-key-value"],
  ] as const;
  for (const [text, patternId, kind] of cases) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId, kind },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.uninspectable.length, 1);
  }
});

test("computed option accessors and earlier computed interceptor segments are uninspectable", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const cases = [
    [
      'import axios from "axios"; axios.get("/", { get [key]() { return 42; } });',
      "timeout",
      "option-key-value",
    ],
    [
      'import axios from "axios"; axios[feature].request.use(() => {});',
      "interceptors.request.use",
      "member-call",
    ],
  ] as const;
  for (const [text, patternId, kind] of cases) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), [
      { patternId, kind },
    ]);
    assert.equal(record!.state, "uninspectable");
    assert.equal(record!.uninspectable.length, 1);
  }
});

test("computed interceptor prefixes are unknown only when the access chain names interceptors", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const pattern = [{ patternId: "interceptors.request.use", kind: "member-call" as const }];
  const [possible] = await inspectIncompatiblePatterns(
    memoryHandle({
      "src/a.ts": 'import axios from "axios"; axios[feature].request.use(() => {});',
    }),
    pattern,
  );
  assert.equal(possible!.state, "uninspectable");
  const [unrelated] = await inspectIncompatiblePatterns(
    memoryHandle({ "src/a.ts": "other[x].run(); a[x]();" }),
    pattern,
  );
  assert.equal(unrelated!.state, "not-observed");
  assert.deepEqual(unrelated!.uninspectable, []);
});

test("computed interceptor uncertainty requires the expected terminal method", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const pattern = [{ patternId: "interceptors.request.use", kind: "member-call" as const }];
  const [possible] = await inspectIncompatiblePatterns(
    memoryHandle({ "src/a.ts": "api[feature].request.use(() => {});" }),
    pattern,
  );
  assert.equal(possible!.state, "uninspectable");
  const [ruledOut] = await inspectIncompatiblePatterns(
    memoryHandle({ "src/a.ts": "api[feature].request.other();" }),
    pattern,
  );
  assert.equal(ruledOut!.state, "not-observed");
});

test("computed interceptor uncertainty ignores arguments and comments for matching", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const pattern = [{ patternId: "interceptors.request.use", kind: "member-call" as const }];
  for (const text of ['other[x].run("interceptors");', "other[x].run(/* interceptors */);"]) {
    const [record] = await inspectIncompatiblePatterns(memoryHandle({ "src/a.ts": text }), pattern);
    assert.equal(record!.state, "not-observed");
    assert.deepEqual(record!.uninspectable, []);
  }
});

/** Independently reconstruct the byte ranges cited by a lineage link. */
function assertChainTokens(files: Record<string, string>, ref: MatchedApiReference): void {
  const chain = ref.lineageChain;
  assert.ok(chain, "lineage chain present");
  assert.equal(chain.brokenAt, undefined, "no hidden gap in a complete chain");
  assert.ok(chain.links.length >= 2);
  for (const link of chain.links) {
    const bytes = Buffer.from(files[link.span.file]!, "utf8");
    const containing = bytes.subarray(link.span.start, link.span.end).toString("utf8");
    for (const token of [link.fromSpan, link.toSpan, link.specifierSpan, link.memberSpan]) {
      if (!token) continue;
      assert.equal(token.file, link.span.file);
      assert.ok(token.start >= link.span.start && token.end <= link.span.end);
      assert.ok(token.end > token.start);
      assert.ok(containing.includes(bytes.subarray(token.start, token.end).toString("utf8")));
    }
  }
}

test("lineage chain carries import, alias and call edges with exact UTF-8 tokens", async () => {
  const files = {
    "src/a.ts": '/* 🦊 */ import { get as g } from "axios";\nconst a = g;\na("/x");',
  };
  const ref = (await findMatchedApiReferences(memoryHandle(files), "axios")).references[0]!;
  assertChainTokens(files, ref);
  assert.deepEqual(
    ref.lineageChain!.links.map((l) => l.kind),
    ["import", "alias", "call"],
  );
  const [entry, alias] = ref.lineageChain!.links;
  const text = (s: { file: string; start: number; end: number }) =>
    Buffer.from(files[s.file as keyof typeof files])
      .subarray(s.start, s.end)
      .toString("utf8");
  assert.equal(text(entry!.fromSpan), "get");
  assert.equal(text(entry!.toSpan), "g");
  assert.equal(text(entry!.specifierSpan!), '"axios"');
  assert.equal(text(alias!.fromSpan), "g");
  assert.equal(text(alias!.toSpan), "a");
});

test("#473 local alias: full hop lineage and cited chain, namespace and member forms", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "const client = axios;",
      "const post = axios.post;",
      'client.get("/x");',
      'post("/y", { a: 1 });',
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.limitations.length, 0);
  assert.equal(scan.references.length, 2);
  const [namespace, member] = scan.references;
  for (const ref of [namespace!, member!]) {
    assert.equal(ref.resolution, "alias");
    assert.equal(ref.arguments, "inspected");
    assert.equal(ref.options, "inspected");
    assert.deepEqual(
      ref.lineage.map((h) => h.kind),
      ["import", "alias"],
      "the alias use carries the package-entry hop, not a bare alias hop",
    );
    assert.deepEqual(
      ref.lineageChain!.links.map((l) => l.kind),
      ["import", "alias", "call"],
    );
    assertChainTokens(files, ref);
  }
  assert.equal(namespace!.callTarget, "axios.get");
  assert.equal(member!.callTarget, "axios.post");
  const aliasLink = member!.lineageChain!.links[1]!;
  assert.ok(aliasLink.memberSpan, "member alias cites the member token");
  const bytes = Buffer.from(files["src/a.ts"], "utf8");
  assert.equal(
    bytes.subarray(aliasLink.memberSpan!.start, aliasLink.memberSpan!.end).toString("utf8"),
    "post",
  );
});

test("#473 simple wrapper: call sites resolve with declaration and call-site links cited", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function client(url: string) {",
      "  return axios.get(url);",
      "}",
      "const poster = (url: string, body = { a: 1 }) => axios.post(url, body);",
      'const first = await client("/x");',
      'const second = await poster("/y");',
      "void first;",
      "void second;",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.limitations.length, 0);
  assert.ok(
    !scan.references.some((r) => r.resolution === "direct"),
    "the inner calls of simple wrappers are accounted for by their call-site records",
  );
  assert.equal(scan.references.length, 2, "one wrapper record per call site");
  const [fn, arrow] = scan.references;
  for (const ref of [fn!, arrow!]) {
    assert.equal(ref.resolution, "wrapper");
    assert.equal(ref.arguments, "inspected");
    assert.equal(ref.options, "inspected");
    assert.deepEqual(
      ref.lineageChain!.links.map((l) => l.kind),
      ["import", "call", "wrapper", "call"],
      "wrapper declaration and call-site links both cited",
    );
    assertChainTokens(files, ref);
  }
  assert.equal(fn!.callTarget, "axios.get");
  assert.equal(fn!.binding, "client");
  assert.equal(arrow!.callTarget, "axios.post");
  assert.equal(arrow!.binding, "poster");
});

test("#473 rest pass-through and uncalled simple wrappers", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      "function client(...args: [string]) {",
      "  return axios.get(...args);",
      "}",
      "function neverCalled(url: string) {",
      "  return axios.post(url);",
      "}",
      'const res = await client("/x");',
      "void res;",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  assert.equal(scan.references.length, 1, "an uncalled simple wrapper records no use");
  const ref = scan.references[0]!;
  assert.equal(ref.resolution, "wrapper");
  assert.equal(ref.callTarget, "axios.get");
  assertChainTokens(files, ref);
});

test("#473 non-exact wrappers stay fail-closed: opaque mapping, conditional body, escape", async () => {
  const cases = [
    // Parameter mapped through a computation: opaque.
    'import axios from "axios"; function client(url: string) { return axios.get(`${url}/x`); } client("/a");',
    // Conditional body: not the exact single-return form.
    'import axios from "axios"; function client(url: string) { if (url) return axios.get(url); return axios.get("/d"); } client("/a");',
    // The wrapper name escapes a direct call site.
    'import axios from "axios"; function client(url: string) { return axios.get(url); } export { client }; client("/a");',
  ];
  for (const source of cases) {
    const files = { "src/a.ts": source };
    const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
    const inner = scan.references.filter(
      (r) => r.resolution === "direct" || r.resolution === "indirect-unknown",
    );
    assert.ok(
      inner.some((r) => r.arguments === "unknown" || r.resolution === "indirect-unknown"),
      `inner call of a non-exact wrapper stays unresolved: ${source}`,
    );
    const sites = scan.references.filter((r) => r.resolution === "wrapper");
    assert.ok(sites.length >= 1, `wrapper call site still cited: ${source}`);
  }
});

test("#473 mutated alias stays fail-closed: member write, reassignment, import-name write", async () => {
  const cases = [
    'import axios from "axios"; const client = axios; client.get = (url: string) => url; client.get("/x");',
    'import axios from "axios"; const client = axios; client = axios; client.get("/x");',
    'import axios from "axios"; axios.defaults = {}; const client = axios; client.get("/x");',
    'import axios from "axios"; const client = axios; delete client.get; client.get("/x");',
  ];
  for (const source of cases) {
    const files = { "src/a.ts": source };
    const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
    const ref = scan.references.find((r) => cited(files, r).includes('"/x"'));
    assert.ok(ref, `the use must be cited, not dropped: ${source}`);
    assert.equal(ref!.resolution, "indirect-unknown", source);
    assert.ok(ref!.note?.includes("written"), source);
    assert.ok(ref!.lineageChain?.brokenAt, source);
  }
});

test("require/destructure and multi-barrel chains cite package entry through use", async () => {
  const files = {
    "src/a.cjs": 'const { get: g } = require("axios"); g("/x");',
    "src/one.ts": 'export { get as g } from "axios";',
    "src/two.ts": 'export { g as h } from "./one";',
    "src/use.ts": 'import { h as local } from "./two"; local("/x");',
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const req = scan.references.find((r) => r.span?.file === "src/a.cjs")!;
  assertChainTokens(files, req);
  assert.deepEqual(
    req.lineageChain!.links.map((l) => l.kind),
    ["require", "call"],
  );
  const barrel = scan.references.find((r) => r.span?.file === "src/use.ts")!;
  assertChainTokens(files, barrel);
  assert.deepEqual(
    barrel.lineageChain!.links.map((l) => l.kind),
    ["re-export", "re-export", "import", "call"],
  );
});

test("dynamic import and uncited wrapper chain keep a location and explicit break", async () => {
  const files = {
    "src/a.ts":
      'const x = import("axios");\nfunction outer() { return inner(); }\nfunction inner() { return x.get("/"); }',
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const dynamic = scan.references.find((r) => r.api === "<dynamic-import>")!;
  assert.equal(dynamic.lineageChain?.brokenAt?.span.file, "src/a.ts");
  assert.match(dynamic.lineageChain!.brokenAt!.reason, /dynamic import/);
});

test("single wrapper cites its internal call, declaration and external invocation", async () => {
  const files = {
    "src/a.ts": [
      'import axios from "axios";',
      'function load() { return axios.get("/x"); }',
      "load();",
    ].join("\n"),
  };
  const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
  const ref = scan.references.find((r) => r.resolution === "wrapper")!;
  assertChainTokens(files, ref);
  assert.deepEqual(
    ref.lineageChain!.links.map((l) => l.kind),
    ["import", "call", "wrapper", "call"],
  );
});

test("shadowed require cannot assert a package-entry edge (parameter, local, function, import)", async () => {
  const cases = [
    'function f(require) { const ax = require("axios"); ax.get("/x"); }',
    'const require = name => ({ get() {} }); const ax = require("axios"); ax.get("/x");',
    'function require(name) { return { get() {} }; } const ax = require("axios"); ax.get("/x");',
    'import { loader as require } from "./loader"; const { get } = require("axios"); get("/x");',
    'function f() { const require = n => ({ get() {} }); const ax = require("axios"); ax.get("/x"); }',
  ];
  for (const source of cases) {
    const files = { "src/a.ts": source };
    const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
    const call = scan.references.find((ref) => cited(files, ref).includes('"/x"'));
    assert.ok(call, `must not drop shadowed loader: ${source}`);
    assert.equal(call.resolution, "indirect-unknown", source);
    assert.ok(call.lineageChain?.brokenAt, source);
    assert.match(call.lineageChain.brokenAt.reason, /require is shadowed/);
  }
});

test("unshadowed lexical require keeps cited package entry", async () => {
  const files = { "src/a.cjs": 'function f() { const ax = require("axios"); ax.get("/x"); }' };
  const ref = (await findMatchedApiReferences(memoryHandle(files), "axios")).references[0]!;
  assert.equal(ref.resolution, "direct");
  assertChainTokens(files, ref);
});

test("source-level require writes cannot produce a complete package-entry chain", async () => {
  const cases = [
    'require = () => ({get(){return "fake"}}); const ax=require("axios"); ax.get("/x");',
    'const ax=require("axios"); globalThis.require = () => ({get(){}}); ax.get("/x");',
    'const ax=require("axios"); globalThis["require"] = () => ({}); ax.get("/x");',
    'function replace() { require = () => ({}); } const ax=require("axios"); ax.get("/x");',
    '({require}={require:()=>({get(){return "fake"}})}); const ax=require("axios"); ax.get("/x");',
    '([require] = [() => ({get(){}})]); const ax=require("axios"); ax.get("/x");',
    'Object.defineProperty(globalThis, "require", {value: () => ({get(){}})}); const ax=require("axios"); ax.get("/x");',
    'Object.assign(globalThis, {require: () => ({get(){}})}); const ax=require("axios"); ax.get("/x");',
  ];
  for (const source of cases) {
    const files = { "src/a.cjs": source };
    const scan = await findMatchedApiReferences(memoryHandle(files), "axios");
    const ref = scan.references.find((r) => cited(files, r).includes('"/x"'))!;
    assert.ok(ref, source);
    assert.equal(ref.resolution, "indirect-unknown", source);
    assert.match(ref.lineageChain!.brokenAt!.reason, /explicitly written/);
  }
});

test("global object alias or escape refuses unbroken require lineage", async () => {
  const cases = [
    'const globals=globalThis; globals.require=()=>({get(){return "fake"}}); const ax=require("axios"); ax.get("/x");',
    'const globals=global; Object.defineProperty(globals, "require", {value:()=>({get(){}})}); const ax=require("axios"); ax.get("/x");',
    'function escape(x) { x.require = () => ({get(){}}); } escape(globalThis); const ax=require("axios"); ax.get("/x");',
    'const ax=require("axios"); console.log(globalThis); ax.get("/x");',
  ];
  for (const source of cases) {
    const files = { "src/a.cjs": source };
    const ref = (await findMatchedApiReferences(memoryHandle(files), "axios")).references.find(
      (r) => cited(files, r).includes('"/x"'),
    )!;
    assert.ok(ref, source);
    assert.equal(ref.resolution, "indirect-unknown", source);
    assert.ok(ref.lineageChain?.brokenAt, source);
  }
});
test("pattern where-looked citations bind files and calls; skipped files remain explicit", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const text = 'import axios from "axios"; axios.get("/é", { timeout: 5 });';
  const [record] = await inspectIncompatiblePatterns(
    memoryHandle({ "src/é.ts": text, "src/large.ts": " ".repeat(1_000_001) }),
    [{ patternId: "responseType", kind: "option-key-value" }],
  );
  assert.ok(record);
  assert.equal(record.capped, true);
  assert.equal(record.whereLooked.eligibility, "js-ts-pattern-files-v1");
  const proof = record.whereLooked.files.find((f) => f.path === "src/é.ts")!;
  assert.equal(proof.byteLength, Buffer.byteLength(text));
  assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    record.whereLooked.calls.some((s) =>
      Buffer.from(text).subarray(s.start, s.end).toString("utf8").includes("axios.get"),
    ),
  );
  assert.deepEqual(record.whereLooked.unchecked, [
    { file: "src/large.ts", reason: "source too large" },
  ]);
});
test("malformed source cannot silently provide negative pattern proof", async () => {
  const { inspectIncompatiblePatterns } = await import("./pattern-inspections.js");
  const malformed = "const broken = (";
  const [record] = await inspectIncompatiblePatterns(
    memoryHandle({ "src/a.ts": 'axios.get("/");', "src/b.ts": malformed }),
    [{ patternId: "timeout", kind: "option-key-value" }],
  );
  assert.ok(record);
  assert.equal(record.state, "uninspectable");
  assert.equal(record.capped, true);
  assert.deepEqual(record.inspectedFiles, ["src/a.ts"]);
  assert.deepEqual(
    record.whereLooked.files.map((f) => f.path),
    ["src/a.ts"],
  );
  assert.ok(
    record.whereLooked.unchecked.some(
      (u) => u.file === "src/b.ts" && u.reason === "source parse diagnostics",
    ),
  );
  const cited = record.uninspectable.find((u) => u.file === "src/b.ts")!;
  assert.ok(Buffer.from(malformed).subarray(cited.start, cited.end).length > 0);
});
