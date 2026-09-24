/**
 * Generator for the hostile archive fixtures in this directory.
 *
 * Run: `node fixtures/hostile/generate.mjs` (Node 22+, no dependencies).
 *
 * Every fixture is a codeload-shaped .tar.gz built to attack the inert
 * extraction helper (packages/core/src/checkout). The generator writes,
 * per fixture: archive.tar.gz, expected.json (the contract tests assert
 * against) and README.md (what it attacks and why). Fixtures are data:
 * nothing here is ever installed, built or executed by the project.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK = 512;
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- tar writer
function writeString(block, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  block.set(bytes.subarray(0, length), offset);
}
function writeOctal(block, offset, length, value) {
  writeString(block, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
  block[offset + length - 1] = 0;
}
function headerBlock(entry) {
  const block = new Uint8Array(BLOCK);
  if (entry.rawName) block.set(entry.rawName.subarray(0, 100), 0);
  else writeString(block, 0, 100, entry.name);
  writeOctal(block, 100, 8, entry.mode ?? 0o100644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  if (entry.base256Size !== undefined) {
    block[124] = 0x80;
    const size = entry.base256Size;
    for (let i = 0; i < 4; i++) block[132 + i] = (size >> ((3 - i) * 8)) & 0xff;
  } else {
    writeOctal(block, 124, 12, entry.size ?? 0);
  }
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = entry.typeflag ?? "0".charCodeAt(0);
  if (entry.linkName !== undefined) writeString(block, 157, 100, entry.linkName);
  writeString(block, 257, 8, entry.magic ?? "ustar\0" + "00");
  writeString(block, 265, 32, "ghostdeps-fixture");
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (entry.corruptChecksum) sum += 7;
  writeString(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}
function paxRecords(records) {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    const record = ` ${key}=${value}\n`;
    let len = record.length + 1;
    for (;;) {
      const next = record.length + String(len).length;
      if (next === len) break;
      len = next;
    }
    body += `${len}${record}`;
  }
  return Buffer.from(body, "utf8");
}
function dataBlocks(data) {
  const padded = new Uint8Array(Math.ceil(Math.max(data.length, 1) / BLOCK) * BLOCK);
  padded.set(data);
  return padded.length === 0 ? new Uint8Array(BLOCK) : padded;
}

/** entries: see fixtures below. Returns a gzipped tar. */
function buildArchive(entries) {
  const parts = [];
  for (let entry of entries) {
    if (entry.globalRecords) {
      const data = paxRecords(entry.globalRecords);
      parts.push(headerBlock({ name: "pax_global_header", typeflag: "g".charCodeAt(0), size: data.length }));
      parts.push(dataBlocks(data));
      if (entry.name === undefined && entry.body === undefined) continue;
    }
    if (entry.pax) {
      const data = paxRecords(entry.pax);
      parts.push(headerBlock({ name: "PaxHeaders.0/x", typeflag: "x".charCodeAt(0), size: data.length }));
      parts.push(dataBlocks(data));
    }
    if (entry.gnuLongName) {
      const data = Buffer.concat([Buffer.from(entry.gnuLongName, "utf8"), Buffer.from([0])]);
      parts.push(headerBlock({ name: "././@LongLink", typeflag: "L".charCodeAt(0), size: data.length }));
      parts.push(dataBlocks(data));
      entry = { ...entry, name: entry.gnuLongName.slice(0, 90) };
    }
    const body = entry.body ?? new Uint8Array(0);
    const size = entry.declaredSize ?? body.length;
    parts.push(headerBlock({ ...entry, size }));
    if (body.length > 0) parts.push(dataBlocks(body));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return gzipSync(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

// ---------------------------------------------------------------- fixtures
const text = (s) => Buffer.from(s, "utf8");
const FIXTURES = [
  {
    dir: "archive-clean-control",
    attacks: "Nothing. Control: a valid codeload-shaped archive (pax global header, long pax path, UTF-8 names, internal symlink) MUST extract cleanly. Guards against false positives in the validator.",
    entries: [
      { globalRecords: { comment: "0".repeat(40) } },
      { name: "repo-abc/package.json", body: text('{"name":"clean"}\n') },
      { name: "repo-abc/src/index.ts", body: text("export {}\n") },
      { name: "repo-abc/docs/café-日本語.md", body: text("unicode names\n") },
      { name: "repo-abc/src/link-to-index", typeflag: "2".charCodeAt(0), linkName: "index.ts" },
      { name: "repo-abc/" + "deep/".repeat(28) + "file.ts", pax: { path: "repo-abc/" + "deep/".repeat(28) + "file.ts", size: "5" }, body: text("long\n") },
    ],
    expect: { result: "extract", files: 4, symlinks: 1 },
  },
  {
    dir: "archive-traversal-dots",
    attacks: "Classic zip-slip: entries whose names contain '..' segments, escaping the extraction root on naive extractors.",
    entries: [
      { name: "repo/package.json", body: text("{}") },
      { name: "../evil.txt", body: text("pwned") },
    ],
    expect: { result: "reject", code: "PATH_TRAVERSAL" },
  },
  {
    dir: "archive-traversal-nested",
    attacks: "Traversal hidden inside a plausible tree path: 'repo/src/../../../etc/cron.d/ghost'. Naive join-and-write extractors write outside the root.",
    entries: [{ name: "repo/src/../../../etc/cron.d/ghost", body: text("* * * * * root pwn\n") }],
    expect: { result: "reject", code: "PATH_TRAVERSAL" },
  },
  {
    dir: "archive-traversal-backslash",
    attacks: "Backslash separators: '..\\evil.txt'. Legal filename on Linux, traversal on Windows consumers of the tree. Validators must treat both separators as path boundaries.",
    entries: [{ name: "..\\..\\evil.txt", body: text("pwned") }],
    expect: { result: "reject", code: "PATH_TRAVERSAL" },
  },
  {
    dir: "archive-absolute-posix",
    attacks: "Absolute POSIX path '/etc/passwd'. Extractors that honour it overwrite system files.",
    entries: [{ name: "/etc/passwd", body: text("root::0:0::/:/bin/sh\n") }],
    expect: { result: "reject", code: "ABSOLUTE_PATH" },
  },
  {
    dir: "archive-absolute-windows",
    attacks: "Windows absolute and drive-relative paths: 'C:\\Windows\\System32\\drivers\\etc\\hosts'. A validator that only checks '/' misses these.",
    entries: [{ name: "C:\\Windows\\System32\\drivers\\etc\\hosts", body: text("127.0.0.1 evil\n") }],
    expect: { result: "reject", code: "ABSOLUTE_PATH" },
  },
  {
    dir: "archive-absolute-unc",
    attacks: "UNC path '//server/share/payload'. Windows treats it as a network absolute path.",
    entries: [{ name: "//server/share/payload.dll", body: text("MZ") }],
    expect: { result: "reject", code: "ABSOLUTE_PATH" },
  },
  {
    dir: "archive-pax-path-override",
    attacks: "Innocent ustar name, hostile pax 'path' override ('../evil.txt'). Extractors that validate the ustar name but write the pax name get slipped.",
    entries: [{ name: "innocent.txt", pax: { path: "../evil.txt", size: "6" }, body: text("pwned\n") }],
    expect: { result: "reject", code: "PATH_TRAVERSAL" },
  },
  {
    dir: "archive-gnu-longname-escape",
    attacks: "GNU '@LongLink' name extension carrying a traversal path. Validators must validate the *effective* name, not the truncated ustar one.",
    entries: [{ gnuLongName: "../../evil-longlink.txt", body: text("pwned") }],
    expect: { result: "reject", code: "PATH_TRAVERSAL" },
  },
  {
    dir: "archive-symlink-absolute",
    attacks: "Symlink entry pointing at an absolute target ('/etc/passwd'). Extraction must record it as metadata and never materialise it, so nothing can ever be followed out of the checkout.",
    entries: [{ name: "repo/passwd", typeflag: "2".charCodeAt(0), linkName: "/etc/passwd" }],
    expect: { result: "extract", symlinks: 1, links: [{ path: "repo/passwd", target: "/etc/passwd" }] },
  },
  {
    dir: "archive-symlink-relative-escape",
    attacks: "Symlink whose relative target climbs out of the root ('../../../etc'). Recorded, never created - the escape only exists if links are materialised.",
    entries: [{ name: "repo/deep/link", typeflag: "2".charCodeAt(0), linkName: "../../../etc" }],
    expect: { result: "extract", symlinks: 1, links: [{ path: "repo/deep/link", target: "../../../etc" }] },
  },
  {
    dir: "archive-symlink-shallow-target-escape",
    attacks: "A link sitting deeper than its target (a/b/c/L points at the root) lets a later target 'L/../..' climb out of the root when '..' is applied lexically instead of physically. This escaped the first, materialising extractor (independent-review PoC on PR #81); with links recorded as metadata there is nothing to follow.",
    entries: [
      { name: "a/b/c/L", typeflag: "2".charCodeAt(0), linkName: "../../.." },
      { name: "a/b/c/M", typeflag: "2".charCodeAt(0), linkName: "L/../.." },
    ],
    expect: { result: "extract", symlinks: 2, links: [{ path: "a/b/c/L", target: "../../.." }, { path: "a/b/c/M", target: "L/../.." }] },
  },
  {
    dir: "archive-symlink-stale-prefix",
    attacks: "A link target's meaning changes as later links land: L points at x/y/z, then x becomes a link to '.', then M -> L/../../.. climbs out of the root when L is resolved against the new x. This escaped the second, creation-time-resolution extractor (independent-review re-review PoC on PR #81); recording links as metadata removes resolution entirely.",
    entries: [
      { name: "r/L", typeflag: "2".charCodeAt(0), linkName: "x/y/z" },
      { name: "r/x", typeflag: "2".charCodeAt(0), linkName: "." },
      { name: "r/M", typeflag: "2".charCodeAt(0), linkName: "L/../../.." },
    ],
    expect: { result: "extract", symlinks: 3, links: [{ path: "r/L", target: "x/y/z" }, { path: "r/x", target: "." }, { path: "r/M", target: "L/../../.." }] },
  },
  {
    dir: "archive-case-collision",
    attacks: "Two entries differing only by case ('A.txt' vs 'a.txt'). On case-insensitive filesystems the second overwrites the first; validators must be at least as strict as the most lenient consumer FS.",
    entries: [
      { name: "repo/A.txt", body: text("first") },
      { name: "repo/a.txt", body: text("second") },
    ],
    expect: { result: "reject", code: "DUPLICATE_PATH" },
  },
  {
    dir: "archive-nfc-collision",
    attacks: "Same filename in NFC and NFD Unicode normalisation. Normalising filesystems (APFS) see one file; byte-wise validators see two and miss the collision.",
    entries: [
      { name: "repo/caf\u00e9.txt", body: text("nfc") },
      { name: "repo/cafe\u0301.txt", body: text("nfd") },
    ],
    expect: { result: "reject", code: "DUPLICATE_PATH" },
  },
  {
    dir: "archive-symlink-loop",
    attacks: "Symlink loop (a -> b, b -> a) plus an entry under the loop. A materialising extractor needs loop-capped resolution; a recording extractor is immune by construction.",
    entries: [
      { name: "repo/a", typeflag: "2".charCodeAt(0), linkName: "b" },
      { name: "repo/b", typeflag: "2".charCodeAt(0), linkName: "a" },
      { name: "repo/a/pwn.txt", body: text("x") },
    ],
    expect: { result: "extract", files: 1, symlinks: 2, links: [{ path: "repo/a", target: "b" }, { path: "repo/b", target: "a" }] },
  },
  {
    dir: "archive-hardlink-missing-target",
    attacks: "Hardlink to a path never extracted as a regular file. On-disk link creation must not reach outside the checkout.",
    entries: [{ name: "repo/hard", typeflag: "1".charCodeAt(0), linkName: "not-extracted.txt" }],
    expect: { result: "reject", code: "LINK_TARGET_MISSING" },
  },
  {
    dir: "archive-duplicate-path",
    attacks: "Two entries for the same path. Classic parser-differential: validator checks entry one, extractor writes entry two.",
    entries: [
      { name: "repo/same.txt", body: text("first") },
      { name: "repo/same.txt", body: text("second") },
    ],
    expect: { result: "reject", code: "DUPLICATE_PATH" },
  },
  {
    dir: "archive-device-node",
    attacks: "Block/character device entries (typeflags 3/4). Extracting device nodes as root is a classic container-escape primitive.",
    entries: [{ name: "repo/sda", typeflag: "4".charCodeAt(0) }],
    expect: { result: "reject", code: "UNSUPPORTED_ENTRY" },
  },
  {
    dir: "archive-fifo",
    attacks: "FIFO entry (typeflag 6). Special files must never be materialised from an archive.",
    entries: [{ name: "repo/pipe", typeflag: "6".charCodeAt(0) }],
    expect: { result: "reject", code: "UNSUPPORTED_ENTRY" },
  },
  {
    dir: "archive-sparse-file",
    attacks: "GNU sparse file (typeflag S): gigabytes of apparent content in kilobytes of archive. A disk-fill bomb against naive extractors.",
    entries: [{ name: "repo/sparse.bin", typeflag: "S".charCodeAt(0) }],
    expect: { result: "reject", code: "UNSUPPORTED_ENTRY" },
  },
  {
    dir: "archive-huge-declared-file",
    attacks: "One file declaring a 5 GiB body in its header. Must be rejected from the header alone, before any body bytes are read.",
    entries: [{ name: "repo/huge.bin", declaredSize: 5 * 1024 * 1024 * 1024, body: text("") }],
    expect: { result: "reject", code: "FILE_TOO_LARGE" },
  },
  {
    dir: "archive-entry-flood",
    attacks: "Hundreds of tiny entries (kept small on disk; tests re-run with a low maxEntries ceiling). Entry-count ceilings stop metadata-flood disk exhaustion.",
    entries: Array.from({ length: 300 }, (_, i) => ({ name: `repo/flood/${i}.txt`, body: text("x") })),
    limits: { maxEntries: 100 },
    expect: { result: "reject", code: "TOO_MANY_ENTRIES" },
  },
  {
    dir: "archive-total-size-bomb",
    attacks: "Many files each under the per-file ceiling, together over the total-bytes ceiling (run with low limits). Aggregate ceilings stop zip-bomb style exhaustion.",
    entries: Array.from({ length: 8 }, (_, i) => ({ name: `repo/blob/${i}.bin`, body: new Uint8Array(4096) })),
    limits: { maxFileBytes: 8192, maxTotalBytes: 16384 },
    expect: { result: "reject", code: "TOTAL_SIZE_EXCEEDED" },
  },
  {
    dir: "archive-deep-nesting",
    attacks: "Path nested far past reasonable depth (run with a low maxDepth). Depth ceilings bound recursion in downstream consumers.",
    entries: [{ name: "repo/" + "d/".repeat(40) + "leaf.txt", body: text("x") }],
    limits: { maxDepth: 20 },
    expect: { result: "reject", code: "TOO_DEEP" },
  },
  {
    dir: "archive-malformed-checksum",
    attacks: "Header with a corrupted checksum. Strict framing checks stop bit-flipped archives from being interpreted.",
    entries: [{ name: "repo/a.txt", body: text("x"), corruptChecksum: true }],
    expect: { result: "reject", code: "MALFORMED_ARCHIVE" },
  },
  {
    dir: "archive-malformed-v7-magic",
    attacks: "Pre-ustar (v7) header with no magic. Strict parsers reject formats they do not implement instead of guessing.",
    entries: [{ name: "repo/a.txt", body: text("x"), magic: "\0\0\0\0\0\0\0\0" }],
    expect: { result: "reject", code: "MALFORMED_ARCHIVE" },
  },
  {
    dir: "archive-base256-size",
    attacks: "GNU base-256 binary size field. Parsers that misread the encoding compute wrong body offsets and desynchronise.",
    entries: [{ name: "repo/a.bin", base256Size: 5, body: text("hello") }],
    expect: { result: "reject", code: "MALFORMED_ARCHIVE" },
  },
  {
    dir: "archive-truncated",
    attacks: "Archive cut off mid-file (gzip stream severed at 50%). Extraction must fail loudly, never emit a partial checkout that looks valid.",
    truncateAt: 0.5,
    entries: [{ name: "repo/big.txt", body: new Uint8Array(4096).fill(65) }],
    expect: { result: "reject", code: "TRUNCATED_ARCHIVE" },
  },
  {
    dir: "archive-unicode-nfkc-fold",
    attacks: "Filename containing U+FF0F FULLWIDTH SOLIDUS, which NFKC-folds to '/'. Validators that normalise after checking (or consumers that fold) turn it into traversal.",
    entries: [{ name: "repo／..／..／evil.txt", body: text("pwned") }],
    expect: { result: "reject", code: "UNICODE_PATH_FOLDING" },
  },
  {
    dir: "archive-invalid-utf8-name",
    attacks: "Entry name with lone 0xFF bytes (invalid UTF-8). Lenient decoders smuggle names past validators via replacement characters.",
    entries: [{ rawName: Buffer.from([0x72, 0x65, 0x70, 0x6f, 0x2f, 0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]), body: text("x") }],
    expect: { result: "reject", code: "INVALID_ENCODING" },
  },
];

// ---------------------------------------------------------------- emit
for (const fixture of FIXTURES) {
  const dir = join(here, fixture.dir);
  mkdirSync(dir, { recursive: true });
  let archive = buildArchive(fixture.entries);
  if (fixture.truncateAt) {
    const at = fixture.truncateAt < 1 ? Math.floor(archive.length * fixture.truncateAt) : fixture.truncateAt;
    archive = archive.subarray(0, at);
  }
  writeFileSync(join(dir, "archive.tar.gz"), archive);
  const expected = {
    description: fixture.attacks,
    archive: "archive.tar.gz",
    ...(fixture.limits ? { limits: fixture.limits } : {}),
    expect: fixture.expect,
  };
  writeFileSync(join(dir, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  writeFileSync(
    join(dir, "README.md"),
    `# ${fixture.dir}\n\n**Attacks:** ${fixture.attacks}\n\n**Expected:** ${
      fixture.expect.result === "reject"
        ? "extraction is rejected with `" + fixture.expect.code + "` and nothing is left on disk"
        : `extraction succeeds (${fixture.expect.files} files${fixture.expect.symlinks ? `, ${fixture.expect.symlinks} symlink` : ""})`
    }.\n\nRegenerate with \`node fixtures/hostile/generate.mjs\`.\n`,
  );
}
console.log(`wrote ${FIXTURES.length} fixtures`);
