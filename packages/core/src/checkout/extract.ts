/**
 * Inert extraction of codeload tarballs (docs/security-model.md rule 2,
 * ADR 0004 rule 3). Every archive entry is validated before anything is
 * written:
 *
 *   - no path traversal (`..`, including via backslash separators)
 *   - no absolute paths (POSIX, Windows drive, UNC)
 *   - **symlinks are never materialised.** A link entry is validated as a
 *     path and recorded in the extraction summary (path + raw target) for
 *     the RepositoryHandle; nothing on disk can ever be followed, so no
 *     resolution-order trick, shallow-target climb, or link loop can
 *     escape the root. Hardlinks are created only against files already
 *     extracted inside the root.
 *   - no Unicode tricks: names must be valid UTF-8, and no path segment
 *     may NFKC-fold into a separator or dot-segment; duplicate detection
 *     is NFC + case-folded so the check is at least as strict as the most
 *     lenient filesystem
 *   - entry-count, per-file, total-size, path-length and depth ceilings
 *   - archive modes are ignored: files 0644, directories 0755, nothing
 *     is ever marked executable, nothing is ever run
 *
 * Extraction is all-or-nothing: the first rejected entry aborts the whole
 * extraction and the destination directory is removed. Callers must pass
 * a fresh, dedicated destination path.
 */
import { mkdir, open, readdir, rm, link } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ExtractionError } from "./errors.js";
import { TarReader, type TarEntryHeader } from "./tar.js";

export interface ExtractionLimits {
  /** Maximum entries (files + directories + links) extracted. */
  maxEntries: number;
  /** Maximum sum of extracted file bytes. */
  maxTotalBytes: number;
  /** Maximum size of one file. */
  maxFileBytes: number;
  /** Maximum normalised path length in bytes. */
  maxPathBytes: number;
  /** Maximum path depth in segments. */
  maxDepth: number;
  /** Maximum decompressed archive stream bytes. */
  maxArchiveBytes: number;
  /** Maximum size of one pax extended-header block. */
  maxPaxBytes: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxEntries: 200_000,
  maxTotalBytes: 1 << 30, // 1 GiB
  maxFileBytes: 256 << 20, // 256 MiB
  maxPathBytes: 1024,
  maxDepth: 100,
  maxArchiveBytes: 1 << 30, // 1 GiB decompressed
  maxPaxBytes: 256 * 1024,
};

/** A symlink found in the archive. Recorded, never created on disk. */
export interface RecordedLink {
  /** Normalised root-relative path of the link entry. */
  path: string;
  /** The raw link target, exactly as stored in the archive. */
  target: string;
}

export interface ExtractOptions {
  /** Fresh destination directory. Created if missing; must be empty. */
  destDir: string;
  limits?: Partial<ExtractionLimits>;
}

export interface ExtractionSummary {
  entries: number;
  files: number;
  directories: number;
  /** Links recorded as metadata (never materialised). */
  symlinks: number;
  hardlinks: number;
  totalBytes: number;
  /** Every symlink entry, for the RepositoryHandle to expose or ignore. */
  links: RecordedLink[];
}

/**
 * Normalise a root-relative path for map keys: NFC per segment, then
 * case-folded. The duplicate check must be at least as strict as the most
 * lenient filesystem a checkout can land on (APFS/HFS+ normalise,
 * NTFS/APFS fold case), so two entries that collide only under
 * normalisation are treated as duplicates. Disk writes still use the
 * original segments.
 */
function mapKey(segments: string[]): string {
  return segments
    .map((segment) => segment.normalize("NFC"))
    .join("/")
    .toLowerCase();
}

/** True for POSIX-absolute, Windows drive, drive-relative, or UNC names. */
function isAbsoluteName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(name)) return true; // C:\..., C:/..., C:relative
  return false;
}

/**
 * Split an archive name into normalised relative segments, enforcing the
 * traversal, absolute-path, Unicode, length and depth rules. Both `/` and
 * `\` are treated as separators so Windows consumers of the tree are safe
 * too. Throws ExtractionError on violation.
 */
function normalizePath(name: string, limits: ExtractionLimits): string[] {
  if (isAbsoluteName(name)) {
    throw new ExtractionError("ABSOLUTE_PATH", "absolute paths are rejected", name);
  }
  const rawSegments = name.split(/[\\/]+/);
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      throw new ExtractionError("PATH_TRAVERSAL", "'..' segments are rejected", name);
    }
    const folded = raw.normalize("NFKC");
    if (folded.includes("/") || folded.includes("\\") || folded === "." || folded === "..") {
      throw new ExtractionError(
        "UNICODE_PATH_FOLDING",
        "path segment folds into a separator or dot-segment under NFKC",
        name,
      );
    }
    segments.push(raw);
  }
  if (segments.length === 0) {
    throw new ExtractionError("PATH_TRAVERSAL", "entry name normalises to nothing", name);
  }
  if (segments.length > limits.maxDepth) {
    throw new ExtractionError(
      "TOO_DEEP",
      `path depth ${segments.length} exceeds ${limits.maxDepth}`,
      name,
    );
  }
  const joined = segments.join("/");
  if (Buffer.byteLength(joined) > limits.maxPathBytes) {
    throw new ExtractionError("PATH_TOO_LONG", `path exceeds ${limits.maxPathBytes} bytes`, name);
  }
  return segments;
}

/**
 * Extract a (possibly gzipped) codeload tarball into a fresh directory.
 * The first invalid entry aborts the extraction, removes the destination,
 * and throws ExtractionError with a stable code.
 */
export async function extractTarball(
  source: AsyncIterable<Uint8Array>,
  options: ExtractOptions,
): Promise<ExtractionSummary> {
  const limits: ExtractionLimits = { ...DEFAULT_EXTRACTION_LIMITS, ...options.limits };
  const destRoot = resolve(options.destDir);

  await mkdir(destRoot, { recursive: true });
  if ((await readdir(destRoot)).length > 0) {
    throw new ExtractionError("DESTINATION_NOT_EMPTY", "destination must be a fresh directory");
  }

  const summary: ExtractionSummary = {
    entries: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    hardlinks: 0,
    totalBytes: 0,
    links: [],
  };
  /** mapKey(path) -> kind of entry written there. */
  const written = new Map<string, "file" | "directory" | "symlink" | "hardlink">();

  try {
    const tar = new TarReader(source, {
      maxArchiveBytes: limits.maxArchiveBytes,
      maxPaxBytes: limits.maxPaxBytes,
    });

    for (;;) {
      const header = await tar.next();
      if (header === null) break;
      await extractEntry(tar, header, written, destRoot, limits, summary);
      summary.entries++;
      if (summary.entries > limits.maxEntries) {
        throw new ExtractionError(
          "TOO_MANY_ENTRIES",
          `more than ${limits.maxEntries} entries`,
          header.name,
        );
      }
    }
    return summary;
  } catch (error) {
    await rm(destRoot, { recursive: true, force: true });
    throw error;
  }
}

async function extractEntry(
  tar: TarReader,
  header: TarEntryHeader,
  written: Map<string, "file" | "directory" | "symlink" | "hardlink">,
  destRoot: string,
  limits: ExtractionLimits,
  summary: ExtractionSummary,
): Promise<void> {
  // Entry paths are literal: links are never materialised, so nothing is
  // ever resolved "through" a link and no link map exists to get wrong.
  const segments = normalizePath(header.name, limits);
  const relPath = segments.join("/");

  const prior = written.get(mapKey(segments));
  if (prior !== undefined && !(prior === "directory" && header.type === "directory")) {
    throw new ExtractionError(
      "DUPLICATE_PATH",
      `entry conflicts with an earlier ${prior} at ${relPath}`,
      header.name,
    );
  }

  const dest = safeJoin(destRoot, relPath, header.name);

  switch (header.type) {
    case "directory": {
      if (prior === undefined) {
        await mkdir(dest, { recursive: true, mode: 0o755 });
        written.set(mapKey(segments), "directory");
        summary.directories++;
      }
      return;
    }
    case "file": {
      if (header.size > limits.maxFileBytes) {
        throw new ExtractionError(
          "FILE_TOO_LARGE",
          `file is ${header.size} bytes, limit is ${limits.maxFileBytes}`,
          header.name,
        );
      }
      if (summary.totalBytes + header.size > limits.maxTotalBytes) {
        throw new ExtractionError(
          "TOTAL_SIZE_EXCEEDED",
          `extraction would exceed ${limits.maxTotalBytes} total bytes`,
          header.name,
        );
      }
      await mkdir(resolve(dest, ".."), { recursive: true, mode: 0o755 });
      const handle = await open(dest, "wx", 0o644);
      try {
        await tar.readBody(async (chunk) => {
          await handle.write(chunk);
        });
      } finally {
        await handle.close();
      }
      written.set(mapKey(segments), "file");
      summary.files++;
      summary.totalBytes += header.size;
      return;
    }
    case "symlink": {
      const target = header.linkName ?? "";
      // Recorded, never created. The target is data for the
      // RepositoryHandle; because no link exists on disk, its value
      // cannot affect the extraction tree. Empty targets stay malformed.
      if (target === "") {
        throw new ExtractionError("MALFORMED_ARCHIVE", "symlink with an empty target", header.name);
      }
      written.set(mapKey(segments), "symlink");
      summary.symlinks++;
      summary.links.push({ path: relPath, target });
      return;
    }
    case "hardlink": {
      // Hardlinks share an inode with an already-extracted file inside
      // the root; unlike symlinks there is no target string to resolve,
      // so the resolution-order bug class does not apply.
      const targetSegments = normalizePath(header.linkName ?? "", limits);
      const relTarget = targetSegments.join("/");
      if (written.get(mapKey(targetSegments)) !== "file") {
        throw new ExtractionError(
          "LINK_TARGET_MISSING",
          "hardlink target was not extracted as a regular file",
          header.name,
        );
      }
      await mkdir(resolve(dest, ".."), { recursive: true, mode: 0o755 });
      await link(safeJoin(destRoot, relTarget, header.name), dest);
      written.set(mapKey(segments), "hardlink");
      summary.hardlinks++;
      return;
    }
  }
}

/** Join inside the root and prove the result cannot escape it. */
function safeJoin(destRoot: string, relPath: string, entryName: string): string {
  const dest = resolve(destRoot, relPath);
  if (dest !== destRoot && !dest.startsWith(destRoot + sep)) {
    // Unreachable after normalizePath, kept as a hard assertion.
    throw new ExtractionError("PATH_TRAVERSAL", "resolved path escaped the root", entryName);
  }
  return dest;
}
