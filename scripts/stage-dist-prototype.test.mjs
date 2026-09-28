import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, cwd) =>
  spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });

test("experimental dist staging packs without unpublished workspace names or declarations", () => {
  const out = path.join(root, `.npm-dist-test-${process.pid}`);
  try {
    const staged = run(
      process.execPath,
      ["scripts/stage-dist-prototype.mjs", "--version", "0.1.999", "--out", out],
      root,
    );
    assert.equal(staged.status, 0, staged.stderr);
    const packed = run("npm", ["pack", "--dry-run", "--json"], out);
    assert.equal(packed.status, 0, packed.stderr);
    const [tarball] = JSON.parse(packed.stdout);
    const paths = new Set(tarball.files.map(({ path: p }) => p));
    assert.ok(paths.has("dist/main.js"));
    assert.ok(paths.has("dist/internal/core/engine/adapter-worker.js"));
    for (const name of ["core", "go", "javascript-typescript", "python", "rust"])
      assert.ok(paths.has(`dist/internal/${name}/index.js`));
    for (const name of ["go", "javascript-typescript", "python", "rust"])
      assert.ok(paths.has(`dist/internal/${name}/worker-entry.js`));
    assert.ok(
      [...paths].every(
        (p) =>
          !p.endsWith(".d.ts") &&
          !p.includes("node_modules/@ghostdeps/") &&
          !p.endsWith(".test.js"),
      ),
    );
    const manifest = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
    assert.ok(Object.keys(manifest.dependencies).every((name) => !name.startsWith("@ghostdeps/")));
    assert.deepEqual(manifest.bundledDependencies, ["tree-sitter-rust", "web-tree-sitter"]);
    assert.ok(paths.has("node_modules/tree-sitter-rust/tree-sitter-rust.wasm"));
    assert.ok(paths.has("node_modules/web-tree-sitter/web-tree-sitter.wasm"));
    assert.ok(!paths.has("node_modules/tree-sitter-rust/binding.gyp"));
    assert.ok(!paths.has("node_modules/tree-sitter-rust/src/parser.cc"));
    assert.equal(tarball.name, "ghost-deps");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// Inject a compiled JS file, not source TS: staging must inspect precisely the
// bytes a future build could emit. Remove it even when a negative test fails.
test("staging fails closed on internal module-resolution forms", () => {
  const built = path.join(root, "packages/cli/dist/__stage_resolution_probe.js");
  const out = path.join(root, `.npm-dist-test-${process.pid}-resolution`);
  const rejected = [
    ['require.resolve("@ghostdeps/core")', /unsupported require\.resolve internal specifier/],
    [
      'import.meta.resolve("@ghostdeps/core")',
      /unsupported import\.meta\.resolve internal specifier/,
    ],
    [
      'const require = createRequire(import.meta.url); require.resolve("@ghostdeps/core")',
      /unsupported require\.resolve internal specifier/,
    ],
    ['module.require("@ghostdeps/core")', /unsupported module\.require internal specifier/],
    [
      'const req = createRequire(import.meta.url); req("@ghostdeps/core")',
      /unsupported internal specifier form/,
    ],
    ['require["resolve"]("@ghostdeps/core")', /unsupported internal specifier form/],
    ['const r = require.resolve; r("@ghostdeps/core")', /unsupported internal specifier form/],
    ['const r = import.meta.resolve; r("@ghostdeps/core")', /unsupported internal specifier form/],
    ['const spec = "@ghostdeps/core"; import(spec)', /unsupported internal specifier form/],
    [
      'const r = createRequire(import.meta.url); r.resolve("@ghostdeps/core")',
      /unsupported internal specifier form/,
    ],
    ["import(`@ghostdeps/core`)", /nonliteral import module resolution/],
    ['import("@ghostdeps/core/unknown")', /unmapped internal specifier/],
  ];
  try {
    for (const [source, expected] of rejected) {
      writeFileSync(built, `${source};\n`);
      const result = run(
        process.execPath,
        ["scripts/stage-dist-prototype.mjs", "--version", "0.1.999", "--out", out],
        root,
      );
      assert.notEqual(result.status, 0, `staging accepted ${source}`);
      assert.match(result.stderr, expected, source);
    }
    writeFileSync(built, 'import.meta.resolve("@ghostdeps/core");\n');
    const negative = run(
      process.execPath,
      ["scripts/stage-dist-prototype.mjs", "--version", "0.1.999", "--out", out],
      root,
    );
    assert.notEqual(negative.status, 0);
    writeFileSync(built, 'import("@ghostdeps/core");\nrequire("@ghostdeps/core");\n');
    const positive = run(
      process.execPath,
      ["scripts/stage-dist-prototype.mjs", "--version", "0.1.999", "--out", out],
      root,
    );
    assert.equal(positive.status, 0, positive.stderr);
    const staged = readFileSync(path.join(out, "dist/__stage_resolution_probe.js"), "utf8");
    assert.doesNotMatch(staged, /@ghostdeps\/core/);
    assert.match(staged, /\.\/internal\/core\/index\.js/);
  } finally {
    rmSync(built, { force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
