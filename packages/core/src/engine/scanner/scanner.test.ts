import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FsRepositoryHandle, RepositoryReadError } from "./handle.js";
import { DEFAULT_SCAN_LIMITS, resolveLimits } from "./limits.js";
import { scanRepository } from "./scanner.js";

// dist/engine/scanner -> repository root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const fixtures = path.join(repoRoot, "fixtures");

async function tree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

const reasonOf = (scan: { skipped: { path: string; reason: string }[] }, p: string) =>
  scan.skipped.find((s) => s.path === p)?.reason;

describe("scanRepository over fixtures/", () => {
  it("lists fixtures/js/basic-unused and surfaces its project root", async () => {
    const scan = await scanRepository(path.join(fixtures, "js/basic-unused"));
    const paths = scan.files.map((f) => f.path);
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("src/index.js"));
    assert.equal(scan.truncated, undefined);
    assert.deepEqual(scan.candidateProjectRoots, [
      { path: ".", manifests: ["package.json"], ecosystemHints: ["javascript-typescript"] },
    ]);
  });

  it("is deterministic and sorted across the whole fixtures tree", async () => {
    const a = await scanRepository(fixtures);
    const b = await scanRepository(fixtures);
    assert.deepEqual(a.files, b.files);
    const paths = a.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(a.candidateProjectRoots.some((r) => r.path === "js/basic-unused"));
  });
});

describe("scanRepository rules", () => {
  let root: string;
  let outside: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ghostdeps-scan-"));
    outside = await mkdtemp(path.join(tmpdir(), "ghostdeps-outside-"));
    await tree(outside, { "secret.txt": "do not read" });
    await tree(root, {
      "package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "src/index.ts": "export {};",
      "node_modules/leftpad/index.js": "module.exports = 1;",
      "vendor/github.com/x/y.go": "package y",
      "dist/bundle.js": "x",
      "packages/api/pyproject.toml": "[project]",
      "packages/api/requirements.txt": "",
      "packages/web/package.json": "{}",
      "packages/web/app.min.js": "x",
      "packages/web/app.js.map": "{}",
      "crates/agent/Cargo.toml": "[package]",
      "services/go/go.mod": "module x",
    });
    await symlink(outside, path.join(root, "escape-dir"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape-file.txt"));
    await symlink(".", path.join(root, "loop"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("never follows symlinks, inside or outside the root", async () => {
    const scan = await scanRepository(root);
    const paths = scan.files.map((f) => f.path);
    assert.ok(!paths.some((p) => p.startsWith("escape") || p.startsWith("loop")));
    assert.equal(reasonOf(scan, "escape-dir"), "symlink");
    assert.equal(reasonOf(scan, "escape-file.txt"), "symlink");
    assert.equal(reasonOf(scan, "loop"), "symlink");
  });

  it("excludes node_modules, vendor and dist by default, recording each once", async () => {
    const scan = await scanRepository(root);
    const paths = scan.files.map((f) => f.path);
    assert.ok(!paths.some((p) => /(^|\/)(node_modules|vendor|dist)\//.test(p)));
    assert.equal(reasonOf(scan, "node_modules"), "excluded-directory");
    assert.equal(reasonOf(scan, "vendor"), "excluded-directory");
    assert.equal(reasonOf(scan, "dist"), "excluded-directory");
    assert.equal(scan.skipped.filter((s) => s.path.startsWith("node_modules")).length, 1);
  });

  it("skips minified bundles and source maps but always keeps lockfiles", async () => {
    const scan = await scanRepository(root);
    assert.equal(reasonOf(scan, "packages/web/app.min.js"), "excluded-generated-file");
    assert.equal(reasonOf(scan, "packages/web/app.js.map"), "excluded-generated-file");
    const lock = scan.files.find((f) => f.path === "pnpm-lock.yaml");
    assert.equal(lock?.lockfile, true);
  });

  it("surfaces nested and polyglot candidate project roots", async () => {
    const scan = await scanRepository(root);
    assert.deepEqual(scan.candidateProjectRoots, [
      { path: ".", manifests: ["package.json"], ecosystemHints: ["javascript-typescript"] },
      { path: "crates/agent", manifests: ["Cargo.toml"], ecosystemHints: ["rust"] },
      {
        path: "packages/api",
        manifests: ["pyproject.toml", "requirements.txt"],
        ecosystemHints: ["python"],
      },
      {
        path: "packages/web",
        manifests: ["package.json"],
        ecosystemHints: ["javascript-typescript"],
      },
      { path: "services/go", manifests: ["go.mod"], ecosystemHints: ["go"] },
    ]);
  });

  it("allows callers to replace the exclusion list", async () => {
    const scan = await scanRepository(root, { excludedDirectories: new Set() });
    assert.ok(scan.files.some((f) => f.path === "dist/bundle.js"));
  });

  it("refuses a symlinked or non-directory root", async () => {
    await assert.rejects(scanRepository(path.join(root, "escape-dir")), /symlink/);
    await assert.rejects(scanRepository(path.join(root, "package.json")), /directory/);
  });
});

describe("scanRepository ceilings", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ghostdeps-limits-"));
    const files: Record<string, string> = {
      "big.txt": "x".repeat(200),
      "yarn.lock": "y".repeat(200),
    };
    for (let i = 0; i < 10; i += 1) files[`many/f${i}.txt`] = "abc";
    files["a/b/c/d/e/deep.txt"] = "deep";
    await tree(root, files);
    await writeFile(path.join(root, "bad\nname.txt"), "x");
    await writeFile(
      Buffer.concat([Buffer.from(root + "/"), Buffer.from([0x62, 0xff, 0x2e, 0x74])]),
      "x",
    );
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips oversized files but gives lockfiles their own ceiling", async () => {
    const scan = await scanRepository(root, {
      limits: { maxFileBytes: 100, maxLockfileBytes: 1000 },
    });
    assert.equal(reasonOf(scan, "big.txt"), "file-too-large");
    assert.ok(scan.files.some((f) => f.path === "yarn.lock"));
  });

  it("truncates at maxFiles instead of throwing", async () => {
    const scan = await scanRepository(root, { limits: { maxFiles: 5 } });
    assert.equal(scan.truncated, "max-files");
    assert.equal(scan.files.length, 5);
  });

  it("truncates at maxTotalBytes", async () => {
    const scan = await scanRepository(root, { limits: { maxTotalBytes: 250 } });
    assert.equal(scan.truncated, "max-total-bytes");
    assert.ok(scan.totalBytes <= 250);
  });

  it("truncates at maxDirectories", async () => {
    const scan = await scanRepository(root, { limits: { maxDirectories: 2 } });
    assert.equal(scan.truncated, "max-directories");
  });

  it("skips directories deeper than maxDepth", async () => {
    const scan = await scanRepository(root, { limits: { maxDepth: 2 } });
    assert.equal(reasonOf(scan, "a/b/c"), "too-deep");
    assert.ok(!scan.files.some((f) => f.path.endsWith("deep.txt")));
  });

  it("skips control-character and non-UTF-8 names", async () => {
    const scan = await scanRepository(root);
    assert.ok(!scan.files.some((f) => f.path.includes("\n") || f.path.includes("\ufffd")));
    assert.equal(scan.skipped.filter((s) => s.reason === "unsafe-name").length, 2);
  });

  it("validates limit overrides", () => {
    assert.throws(() => resolveLimits({ maxFiles: -1 }), RangeError);
    assert.throws(() => resolveLimits({ maxFiles: 1.5 }), RangeError);
    assert.deepEqual(resolveLimits(), { ...DEFAULT_SCAN_LIMITS });
  });
});

describe("FsRepositoryHandle", () => {
  let root: string;
  let outside: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ghostdeps-handle-"));
    outside = await mkdtemp(path.join(tmpdir(), "ghostdeps-handle-out-"));
    await tree(outside, { "secret.txt": "do not read" });
    await tree(root, {
      "package.json": '{"name":"x"}',
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
      "img.png": Buffer.from([0x89, 0x50, 0x00, 0x47]),
      "grow.txt": "small",
      "node_modules/x/index.js": "",
    });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("lists and reads scanned files", async () => {
    const repo = await FsRepositoryHandle.open(root);
    assert.deepEqual(await repo.listFiles(), [
      "grow.txt",
      "img.png",
      "package.json",
      "src/a.ts",
      "src/b.ts",
    ]);
    assert.equal(await repo.readFile("package.json"), '{"name":"x"}');
    assert.equal(await repo.readFile("./src/a.ts"), "export const a = 1;");
    assert.equal(await repo.exists("src/a.ts"), true);
    assert.equal(await repo.exists("node_modules/x/index.js"), false);
  });

  it("refuses paths that were not listed or escape the root", async () => {
    const repo = await FsRepositoryHandle.open(root);
    for (const p of ["../x", "/etc/passwd", "node_modules/x/index.js", "src\\a.ts", "missing"]) {
      await assert.rejects(repo.readFile(p), (e: unknown) => {
        return e instanceof RepositoryReadError && e.code === "not-listed";
      });
      assert.equal(await repo.exists(p), false);
    }
  });

  it("refuses binary files", async () => {
    const repo = await FsRepositoryHandle.open(root);
    await assert.rejects(repo.readFile("img.png"), (e: unknown) => {
      return e instanceof RepositoryReadError && e.code === "binary";
    });
  });

  it("refuses a file swapped for a symlink after the scan", async () => {
    const repo = await FsRepositoryHandle.open(root);
    await unlink(path.join(root, "src/b.ts"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "src/b.ts"));
    await assert.rejects(repo.readFile("src/b.ts"), (e: unknown) => {
      return e instanceof RepositoryReadError && e.code === "changed";
    });
  });

  it("refuses a parent directory swapped for a symlink after the scan", async () => {
    const repo = await FsRepositoryHandle.open(root);
    await rm(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(outside, "src"));
    await writeFile(path.join(outside, "src/a.ts"), "outside");
    await symlink(path.join(outside, "src"), path.join(root, "src"));
    await assert.rejects(repo.readFile("src/a.ts"), (e: unknown) => {
      return e instanceof RepositoryReadError && e.code === "changed";
    });
  });

  it("refuses a file that grew past its ceiling after the scan", async () => {
    const repo = await FsRepositoryHandle.open(root, { limits: { maxFileBytes: 10 } });
    await writeFile(path.join(root, "grow.txt"), "x".repeat(50));
    await assert.rejects(repo.readFile("grow.txt"), (e: unknown) => {
      return e instanceof RepositoryReadError && e.code === "too-large";
    });
  });
});
