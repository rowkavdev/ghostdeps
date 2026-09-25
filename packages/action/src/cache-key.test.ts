/**
 * cache-key.sh must give a stable, content-derived identity for the action's
 * source tree on a plain action download - the layout a remote `uses:`
# step gets, which has no .git (#347 review). These fixtures never create one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

const SCRIPT = new URL("../scripts/cache-key.sh", import.meta.url).pathname;
const PKGS = ["core", "cli", "action", "checks-renderer"];

let root: string;

async function makeLayout(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "ghostdeps-cache-key-"));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(root, "tsconfig.base.json"), '{"compilerOptions":{}}');
  await writeFile(join(root, "package.json"), '{"packageManager":"pnpm@12.6.0"}');
  for (const p of PKGS) {
    await mkdir(join(root, "packages", p, "src"), { recursive: true });
    await writeFile(join(root, "packages", p, "package.json"), `{"name":"@ghostdeps/${p}"}`);
    await writeFile(join(root, "packages", p, "src", "index.ts"), `export const ${p} = 1;\n`);
  }
  await mkdir(join(root, "packages", "adapters", "rust", "src"), { recursive: true });
  await writeFile(join(root, "packages", "adapters", "rust", "src", "parser.ts"), "// parser\n");
}

function key(cwd: string): string {
  return execFileSync("bash", [SCRIPT, "."], { cwd, encoding: "utf8" }).trim();
}

beforeEach(makeLayout);
afterEach(() => rm(root, { recursive: true, force: true }));

describe("cache-key.sh on a checkout-free action download", () => {
  it("returns a 32-hex identity with no .git present", () => {
    assert.match(key(root), /^[0-9a-f]{32}$/);
  });

  it("is deterministic across runs and CWDs", () => {
    assert.equal(key(root), key(root));
  });

  it("changes when any built source file changes", async () => {
    const before = key(root);
    await writeFile(join(root, "packages", "core", "src", "index.ts"), "// changed\n");
    assert.notEqual(key(root), before);
  });

  it("changes when the lockfile changes", async () => {
    const before = key(root);
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    assert.notEqual(key(root), before);
  });

  it("changes when root build inputs change (compiler config, package manager pin)", async () => {
    const before = key(root);
    await writeFile(join(root, "tsconfig.base.json"), '{"compilerOptions":{"strict":true}}');
    assert.notEqual(key(root), before, "tsconfig.base.json must bust the cache");
    const afterTs = key(root);
    await writeFile(join(root, "package.json"), '{"packageManager":"pnpm@13.0.0"}');
    assert.notEqual(key(root), afterTs, "root package.json must bust the cache");
  });

  it("ignores dist and node_modules content (build outputs are cache, not identity)", async () => {
    const before = key(root);
    await mkdir(join(root, "packages", "core", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "core", "dist", "index.js"), "// built\n");
    await mkdir(join(root, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(join(root, "node_modules", ".pnpm", "x"), "x");
    assert.equal(key(root), before);
  });

  it("fails closed when the layout is not a ghostdeps tree", async () => {
    await rm(join(root, "packages", "core"), { recursive: true, force: true });
    assert.throws(() => key(root));
  });
});
