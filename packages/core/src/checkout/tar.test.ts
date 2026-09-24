import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExtractionError } from "./errors.js";
import { TarReader, type TarEntryHeader } from "./tar.js";
import { buildTar, chunk } from "./testing.js";

async function readAll(data: Uint8Array): Promise<TarEntryHeader[]> {
  const reader = new TarReader(chunk(data, 997));
  const entries: TarEntryHeader[] = [];
  for (;;) {
    const entry = await reader.next();
    if (entry === null) return entries;
    if (entry.type === "file") {
      await reader.readBody(async () => {});
    }
    entries.push(entry);
  }
}

async function readBodyText(reader: TarReader): Promise<string> {
  const parts: Uint8Array[] = [];
  await reader.readBody(async (c) => {
    parts.push(c);
  });
  return Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8");
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExtractionError, `expected ExtractionError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe("TarReader", () => {
  it("reads a simple archive with files, directories and links", async () => {
    const tar = buildTar([
      { name: "pkg/", type: "directory" },
      { name: "pkg/index.js", data: "console.log('hi')\n" },
      { name: "pkg/README.md", data: "# hi" },
      { name: "pkg/link", type: "symlink", linkName: "index.js" },
    ]);
    const entries = await readAll(tar);
    assert.deepEqual(
      entries.map((e) => [e.name, e.type]),
      [
        ["pkg/", "directory"],
        ["pkg/index.js", "file"],
        ["pkg/README.md", "file"],
        ["pkg/link", "symlink"],
      ],
    );
    assert.equal(entries[3]?.linkName, "index.js");
  });

  it("returns exact file bodies", async () => {
    const tar = buildTar([{ name: "a.txt", data: "hello ghostdeps" }]);
    const reader = new TarReader(chunk(tar, 64));
    const entry = await reader.next();
    assert.ok(entry !== null);
    assert.equal(entry.size, 15);
    assert.equal(await readBodyText(reader), "hello ghostdeps");
    assert.equal(await reader.next(), null);
  });

  it("handles gzip-wrapped archives", async () => {
    const tar = buildTar([{ name: "a.txt", data: "zipped" }], { gzip: true });
    const entries = await readAll(tar);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.name, "a.txt");
  });

  it("handles git-archive style global pax headers and long pax paths", async () => {
    const longName = "repo-abc123/" + "deep/".repeat(30) + "file.ts";
    const tar = buildTar([
      { name: "x", globalComment: "df66844000000000000000000000000000000000" },
      { name: longName, data: "long", usePax: true },
    ]);
    const entries = await readAll(tar);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.name, "x");
    assert.equal(entries[1]?.name, longName);
    assert.equal(entries[1]?.size, 4);
  });

  it("handles non-ASCII UTF-8 names", async () => {
    const tar = buildTar([{ name: "docs/café-日本語.md", data: "unicode" }]);
    const entries = await readAll(tar);
    assert.equal(entries[0]?.name, "docs/café-日本語.md");
  });

  it("rejects a corrupt header checksum", async () => {
    const tar = buildTar([{ name: "a.txt", data: "x", corruptChecksum: true }]);
    await expectCode(readAll(tar), "MALFORMED_ARCHIVE");
  });

  it("rejects truncated archives", async () => {
    const full = buildTar([{ name: "a.txt", data: "some body content" }]);
    await expectCode(readAll(full.subarray(0, 700)), "TRUNCATED_ARCHIVE");
  });

  it("rejects archives missing end markers", async () => {
    const full = buildTar([{ name: "a.txt", data: "x" }]);
    await expectCode(readAll(full.subarray(0, full.byteLength - 1024)), "TRUNCATED_ARCHIVE");
  });

  it("rejects trailing garbage after end markers", async () => {
    const full = buildTar([{ name: "a.txt", data: "x" }]);
    const withGarbage = new Uint8Array(full.byteLength + 512);
    withGarbage.set(full);
    withGarbage[full.byteLength] = 1;
    await expectCode(readAll(withGarbage), "MALFORMED_ARCHIVE");
  });

  it("rejects unsupported typeflags (device nodes, fifos, sparse)", async () => {
    for (const flag of ["3", "4", "6", "S"]) {
      const tar = buildTar([{ name: "evil", typeflagOverride: flag.charCodeAt(0), data: "" }]);
      await expectCode(readAll(tar), "UNSUPPORTED_ENTRY");
    }
  });

  it("rejects base-256 numeric fields", async () => {
    const tar = buildTar([{ name: "a.txt", data: "x", base256Size: true }]);
    await expectCode(readAll(tar), "MALFORMED_ARCHIVE");
  });

  it("rejects non-ustar magic", async () => {
    const tar = buildTar([{ name: "a.txt", data: "x", magic: "notatar" }]);
    await expectCode(readAll(tar), "MALFORMED_ARCHIVE");
  });

  it("rejects a global pax header that overrides path semantics", async () => {
    for (const key of ["path", "linkpath", "size"]) {
      const tar = buildTar([
        { name: "g", globalRecords: { comment: "abc123", [key]: "../evil" } },
        { name: "a.txt", data: "x" },
      ]);
      await expectCode(readAll(tar), "MALFORMED_ARCHIVE");
    }
  });

  it("enforces the archive byte ceiling", async () => {
    const tar = buildTar([{ name: "big.bin", data: new Uint8Array(8192) }]);
    const reader = new TarReader(chunk(tar), { maxArchiveBytes: 1024 });
    await expectCode(
      (async () => {
        for (;;) {
          const e = await reader.next();
          if (e === null) return;
          if (e.type === "file") await reader.readBody(async () => {});
        }
      })(),
      "ARCHIVE_TOO_LARGE",
    );
  });

  it("requires bodies to be consumed before the next header", async () => {
    const tar = buildTar([
      { name: "a.txt", data: "abc" },
      { name: "b.txt", data: "def" },
    ]);
    const reader = new TarReader(chunk(tar));
    const first = await reader.next();
    assert.ok(first !== null);
    await expectCode(reader.next(), "MALFORMED_ARCHIVE");
  });
});
