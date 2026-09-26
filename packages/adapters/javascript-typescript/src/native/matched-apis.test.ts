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
  assert.equal(ref!.lineage[0]!.kind, "alias");
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
