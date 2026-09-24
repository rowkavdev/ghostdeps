/**
 * Read-only RepositoryHandle over a scanned local directory.
 *
 * The handle serves exactly the files the scan listed. Reads re-check the
 * filesystem at read time, because the directory can change after the scan
 * (TOCTOU): every path component must still be a real directory, the file
 * must still be a regular file under its ceiling, and the final open uses
 * O_NOFOLLOW so a file swapped for a symlink is refused, not followed.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { RepositoryHandle } from "../../types/index.js";
import { scanRepository, type ScanOptions, type ScanResult, type ScannedFile } from "./scanner.js";

export type RepositoryReadErrorCode = "not-listed" | "changed" | "too-large" | "binary";

export class RepositoryReadError extends Error {
  constructor(
    readonly code: RepositoryReadErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = "RepositoryReadError";
  }
}

/** Bytes inspected for NUL when deciding a file is binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Normalise a caller path to the scanner's POSIX relative form, or undefined if it escapes. */
function normalise(requested: string): string | undefined {
  if (requested.includes("\\") || requested.includes("\0")) return undefined;
  const normal = path.posix.normalize(requested);
  if (normal.startsWith("/") || normal === ".." || normal.startsWith("../")) return undefined;
  return normal.replace(/^\.\//, "");
}

export class FsRepositoryHandle implements RepositoryHandle {
  private readonly files: ReadonlyMap<string, ScannedFile>;
  private readonly sortedPaths: readonly string[];

  constructor(readonly scan: ScanResult) {
    this.files = new Map(scan.files.map((f) => [f.path, f]));
    this.sortedPaths = scan.files.map((f) => f.path);
  }

  /** Scan `rootDir` and return a handle over the result. */
  static async open(rootDir: string, options: ScanOptions = {}): Promise<FsRepositoryHandle> {
    return new FsRepositoryHandle(await scanRepository(rootDir, options));
  }

  async listFiles(): Promise<string[]> {
    return [...this.sortedPaths];
  }

  async exists(requested: string): Promise<boolean> {
    const rel = normalise(requested);
    return rel !== undefined && this.files.has(rel);
  }

  async readFile(requested: string): Promise<string> {
    const rel = normalise(requested);
    const listed = rel === undefined ? undefined : this.files.get(rel);
    if (rel === undefined || listed === undefined) {
      throw new RepositoryReadError("not-listed", requested);
    }
    const ceiling = listed.lockfile
      ? this.scan.limits.maxLockfileBytes
      : this.scan.limits.maxFileBytes;

    // Every parent component must still be a real directory, not a symlink.
    const parts = rel.split("/");
    let current = this.scan.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const st = await lstat(current).catch(() => undefined);
      if (st === undefined || !st.isDirectory()) throw new RepositoryReadError("changed", rel);
    }

    const full = path.join(this.scan.root, rel);
    // O_NOFOLLOW is undefined on Windows. There (and everywhere, as a second
    // check) the file is lstat'ed before open and the opened handle must be
    // the same inode on the same device, so a swap to a symlink is caught.
    const before = await lstat(full).catch(() => undefined);
    if (before === undefined || !before.isFile()) throw new RepositoryReadError("changed", rel);
    const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
      throw new RepositoryReadError("changed", rel);
    });
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) {
        throw new RepositoryReadError("changed", rel);
      }
      if (st.size > ceiling) throw new RepositoryReadError("too-large", rel);

      // Read at most ceiling + 1 bytes so a file that grew after stat is still bounded.
      const buffer = Buffer.alloc(Math.min(st.size, ceiling) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > ceiling) throw new RepositoryReadError("too-large", rel);
      const bytes = buffer.subarray(0, length);
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        throw new RepositoryReadError("binary", rel);
      }
      // Lenient decoding: invalid sequences become U+FFFD rather than failing analysis.
      return new TextDecoder("utf-8").decode(bytes);
    } finally {
      await handle.close();
    }
  }
}
