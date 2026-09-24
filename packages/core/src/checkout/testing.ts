/**
 * Minimal tar writer for tests and fixture generation. Not part of the
 * package's public API; imported directly by tests. Writes strict
 * ustar/pax archives - the same shape codeload produces.
 */
import { gzipSync } from "node:zlib";

const BLOCK = 512;

export interface TestEntry {
  name: string;
  type?: "file" | "directory" | "symlink" | "hardlink";
  /** File body. */
  data?: string | Uint8Array;
  /** Link target for symlink/hardlink. */
  linkName?: string;
  /** Force a pax extended header for path/size (e.g. long names). */
  usePax?: boolean;
  /** Emit the git-archive style global pax header first (comment record). */
  globalComment?: string;
  /** Emit a global pax header with arbitrary records (hostile crafting). */
  globalRecords?: Record<string, string>;
  /** Declared size override for the header (defaults to data length). */
  declaredSize?: number;
  /** Raw typeflag byte, to craft unsupported entries. */
  typeflagOverride?: number;
  /** Corrupt the stored checksum after building the header. */
  corruptChecksum?: boolean;
  /** Numeric fields encoded base-256 (GNU binary) instead of octal. */
  base256Size?: boolean;
  /** Tar magic to write instead of "ustar\0" (e.g. "ustar  "). */
  magic?: string;
  /** Mode bits written into the header (ignored by extraction). */
  mode?: number;
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(block, offset, length - 1, text);
  block[offset + length - 1] = 0;
}

function headerBlock(entry: TestEntry, name: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, entry.mode ?? 0o100644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  if (entry.base256Size) {
    // GNU base-256: high bit set, big-endian magnitude.
    block[124] = 0x80;
    block[135] = size & 0xff;
  } else {
    writeOctal(block, 124, 12, size);
  }
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156); // checksum field as spaces during computation
  const typeflag =
    entry.typeflagOverride ??
    (entry.type === "directory"
      ? "5".charCodeAt(0)
      : entry.type === "symlink"
        ? "2".charCodeAt(0)
        : entry.type === "hardlink"
          ? "1".charCodeAt(0)
          : "0".charCodeAt(0));
  block[156] = typeflag;
  if (entry.linkName !== undefined) writeString(block, 157, 100, entry.linkName);
  writeString(block, 257, 8, entry.magic ?? "ustar\0" + "00");
  writeString(block, 265, 32, "ghostdeps-test");
  writeString(block, 297, 32, "ghostdeps-test");
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (entry.corruptChecksum) sum += 1;
  const stored = sum.toString(8).padStart(6, "0") + "\0 ";
  writeString(block, 148, 8, stored);
  return block;
}

function paxBlock(records: Record<string, string>, size: number): Uint8Array[] {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    // Length includes the digits themselves; iterate to fixpoint.
    let len = key.length + value.length + 3;
    for (;;) {
      const next = String(len).length + key.length + value.length + 3;
      if (next === len) break;
      len = next;
    }
    body += `${len} ${key}=${value}\n`;
  }
  const data = Buffer.from(body, "utf8");
  const header = headerBlock(
    { name: "PaxHeaders.0/x", type: "file" },
    "PaxHeaders.0/x",
    data.length,
  );
  header[156] = "x".charCodeAt(0);
  // Recompute checksum after flipping the typeflag.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  padded.set(data);
  void size;
  return [header, padded];
}

/** Build a tar archive (optionally gzipped) from test entries. */
export function buildTar(entries: TestEntry[], options: { gzip?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const globalRecords =
      entry.globalRecords ??
      (entry.globalComment !== undefined ? { comment: entry.globalComment } : undefined);
    if (globalRecords !== undefined) {
      let body = "";
      for (const [key, value] of Object.entries(globalRecords)) {
        const record = ` ${key}=${value}\n`;
        let len = record.length + 1;
        for (;;) {
          const next = record.length + String(len).length;
          if (next === len) break;
          len = next;
        }
        body += `${len}${record}`;
      }
      const data = Buffer.from(body, "utf8");
      const header = headerBlock(
        { name: "pax_global_header", type: "file" },
        "pax_global_header",
        data.length,
      );
      header[156] = "g".charCodeAt(0);
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of header) sum += byte;
      writeString(header, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
      const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
      padded.set(data);
      parts.push(header, padded);
    }
    const body =
      entry.data === undefined
        ? new Uint8Array(0)
        : typeof entry.data === "string"
          ? Buffer.from(entry.data, "utf8")
          : entry.data;
    const size =
      entry.declaredSize ?? (entry.type === "file" || entry.type === undefined ? body.length : 0);
    if (entry.usePax) {
      parts.push(...paxBlock({ path: entry.name, size: String(size) }, size));
      const header = headerBlock(
        entry,
        "PaxHeader",
        entry.type === "file" || entry.type === undefined ? body.length : 0,
      );
      parts.push(header);
    } else {
      parts.push(headerBlock(entry, entry.name, size));
    }
    if ((entry.type === "file" || entry.type === undefined) && body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
      padded.set(body);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end markers
  const tar = Buffer.concat(parts.map((p) => Buffer.from(p)));
  return options.gzip ? gzipSync(tar) : tar;
}

/** Chunk a buffer to exercise streaming reads. */
export async function* chunk(data: Uint8Array, size = 1024): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.byteLength; offset += size) {
    yield data.subarray(offset, offset + size);
  }
}
