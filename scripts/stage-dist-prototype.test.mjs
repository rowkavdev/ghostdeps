import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
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
