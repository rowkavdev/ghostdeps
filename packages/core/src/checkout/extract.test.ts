import assert from "node:assert/strict";
import { readFile, stat, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ExtractionError } from "./errors.js";
import { extractTarball, type ExtractionSummary } from "./extract.js";
import { buildTar, chunk, type TestEntry } from "./testing.js";

let counter = 0;
function dest(): string {
  return join(tmpdir(), `ghostdeps-extract-test-${process.pid}-${counter++}`);
}

async function extract(
  entries: TestEntry[],
  limits?: Parameters<typeof extractTarball>[1]["limits"],
): Promise<{ summary: ExtractionSummary; dir: string }> {
  const dir = dest();
  const summary = await extractTarball(
    chunk(buildTar(entries), 997),
    limits === undefined ? { destDir: dir } : { destDir: dir, limits },
  );
  return { summary, dir };
}

async function expectRejects(
  entries: TestEntry[],
  code: string,
  limits?: Parameters<typeof extractTarball>[1]["limits"],
): Promise<void> {
  const dir = dest();
  await assert.rejects(
    extractTarball(
      chunk(buildTar(entries), 997),
      limits === undefined ? { destDir: dir } : { destDir: dir, limits },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionError, `expected ExtractionError, got ${error}`);
      assert.equal(error.code, code);
      return true;
    },
  );
  // All-or-nothing: the destination must be gone after a rejection.
  await assert.rejects(stat(dir), /ENOENT/);
}

describe("extractTarball", () => {
  it("extracts a clean tree with exact contents and safe modes", async () => {
    const { summary, dir } = await extract([
      { name: "repo/", type: "directory" },
      { name: "repo/package.json", data: '{"name":"x"}', mode: 0o100777 },
      { name: "repo/src/index.ts", data: "export {}\n" },
      { name: "repo/empty.txt", data: "" },
    ]);
    assert.equal(summary.files, 3);
    assert.equal(summary.directories, 1);
    assert.equal(await readFile(join(dir, "repo/package.json"), "utf8"), '{"name":"x"}');
    assert.equal(await readFile(join(dir, "repo/src/index.ts"), "utf8"), "export {}\n");
    // Archive modes are ignored: 0777 in, 0644 out, never executable.
    const mode = (await stat(join(dir, "repo/package.json"))).mode & 0o777;
    assert.equal(mode, 0o644);
  });

  it("accepts dot segments and deep nesting within limits", async () => {
    const { dir } = await extract([
      { name: "a/./b/c.txt", data: "ok" },
      { name: "a/d//e.txt", data: "ok2" },
    ]);
    assert.equal(await readFile(join(dir, "a/b/c.txt"), "utf8"), "ok");
    assert.equal(await readFile(join(dir, "a/d/e.txt"), "utf8"), "ok2");
  });

  it("rejects ../ traversal, absolute, Windows and UNC paths", async () => {
    const cases: Array<[string, string]> = [
      ["../evil.txt", "PATH_TRAVERSAL"],
      ["a/../../evil.txt", "PATH_TRAVERSAL"],
      ["..\\evil.txt", "PATH_TRAVERSAL"],
      ["a\\..\\..\\evil.txt", "PATH_TRAVERSAL"],
      ["/etc/passwd", "ABSOLUTE_PATH"],
      ["C:\\Windows\\system32\\evil", "ABSOLUTE_PATH"],
      ["C:/Windows/evil", "ABSOLUTE_PATH"],
      ["C:relative-evil", "ABSOLUTE_PATH"],
      ["\\\\server\\share\\evil", "ABSOLUTE_PATH"],
      ["//server/share/evil", "ABSOLUTE_PATH"],
      ["..", "PATH_TRAVERSAL"],
    ];
    for (const [name, code] of cases) {
      await expectRejects([{ name, data: "x" }], code);
    }
  });

  it("rejects Unicode segments that NFKC-fold into separators or dots", async () => {
    // U+FF0F fullwidth solidus folds to '/', U+FF0E fullwidth full stop to '.'.
    await expectRejects([{ name: "a／b.txt", data: "x" }], "UNICODE_PATH_FOLDING");
    await expectRejects([{ name: "‥/evil.txt", data: "x" }], "UNICODE_PATH_FOLDING");
  });

  it("records symlinks as metadata and never materialises them", async () => {
    // Links are data for the RepositoryHandle: absolute, escaping, broken
    // and looping targets are all recorded verbatim, and nothing appears
    // on disk that anything could follow.
    const { summary, dir } = await extract([
      { name: "pkg/real.txt", data: "content" },
      { name: "pkg/alias", type: "symlink", linkName: "real.txt" },
      { name: "abs", type: "symlink", linkName: "/etc/passwd" },
      { name: "esc", type: "symlink", linkName: "../../../outside" },
      { name: "broken", type: "symlink", linkName: "no/such/file" },
    ]);
    assert.equal(summary.symlinks, 4);
    assert.deepEqual(summary.links, [
      { path: "pkg/alias", target: "real.txt" },
      { path: "abs", target: "/etc/passwd" },
      { path: "esc", target: "../../../outside" },
      { path: "broken", target: "no/such/file" },
    ]);
    // The file extracted; none of the links exist on disk.
    assert.equal(await readFile(join(dir, "pkg/real.txt"), "utf8"), "content");
    for (const linkPath of ["pkg/alias", "abs", "esc", "broken"]) {
      await assert.rejects(lstat(join(dir, linkPath)), /ENOENT/);
    }
  });

  it("is immune to resolution-order escapes by construction (independent-review PoCs)", async () => {
    // First PoC: deep link pointing at the root, later target 'L/../..'.
    // Second: link target whose meaning changes when a later link lands.
    // Both archives now extract: links are metadata, so there is nothing
    // on disk to follow and no resolution order to get wrong.
    const first = await extract([
      { name: "a/b/c/L", type: "symlink", linkName: "../../.." },
      { name: "a/b/c/M", type: "symlink", linkName: "L/../.." },
    ]);
    assert.equal(first.summary.symlinks, 2);
    await assert.rejects(lstat(join(first.dir, "a/b/c/L")), /ENOENT/);
    await assert.rejects(lstat(join(first.dir, "a/b/c/M")), /ENOENT/);

    const second = await extract([
      { name: "L", type: "symlink", linkName: "x/y/z" },
      { name: "x", type: "symlink", linkName: "." },
      { name: "M", type: "symlink", linkName: "L/../../.." },
    ]);
    assert.equal(second.summary.symlinks, 3);
    for (const linkPath of ["L", "x", "M"]) {
      await assert.rejects(lstat(join(second.dir, linkPath)), /ENOENT/);
    }
  });

  it("treats writes under a recorded link's path as literal paths", async () => {
    // b is recorded as a link; b/x.txt is a separate literal entry and is
    // written literally (real archives carry both when the tree has both).
    const { dir } = await extract([
      { name: "sub/", type: "directory" },
      { name: "b", type: "symlink", linkName: "sub" },
      { name: "b/x.txt", data: "literal" },
    ]);
    assert.equal(await readFile(join(dir, "b/x.txt"), "utf8"), "literal");
    await assert.rejects(lstat(join(dir, "sub/x.txt")), /ENOENT/);
  });

  it("treats case-only and Unicode-normalisation collisions as duplicates", async () => {
    // Map keys are case-folded + NFC so the check is at least as strict as
    // the most lenient filesystem a checkout can land on.
    await expectRejects(
      [
        { name: "A.txt", data: "1" },
        { name: "a.txt", data: "2" },
      ],
      "DUPLICATE_PATH",
    );
    await expectRejects(
      [
        { name: "caf\u00e9.txt", data: "nfc" },
        { name: "cafe\u0301.txt", data: "nfd" },
      ],
      "DUPLICATE_PATH",
    );
  });

  it("rejects hardlinks to missing targets and validates hardlink paths", async () => {
    await expectRejects(
      [{ name: "h", type: "hardlink", linkName: "not-there.txt" }],
      "LINK_TARGET_MISSING",
    );
    await expectRejects(
      [
        { name: "real.txt", data: "x" },
        { name: "h", type: "hardlink", linkName: "../real.txt" },
      ],
      "PATH_TRAVERSAL",
    );
    const { dir } = await extract([
      { name: "real.txt", data: "shared" },
      { name: "hard", type: "hardlink", linkName: "real.txt" },
    ]);
    assert.equal(await readFile(join(dir, "hard"), "utf8"), "shared");
  });

  it("rejects duplicate paths", async () => {
    await expectRejects(
      [
        { name: "a.txt", data: "1" },
        { name: "a.txt", data: "2" },
      ],
      "DUPLICATE_PATH",
    );
    await expectRejects(
      [
        { name: "d/", type: "directory" },
        { name: "d", type: "symlink", linkName: "x" },
      ],
      "DUPLICATE_PATH",
    );
  });

  it("enforces per-file, total, count, depth and length ceilings", async () => {
    await expectRejects(
      [{ name: "big.bin", data: new Uint8Array(2048), declaredSize: 2048 }],
      "FILE_TOO_LARGE",
      { maxFileBytes: 1024 },
    );
    await expectRejects(
      [
        { name: "a.bin", data: new Uint8Array(900), declaredSize: 900 },
        { name: "b.bin", data: new Uint8Array(900), declaredSize: 900 },
      ],
      "TOTAL_SIZE_EXCEEDED",
      { maxTotalBytes: 1500, maxFileBytes: 1024 },
    );
    await expectRejects(
      [
        { name: "a.txt", data: "" },
        { name: "b.txt", data: "" },
        { name: "c.txt", data: "" },
      ],
      "TOO_MANY_ENTRIES",
      { maxEntries: 2 },
    );
    await expectRejects([{ name: "a/b/c/d.txt", data: "x" }], "TOO_DEEP", { maxDepth: 3 });
    await expectRejects([{ name: `${"n".repeat(64)}.txt`, data: "x" }], "PATH_TOO_LONG", {
      maxPathBytes: 32,
    });
  });

  it("rejects entries normalising to nothing", async () => {
    await expectRejects([{ name: "./", data: "x" }], "PATH_TRAVERSAL");
    await expectRejects([{ name: ".", data: "x" }], "PATH_TRAVERSAL");
  });

  it("leaves nothing behind when any entry is hostile", async () => {
    const parent = dest();
    const dir = join(parent, "fresh");
    await assert.rejects(
      extractTarball(
        chunk(
          buildTar([
            { name: "good.txt", data: "written first" },
            { name: "../evil.txt", data: "nope" },
          ]),
        ),
        { destDir: dir },
      ),
      (error: unknown) => error instanceof ExtractionError && error.code === "PATH_TRAVERSAL",
    );
    await assert.rejects(stat(dir), /ENOENT/);
  });

  it("refuses a non-empty destination", async () => {
    const { dir } = await extract([{ name: "a.txt", data: "x" }]);
    await assert.rejects(
      extractTarball(chunk(buildTar([{ name: "b.txt", data: "y" }])), { destDir: dir }),
      (error: unknown) =>
        error instanceof ExtractionError && error.code === "DESTINATION_NOT_EMPTY",
    );
    // The pre-existing tree is untouched.
    assert.deepEqual(await readdir(dir), ["a.txt"]);
  });
});
