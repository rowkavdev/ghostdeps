import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { addedLines, parseUnifiedDiff } from "./unified.js";

const recorded = (name: string): string =>
  readFileSync(new URL(`../../test/diffs/${name}`, import.meta.url), "utf8");

describe("parseUnifiedDiff on a recorded PR diff", () => {
  const parsed = parseUnifiedDiff(recorded("js-add-axios.diff"));
  const byPath = (path: string) => parsed.files.find((f) => (f.newPath ?? f.oldPath) === path);

  it("finds every file with no problems", () => {
    assert.equal(parsed.truncated, false);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(
      parsed.files.map((f) => `${f.status} ${f.newPath ?? f.oldPath}`),
      [
        "added café.txt",
        "deleted gone.js",
        "modified logo.png",
        "renamed new name.txt",
        "modified package.json",
        "modified pnpm-lock.yaml",
        "modified src/index.js",
        "added src/nonl.js",
      ],
    );
  });

  it("reads renames, binaries and deletions", () => {
    assert.equal(byPath("new name.txt")?.oldPath, "old name.txt");
    assert.equal(byPath("logo.png")?.binary, true);
    assert.equal(byPath("gone.js")?.newPath, undefined);
    assert.equal(byPath("gone.js")?.oldPath, "gone.js");
  });

  it("tracks line numbers on both sides", () => {
    const pkg = byPath("package.json")!;
    assert.equal(pkg.hunks.length, 1);
    const hunk = pkg.hunks[0]!;
    assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [2, 10, 2, 9]);
    const adds = hunk.lines.filter((l) => l.type === "add");
    const dels = hunk.lines.filter((l) => l.type === "del");
    assert.deepEqual(
      adds.map((l) => [l.newLine, l.text.trim()]),
      [
        [5, '"axios": "^1.7.0",'],
        [7, '"lodash": "^4.17.21"'],
        [9, '"devDependencies": {}'],
      ],
    );
    assert.deepEqual(
      dels.map((l) => l.oldLine),
      [6, 8, 9, 10],
    );
  });

  it("returns added source lines for usage analysis", () => {
    assert.deepEqual(addedLines(byPath("src/index.js")!), [
      { line: 2, text: 'import axios from "axios";' },
      { line: 4, text: "export const get = (u) => axios.get(u);" },
    ]);
    assert.deepEqual(addedLines(byPath("src/nonl.js")!), [{ line: 1, text: "no newline" }]);
  });
});

describe("parseUnifiedDiff on malformed and hostile input", () => {
  it("never throws and returns nothing for garbage", () => {
    for (const input of ["", "hello\nworld", "@@ -1 +1 @@\n+x", "diff --git\n", "\u0000\u202e"]) {
      const parsed = parseUnifiedDiff(input);
      assert.ok(Array.isArray(parsed.files));
    }
  });

  it("reports a hunk that ends early", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-1\n+2\n",
    );
    assert.equal(parsed.files.length, 2);
    assert.match(parsed.problems[0] ?? "", /ended early/);
    assert.equal(addedLines(parsed.files[1]!)[0]?.text, "2");
  });

  it("parses plain unified diffs without git headers", () => {
    const parsed = parseUnifiedDiff(
      "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-a\n+b\n",
    );
    assert.equal(parsed.files[0]?.newPath, "package.json");
    assert.equal(parsed.files[0]?.status, "modified");
  });

  it("stops at the file limit and says so", () => {
    const one = (i: number) =>
      `diff --git a/f${i} b/f${i}\n--- a/f${i}\n+++ b/f${i}\n@@ -1 +1 @@\n-a\n+b\n`;
    const parsed = parseUnifiedDiff(Array.from({ length: 10 }, (_, i) => one(i)).join(""), {
      maxFiles: 3,
    });
    assert.equal(parsed.files.length, 3);
    assert.equal(parsed.truncated, true);
  });

  it("stops at the line and size limits and says so", () => {
    const big = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1,1000 @@\n${"+x\n".repeat(1000)}`;
    assert.equal(parseUnifiedDiff(big, { maxLines: 10 }).truncated, true);
    assert.equal(parseUnifiedDiff(big, { maxChars: 100 }).truncated, true);
  });

  it("does not treat out-of-range hunk headers as numbers", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -99999999999999999999 +1 @@\n+x\n",
    );
    assert.equal(parsed.files[0]?.hunks.length, 0);
    assert.match(parsed.problems[0] ?? "", /unreadable hunk header/);
  });

  it("keeps quoted paths with invalid escapes as raw text", () => {
    const parsed = parseUnifiedDiff('diff --git "a/\\377" "b/\\377"\nnew file mode 100644\n');
    assert.equal(parsed.files[0]?.newPath, '"b/\\377"');
  });

  it("reports a header-only file whose paths can't be split", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/my file b/other file\nold mode 100644\nnew mode 100755\n",
    );
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0]?.newPath, undefined);
    assert.match(parsed.problems.join(" "), /no readable path/);
  });

  it("counts a blank line inside a hunk as context, like git with stripped whitespace", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n a\n\n+new\n c\n",
    );
    const lines = parsed.files[0]!.hunks[0]!.lines;
    assert.deepEqual(
      lines.map((l) => [l.type, l.oldLine, l.newLine]),
      [
        ["context", 1, 1],
        ["context", 2, 2],
        ["add", undefined, 3],
        ["context", 3, 4],
      ],
    );
    assert.deepEqual(parsed.problems, []);
  });
});
