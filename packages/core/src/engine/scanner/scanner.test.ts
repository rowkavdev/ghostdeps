import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_HEAD_READ_BYTES } from "../../limits.js";
import { readRepositoryFileHead } from "../../repository-head.js";
import type { RepositoryHandle } from "../../types/index.js";
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

  it("caps individual skip records but keeps complete per-reason counts", async () => {
    const scan = await scanRepository(root, { limits: { maxSkippedRecords: 1 } });
    assert.equal(scan.skipped.length, 1);
    assert.equal(scan.skippedCounts["unsafe-name"], 2);
  });

  it("truncates to the same files regardless of readdir order", async () => {
    const scan = await scanRepository(root, { limits: { maxFiles: 3 } });
    assert.deepEqual(
      scan.files.map((f) => f.path),
      ["a/b/c/d/e/deep.txt", "big.txt", "yarn.lock"],
    );
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

describe("FsRepositoryHandle.readFileHead (#113)", () => {
  let root: string;
  let outside: string;
  const multi = "aé€😀z\nsecond line";

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ghostdeps-head-"));
    outside = await mkdtemp(path.join(tmpdir(), "ghostdeps-head-out-"));
    await tree(outside, { "secret.txt": "do not read" });
    await tree(root, {
      "multi.txt": multi,
      "yarn.lock": `__metadata:\n  version: 8\n${"x".repeat(200)}`,
      "img.png": Buffer.from([0x89, 0x50, 0x00, 0x47]),
      "swap.ts": "export {};",
    });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("matches the readFile fallback byte for byte on valid UTF-8, across multibyte boundaries", async () => {
    const repo = await FsRepositoryHandle.open(root);
    const fallback: RepositoryHandle = {
      listFiles: () => repo.listFiles(),
      readFile: (p) => repo.readFile(p),
      exists: (p) => repo.exists(p),
    };
    for (let n = 0; n <= Buffer.byteLength(multi) + 2; n++) {
      const head = await repo.readFileHead("multi.txt", n);
      assert.equal(head, await readRepositoryFileHead(fallback, "multi.txt", n), `maxBytes ${n}`);
      assert.ok(!head!.includes("\ufffd"));
    }
    assert.equal(await repo.readFileHead("multi.txt", 5), "aé");
  });

  it("reads the head of a file past its size ceiling (the point of a head read)", async () => {
    const repo = await FsRepositoryHandle.open(root, { limits: { maxLockfileBytes: 1024 } });
    await writeFile(path.join(root, "yarn.lock"), `__metadata:\n${"y".repeat(4096)}`);
    await assert.rejects(repo.readFile("yarn.lock"));
    assert.equal(await repo.readFileHead("yarn.lock", 11), "__metadata:");
  });

  it("clamps a huge maxBytes to MAX_HEAD_READ_BYTES on a file past its ceiling", async () => {
    // Write after the scan: the scanner does not list files already past the ceiling.
    await writeFile(path.join(root, "yarn.lock"), "__metadata:\n");
    const repo = await FsRepositoryHandle.open(root, { limits: { maxLockfileBytes: 1024 } });
    await writeFile(path.join(root, "yarn.lock"), "z".repeat(MAX_HEAD_READ_BYTES * 3));
    await assert.rejects(repo.readFile("yarn.lock"));
    for (const maxBytes of [MAX_HEAD_READ_BYTES + 1, 10 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      const head = await repo.readFileHead("yarn.lock", maxBytes);
      assert.equal(head?.length, MAX_HEAD_READ_BYTES, `maxBytes ${maxBytes}`);
    }
  });

  it("resolves undefined for unlisted, escaping, binary and swapped files", async () => {
    const repo = await FsRepositoryHandle.open(root);
    assert.equal(await repo.readFileHead("missing.txt", 10), undefined);
    assert.equal(await repo.readFileHead("../secret.txt", 10), undefined);
    assert.equal(await repo.readFileHead("img.png", 1), undefined);
    await unlink(path.join(root, "swap.ts"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "swap.ts"));
    assert.equal(await repo.readFileHead("swap.ts", 10), undefined);
  });
});

describe("opt-in fixture scope accounting (#354)", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ghostdeps-scope-"));
    await tree(root, {
      "package.json": "{}",
      "fixtures/package.json": "{}",
      "fixtures/nested/pyproject.toml": "[project]",
      "fixtures/nested/source.ts": "export {};",
      "fixtures-old/package.json": "{}",
    });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const config = async (root: string, fixtureRoots: unknown) =>
    writeFile(
      path.join(root, ".ghostdeps.json"),
      JSON.stringify({ schemaVersion: 1, fixtureRoots }),
    );

  it("defaults to no fixture exclusion and reports the empty state when explicitly requested", async () => {
    const ordinary = await scanRepository(root);
    assert.equal(ordinary.scope, undefined);
    assert.ok(ordinary.files.some((f) => f.path === "fixtures/package.json"));
    const scoped = await scanRepository(root, { fixtureScope: true });
    assert.deepEqual(scoped.scope?.roots, []);
    assert.equal(scoped.scope?.source, "none");
    assert.equal(scoped.scope?.excludedFiles, 0);
    assert.ok(scoped.files.some((f) => f.path === "fixtures/package.json"));
  });

  it("excludes component-matched roots, counts manifests and leaves a bounded audit record", async () => {
    await config(root, ["fixtures"]);
    const scan = await scanRepository(root, {
      fixtureScope: true,
      limits: { maxSkippedRecords: 0 },
    });
    assert.deepEqual(scan.scope?.roots, [
      { root: "fixtures", matched: true, files: 3, manifests: 2 },
    ]);
    assert.equal(scan.scope?.excludedFiles, 3);
    assert.equal(scan.scope?.excludedManifests, 2);
    assert.equal(scan.skippedCounts["fixture-root"], 1);
    assert.deepEqual(scan.skipped, []);
    assert.ok(scan.files.some((f) => f.path === "fixtures-old/package.json"));
    assert.ok(!scan.files.some((f) => f.path.startsWith("fixtures/")));
    const handle = await FsRepositoryHandle.open(root, { fixtureScope: true });
    await assert.rejects(
      handle.readFile("fixtures/package.json"),
      (e: unknown) => e instanceof RepositoryReadError && e.code === "not-listed",
    );
    assert.equal(
      (await scanRepository(root, { fixtureScope: true })).scope?.digest,
      scan.scope?.digest,
    );
  });

  it("discloses an unmatched root with exact zero counts", async () => {
    await config(root, ["missing"]);
    const scan = await scanRepository(root, { fixtureScope: true });
    assert.deepEqual(scan.scope?.roots, [
      { root: "missing", matched: false, files: 0, manifests: 0 },
    ]);
    assert.equal(scan.scope?.matchedRoots, 0);
  });

  it("fails visibly on malformed, overlapping and unsafe declarations", async () => {
    for (const roots of [
      ["fixtures", "fixtures/nested"],
      ["fixtures", "fixtures"],
      ["../escape"],
      ["/absolute"],
      ["fixtures/*"],
      ["fixtures\\nested"],
      ["fixtures\u202e"],
      ["node_modules/hidden"],
    ]) {
      await config(root, roots);
      await assert.rejects(scanRepository(root, { fixtureScope: true }));
    }
    await writeFile(path.join(root, ".ghostdeps.json"), '{"schemaVersion":2,"fixtureRoots":[]}');
    await assert.rejects(scanRepository(root, { fixtureScope: true }));
    await writeFile(
      path.join(root, ".ghostdeps.json"),
      '{"schemaVersion":1,"fixtureRoots":[],"hide":true}',
    );
    await assert.rejects(scanRepository(root, { fixtureScope: true }));
    await writeFile(path.join(root, ".ghostdeps.json"), "x".repeat(16385));
    await assert.rejects(scanRepository(root, { fixtureScope: true }));
  });

  it("refuses symlinked config, symlinked roots and uncertain counts", async () => {
    await rm(path.join(root, ".ghostdeps.json"), { force: true });
    await symlink(path.join(root, "package.json"), path.join(root, ".ghostdeps.json"));
    await assert.rejects(scanRepository(root, { fixtureScope: true }));
    await rm(path.join(root, ".ghostdeps.json"));
    await symlink(path.join(root, "fixtures"), path.join(root, "linked"));
    await config(root, ["linked"]);
    await assert.rejects(scanRepository(root, { fixtureScope: true }));
    await config(root, ["fixtures"]);
    await assert.rejects(scanRepository(root, { fixtureScope: true, limits: { maxFiles: 2 } }));
    await symlink(path.join(root, "package.json"), path.join(root, "fixtures", "linked.json"));
    await assert.rejects(scanRepository(root, { fixtureScope: true }));
  });
});
