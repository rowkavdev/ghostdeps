/**
 * Strict, minimal tar reader for GitHub codeload archives.
 *
 * This is a hardened entry point (docs/security-model.md rule 3), not a
 * general-purpose tar implementation. It accepts exactly what codeload
 * produces - ustar/pax archives, optionally gzipped - and rejects
 * everything else loudly. Unsupported constructs are errors, never
 * best-effort parses.
 *
 * Supported:
 *   - ustar ("ustar\0" / GNU "ustar  ") headers with prefix field
 *   - pax per-entry extended headers ('x'), honouring only path/linkpath/size
 *   - pax global headers ('g'), parsed for framing; semantic keys rejected
 *   - GNU long name extensions ('L' / 'K')
 *   - typeflags: regular file, directory, symlink, hardlink
 *   - gzip wrapping, detected by magic bytes
 *
 * Rejected: v7 headers, base-256 numeric fields, sparse files, device
 * nodes, fifos, and every other typeflag; bad checksums; trailing garbage;
 * oversized pax blocks; archives past the byte ceiling.
 */
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { ExtractionError } from "./errors.js";

const BLOCK = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink";

export interface TarEntryHeader {
  /** Entry name decoded as strict UTF-8. */
  readonly name: string;
  /** File size in bytes (0 for directories and links). */
  readonly size: number;
  readonly type: TarEntryType;
  /** Link target for symlink/hardlink entries. */
  readonly linkName?: string;
}

export interface TarReaderOptions {
  /** Ceiling on decompressed tar stream bytes. Default 1 GiB. */
  maxArchiveBytes?: number;
  /** Ceiling on a single pax extended-header block. Default 256 KiB. */
  maxPaxBytes?: number;
}

/** Pull-based byte source over an async chunk iterable, with a total cap. */
class BlockReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private readonly iter: AsyncIterator<Uint8Array>;
  private eof = false;
  private seen = 0;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly maxBytes: number,
  ) {
    this.iter = source[Symbol.asyncIterator]();
  }

  private async fill(need: number): Promise<void> {
    while (this.buffered < need && !this.eof) {
      const next = await this.iter.next();
      if (next.done) {
        this.eof = true;
        break;
      }
      const chunk = next.value;
      if (chunk.byteLength === 0) continue;
      this.seen += chunk.byteLength;
      if (this.seen > this.maxBytes) {
        throw new ExtractionError(
          "ARCHIVE_TOO_LARGE",
          `decompressed archive exceeds ${this.maxBytes} bytes`,
        );
      }
      this.chunks.push(chunk);
      this.buffered += chunk.byteLength;
    }
  }

  /**
   * Read exactly `n` bytes. Returns null on a clean EOF at a record
   * boundary; a partial record is TRUNCATED_ARCHIVE.
   */
  async readExact(n: number): Promise<Uint8Array | null> {
    await this.fill(n);
    if (this.buffered === 0) return null;
    if (this.buffered < n) {
      throw new ExtractionError("TRUNCATED_ARCHIVE", `archive ends mid-record (${n} bytes needed)`);
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      if (head === undefined) break;
      const take = Math.min(head.byteLength, n - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
      this.buffered -= take;
    }
    return out;
  }

  /** Skip exactly `n` bytes (entry-body padding). */
  async skip(n: number): Promise<void> {
    const skipped = await this.readExact(n);
    if (skipped === null && n > 0) {
      throw new ExtractionError("TRUNCATED_ARCHIVE", "archive ends inside padding");
    }
  }

  /** After the end markers, only zero bytes may remain. */
  async drainExpectZeros(): Promise<void> {
    for (const chunk of this.chunks) {
      for (const byte of chunk) {
        if (byte !== 0) {
          throw new ExtractionError("MALFORMED_ARCHIVE", "non-zero data after end of archive");
        }
      }
    }
    this.chunks = [];
    this.buffered = 0;
    for (;;) {
      const next = await this.iter.next();
      if (next.done) return;
      for (const byte of next.value) {
        if (byte !== 0) {
          throw new ExtractionError("MALFORMED_ARCHIVE", "non-zero data after end of archive");
        }
      }
    }
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ExtractionError("INVALID_ENCODING", `${what} is not valid UTF-8`);
  }
}

/** Parse a tar octal numeric field. Base-256 binary fields are rejected. */
function parseOctal(field: Uint8Array, what: string): number {
  if (field.byteLength === 0) return 0;
  const first = field[0];
  if (first === undefined) return 0;
  if ((first & 0x80) !== 0) {
    throw new ExtractionError(
      "MALFORMED_ARCHIVE",
      `base-256 numeric field in ${what} is not supported`,
    );
  }
  let value = 0;
  let digits = 0;
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) {
      if (digits > 0) break; // trailing NUL/space padding after the number
      continue; // leading spaces
    }
    if (byte < 0x30 || byte > 0x37) {
      throw new ExtractionError("MALFORMED_ARCHIVE", `invalid octal digit in ${what}`);
    }
    value = value * 8 + (byte - 0x30);
    digits++;
    if (value > Number.MAX_SAFE_INTEGER / 8) {
      throw new ExtractionError("MALFORMED_ARCHIVE", `numeric overflow in ${what}`);
    }
  }
  return value;
}

function verifyChecksum(block: Uint8Array): void {
  const stored = parseOctal(block.subarray(148, 156), "header checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // The checksum field itself counts as eight spaces.
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  }
  if (sum !== stored) {
    throw new ExtractionError("MALFORMED_ARCHIVE", "header checksum mismatch");
  }
}

interface PaxOverrides {
  path?: Uint8Array;
  linkpath?: Uint8Array;
  size?: number;
}

/** Parse pax records: repeated "<len> <key>=<value>\n". */
function parsePax(data: Uint8Array, what: string): Map<string, Uint8Array> {
  const records = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < data.byteLength) {
    let len = 0;
    let cursor = offset;
    for (;;) {
      const byte = data[cursor];
      if (byte === undefined || cursor - offset > 20) {
        throw new ExtractionError("MALFORMED_ARCHIVE", `bad pax record length in ${what}`);
      }
      if (byte === 0x20) break; // space terminates the length
      if (byte < 0x30 || byte > 0x39) {
        throw new ExtractionError("MALFORMED_ARCHIVE", `bad pax record length in ${what}`);
      }
      len = len * 10 + (byte - 0x30);
      cursor++;
    }
    if (len <= cursor - offset + 1 || offset + len > data.byteLength) {
      throw new ExtractionError("MALFORMED_ARCHIVE", `pax record overruns its block in ${what}`);
    }
    const record = data.subarray(cursor + 1, offset + len);
    if (record[record.byteLength - 1] !== 0x0a) {
      throw new ExtractionError("MALFORMED_ARCHIVE", `pax record missing newline in ${what}`);
    }
    const body = record.subarray(0, record.byteLength - 1);
    const eq = body.indexOf(0x3d); // '='
    if (eq <= 0) {
      throw new ExtractionError("MALFORMED_ARCHIVE", `pax record missing '=' in ${what}`);
    }
    const key = decodeUtf8(body.subarray(0, eq), "pax key");
    records.set(key, body.subarray(eq + 1));
    offset += len;
  }
  return records;
}

/** Wrap a chunk source so gzip members are transparently decompressed. */
async function* maybeGunzip(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const iter = source[Symbol.asyncIterator]();
  const prefix: Uint8Array[] = [];
  let prefixLen = 0;
  while (prefixLen < 2) {
    const next = await iter.next();
    if (next.done) break;
    prefix.push(next.value);
    prefixLen += next.value.byteLength;
  }
  const head0 = prefix[0]?.[0];
  const head1 = prefix[0]?.byteLength && prefix[0].byteLength > 1 ? prefix[0][1] : prefix[1]?.[0];
  const isGzip = head0 === 0x1f && head1 === 0x8b;
  if (!isGzip) {
    for (const chunk of prefix) yield chunk;
    for (;;) {
      const next = await iter.next();
      if (next.done) return;
      yield next.value;
    }
    return;
  }
  async function* rest(): AsyncIterable<Uint8Array> {
    for (const chunk of prefix) yield chunk;
    for (;;) {
      const next = await iter.next();
      if (next.done) return;
      yield next.value;
    }
  }
  const gunzip = createGunzip();
  const stream = Readable.from(rest()).pipe(gunzip);
  try {
    for await (const chunk of stream) {
      yield chunk as Uint8Array;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unexpected end")) {
      throw new ExtractionError("TRUNCATED_ARCHIVE", `gzip stream cut short: ${message}`);
    }
    throw new ExtractionError("MALFORMED_ARCHIVE", `invalid gzip stream: ${message}`);
  }
}

/**
 * A pull-based tar reader. `next()` returns the next entry header; the
 * caller then streams exactly `header.size` bytes of body with
 * `readBody()` before calling `next()` again.
 */
export class TarReader {
  private readonly reader: BlockReader;
  private readonly maxPaxBytes: number;
  private pendingBody = 0;

  constructor(source: AsyncIterable<Uint8Array>, options: TarReaderOptions = {}) {
    this.reader = new BlockReader(maybeGunzip(source), options.maxArchiveBytes ?? 1 << 30);
    this.maxPaxBytes = options.maxPaxBytes ?? 256 * 1024;
  }

  /** Stream the current entry's body to `sink`. Returns bytes written. */
  async readBody(sink: (chunk: Uint8Array) => Promise<void>): Promise<number> {
    let remaining = this.pendingBody;
    let written = 0;
    while (remaining > 0) {
      const take = Math.min(remaining, 64 * 1024);
      const chunk = await this.reader.readExact(take);
      if (chunk === null) {
        throw new ExtractionError("TRUNCATED_ARCHIVE", "archive ends inside a file body");
      }
      await sink(chunk);
      written += chunk.byteLength;
      remaining -= chunk.byteLength;
    }
    const padding = (BLOCK - (this.pendingBody % BLOCK)) % BLOCK;
    await this.reader.skip(padding);
    this.pendingBody = 0;
    return written;
  }

  private async readDataBlock(size: number, what: string): Promise<Uint8Array> {
    if (size > this.maxPaxBytes) {
      throw new ExtractionError("PAX_TOO_LARGE", `${what} block exceeds ${this.maxPaxBytes} bytes`);
    }
    const parts: Uint8Array[] = [];
    await this.readBodyInto(size, parts);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  private async readBodyInto(size: number, parts: Uint8Array[]): Promise<void> {
    this.pendingBody = size;
    await this.readBody(async (chunk) => {
      parts.push(chunk);
    });
  }

  /** Read the next entry, or null at a clean end of archive. */
  async next(): Promise<TarEntryHeader | null> {
    if (this.pendingBody !== 0) {
      throw new ExtractionError("MALFORMED_ARCHIVE", "entry body not consumed before next()");
    }
    const overrides: PaxOverrides = {};
    let gnuLongName: Uint8Array | undefined;
    let gnuLongLink: Uint8Array | undefined;

    for (;;) {
      const block = await this.reader.readExact(BLOCK);
      if (block === null) {
        // EOF without end markers. Acceptable only before the very first
        // header of an empty stream; codeload always emits markers, so
        // treat this as truncation everywhere.
        throw new ExtractionError("TRUNCATED_ARCHIVE", "archive ends without zero-block markers");
      }
      if (isZeroBlock(block)) {
        const second = await this.reader.readExact(BLOCK);
        if (second !== null && !isZeroBlock(second)) {
          throw new ExtractionError("MALFORMED_ARCHIVE", "garbage after first zero block");
        }
        if (second === null) {
          throw new ExtractionError("TRUNCATED_ARCHIVE", "archive ends after one zero block");
        }
        await this.reader.drainExpectZeros();
        return null;
      }

      verifyChecksum(block);
      const typeflag = String.fromCharCode(block[156] ?? 0);
      const rawSize = parseOctal(block.subarray(124, 136), "entry size");

      if (typeflag === "g") {
        const data = await this.readDataBlock(rawSize, "global pax header");
        const records = parsePax(data, "global header");
        for (const key of records.keys()) {
          if (key === "path" || key === "linkpath" || key === "size") {
            throw new ExtractionError(
              "MALFORMED_ARCHIVE",
              `global pax header may not override ${key}`,
            );
          }
        }
        continue;
      }
      if (typeflag === "x") {
        const data = await this.readDataBlock(rawSize, "pax header");
        const records = parsePax(data, "pax header");
        for (const [key, value] of records) {
          if (key === "path") overrides.path = value;
          else if (key === "linkpath") overrides.linkpath = value;
          else if (key === "size") {
            const text = decodeUtf8(value, "pax size");
            if (!/^\d{1,15}$/.test(text)) {
              throw new ExtractionError("MALFORMED_ARCHIVE", "bad pax size override");
            }
            overrides.size = Number(text);
          }
          // All other pax keys (mtime, uid, SCHILY.*, ...) carry semantics
          // we never honour, so they are parsed for framing and ignored.
        }
        continue;
      }
      if (typeflag === "L" || typeflag === "K") {
        const data = await this.readDataBlock(rawSize, "GNU long name");
        const value =
          data[data.byteLength - 1] === 0 ? data.subarray(0, data.byteLength - 1) : data;
        if (typeflag === "L") gnuLongName = value;
        else gnuLongLink = value;
        continue;
      }

      // A real entry. Reject v7 (non-ustar) headers outright.
      const magic = block.subarray(257, 263);
      const magicText = String.fromCharCode(...magic);
      if (magicText !== "ustar\0" && magicText !== "ustar  ") {
        throw new ExtractionError("MALFORMED_ARCHIVE", `unsupported tar magic: ${magicText}`);
      }

      let nameBytes = block.subarray(0, 100);
      const nul = nameBytes.indexOf(0);
      if (nul >= 0) nameBytes = nameBytes.subarray(0, nul);
      const prefix = block.subarray(345, 500);
      const prefixNul = prefix.indexOf(0);
      const prefixText = prefixNul > 0 ? decodeUtf8(prefix.subarray(0, prefixNul), "prefix") : "";

      const size = overrides.size ?? rawSize;

      let type: TarEntryType;
      switch (typeflag) {
        case "0":
        case "\0":
          type = "file";
          break;
        case "5":
          type = "directory";
          break;
        case "1":
          type = "hardlink";
          break;
        case "2":
          type = "symlink";
          break;
        default:
          throw new ExtractionError(
            "UNSUPPORTED_ENTRY",
            `typeflag ${JSON.stringify(typeflag)} is never extracted`,
          );
      }

      if (type !== "file" && size !== 0) {
        throw new ExtractionError("MALFORMED_ARCHIVE", `${type} entry has a non-zero size`);
      }

      let linkNameBytes: Uint8Array | undefined;
      if (type === "symlink" || type === "hardlink") {
        let raw = block.subarray(157, 257);
        const linkNul = raw.indexOf(0);
        if (linkNul >= 0) raw = raw.subarray(0, linkNul);
        linkNameBytes = raw;
      }
      if (gnuLongLink !== undefined) linkNameBytes = gnuLongLink;
      if (overrides.linkpath !== undefined) linkNameBytes = overrides.linkpath;

      const finalNameBytes = gnuLongName ?? overrides.path ?? nameBytes;
      if (finalNameBytes.byteLength === 0) {
        throw new ExtractionError("MALFORMED_ARCHIVE", "entry with empty name");
      }
      let name = decodeUtf8(finalNameBytes, "entry name");
      if (prefixText !== "" && gnuLongName === undefined && overrides.path === undefined) {
        name = `${prefixText}/${name}`;
      }
      if (name.includes("\0")) {
        throw new ExtractionError("MALFORMED_ARCHIVE", "NUL byte in entry name", name);
      }

      const header: TarEntryHeader = { name, size, type };
      if (linkNameBytes !== undefined) {
        const linkName = decodeUtf8(linkNameBytes, "link target");
        if (linkName.includes("\0")) {
          throw new ExtractionError("MALFORMED_ARCHIVE", "NUL byte in link target", name);
        }
        Object.assign(header, { linkName });
      }
      // Directories and links carry no body; files must be drained via readBody.
      this.pendingBody = type === "file" ? size : 0;
      return header;
    }
  }
}
