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
import { createHash } from "node:crypto";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { utf8Head } from "../../repository-head.js";
import { MAX_HEAD_READ_BYTES } from "../../limits.js";
import type { RepositoryHandle, RepositoryTreeListing } from "../../types/index.js";
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

/** Read up to `length` bytes from the start of an open file. */
async function readPrefix(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

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

  /** Include skipped symlinks and expose all omissions as explicit limitations. */
  async listEntries(): Promise<RepositoryTreeListing> {
    const entries: RepositoryTreeListing["entries"] = this.scan.files.map(({ path }) => ({
      path,
      kind: "file",
    }));
    const limitations: string[] = [];
    if (this.scan.truncated) limitations.push(`truncated:${this.scan.truncated}`);
    if (this.scan.scope?.excludedFiles) limitations.push("fixture-scope-excluded");
    for (const [reason, count] of Object.entries(this.scan.skippedCounts)) {
      if (
        !["symlink", "excluded-directory", "excluded-generated-file", "fixture-root"].includes(
          reason,
        ) &&
        count > 0
      )
        limitations.push(`skipped:${reason}:${count}`);
    }
    const links = this.scan.skipped.filter((item) => item.reason === "symlink");
    if (links.length !== (this.scan.skippedCounts.symlink ?? 0))
      limitations.push("symlinks-unrecorded");
    for (const item of links) {
      try {
        const full = path.join(this.scan.root, item.path);
        const before = await lstat(full);
        if (!before.isSymbolicLink()) throw new Error("changed symlink");
        const raw = await readlink(full, { encoding: "buffer" });
        const target = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        const after = await lstat(full);
        if (!after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev)
          throw new Error("changed symlink");
        entries.push({ path: item.path, kind: "symlink", target });
      } catch {
        limitations.push(`unreadable-symlink:${item.path}`);
      }
    }
    const policy = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          excludedDirectories: this.scan.excludedDirectories,
          excludedFileSuffixes: this.scan.excludedFileSuffixes,
          scopeDigest: this.scan.scope?.digest ?? null,
        }),
      )
      .digest("hex");
    return {
      policy,
      entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      complete: limitations.length === 0,
      limitations,
    };
  }

  async readFileBytes(requested: string): Promise<Uint8Array> {
    const { rel, listed, handle, size } = await this.openListed(requested);
    try {
      const ceiling = listed.lockfile
        ? this.scan.limits.maxLockfileBytes
        : this.scan.limits.maxFileBytes;
      if (size > ceiling) throw new RepositoryReadError("too-large", rel);
      const bytes = await readPrefix(handle, size + 1);
      if (bytes.length !== size) throw new RepositoryReadError("changed", rel);
      const after = await handle.stat();
      if (after.size !== size) throw new RepositoryReadError("changed", rel);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async listFiles(): Promise<string[]> {
    return [...this.sortedPaths];
  }

  async exists(requested: string): Promise<boolean> {
    const rel = normalise(requested);
    return rel !== undefined && this.files.has(rel);
  }

  async readFile(requested: string): Promise<string> {
    const { rel, listed, handle, size } = await this.openListed(requested);
    try {
      const ceiling = listed.lockfile
        ? this.scan.limits.maxLockfileBytes
        : this.scan.limits.maxFileBytes;
      if (size > ceiling) throw new RepositoryReadError("too-large", rel);

      // Read at most ceiling + 1 bytes so a file that grew after stat is still bounded.
      const bytes = await readPrefix(handle, Math.min(size, ceiling) + 1);
      if (bytes.length > ceiling) throw new RepositoryReadError("too-large", rel);
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        throw new RepositoryReadError("binary", rel);
      }
      // Lenient decoding: invalid sequences become U+FFFD rather than failing analysis.
      return new TextDecoder("utf-8").decode(bytes);
    } finally {
      await handle.close();
    }
  }

  /**
   * Bounded head read (#113): at most `maxBytes` source bytes from the start
   * of a listed file, decoded with any torn trailing UTF-8 character dropped.
   * The same path and symlink checks as readFile apply. The size ceiling
   * does not, because sniffing the start of a large lockfile is the point;
   * reading stays bounded by maxBytes, clamped to MAX_HEAD_READ_BYTES. The binary sniff reads the same
   * window readFile would inspect, so a binary file is undefined here too.
   * Unreadable (not listed, changed, binary) resolves undefined.
   */
  async readFileHead(requested: string, maxBytes: number): Promise<string | undefined> {
    const limit = Number.isFinite(maxBytes)
      ? Math.min(MAX_HEAD_READ_BYTES, Math.max(0, Math.floor(maxBytes)))
      : 0;
    let opened: Awaited<ReturnType<FsRepositoryHandle["openListed"]>>;
    try {
      opened = await this.openListed(requested);
    } catch {
      return undefined;
    }
    try {
      const bytes = await readPrefix(
        opened.handle,
        Math.min(opened.size, Math.max(limit, BINARY_SNIFF_BYTES)),
      );
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
      return utf8Head(bytes, limit);
    } catch {
      return undefined;
    } finally {
      await opened.handle.close();
    }
  }

  /** Resolve a listed file and open it safely; throws RepositoryReadError. */
  private async openListed(requested: string): Promise<{
    rel: string;
    listed: ScannedFile;
    handle: FileHandle;
    size: number;
  }> {
    const rel = normalise(requested);
    const listed = rel === undefined ? undefined : this.files.get(rel);
    if (rel === undefined || listed === undefined) {
      throw new RepositoryReadError("not-listed", requested);
    }

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
      return { rel, listed, handle, size: st.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
