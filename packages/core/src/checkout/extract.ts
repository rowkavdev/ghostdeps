/**
 * Inert extraction of codeload tarballs (docs/security-model.md rule 2,
 * ADR 0004 rule 3). Every archive entry is validated before anything is
 * written:
 *
 *   - no path traversal (`..`, including via backslash separators)
 *   - no absolute paths (POSIX, Windows drive, UNC)
 *   - no link targets escaping the extraction root - and no writes
 *     *through* an extracted symlink that would escape it
 *   - no Unicode tricks: names must be valid UTF-8, and no path segment
 *     may NFKC-fold into a separator or dot-segment
 *   - entry-count, per-file, total-size, path-length and depth ceilings
 *   - archive modes are ignored: files 0644, directories 0755, nothing
 *     is ever marked executable, nothing is ever run
 *
 * Extraction is all-or-nothing: the first rejected entry aborts the whole
 * extraction and the destination directory is removed. Callers must pass
 * a fresh, dedicated destination path.
 */
import { mkdir, open, readdir, rm, symlink, link } from "node:fs/promises";
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

export interface ExtractOptions {
  /** Fresh destination directory. Created if missing; must be empty. */
  destDir: string;
  limits?: Partial<ExtractionLimits>;
}

export interface ExtractionSummary {
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  hardlinks: number;
  totalBytes: number;
}

/** Max symlink substitutions when resolving one path (loop guard). */
const MAX_LINK_RESOLUTIONS = 40;

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
 * too. Returns null-free segments; throws ExtractionError on violation.
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
 * Lexically resolve `targetSegments` (a link target) against `baseSegments`
 * (the directory containing the link), inside the root. Returns the
 * resolved root-relative segments, or null if the target escapes the root.
 */
function resolveLexically(baseSegments: string[], targetSegments: string[]): string[] | null {
  const out = [...baseSegments];
  for (const segment of targetSegments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null; // escapes the root
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** Per-extraction state: the symlink map and written-entry bookkeeping. */
class ExtractionState {
  /** Normalised link path -> resolved root-relative target path ("a/b/c"). */
  readonly links = new Map<string, string>();
  /** Normalised path -> kind of entry written there. */
  readonly written = new Map<string, "file" | "directory" | "symlink" | "hardlink">();

  /**
   * Resolve a root-relative path through previously extracted symlinks.
   * Any parent directory that is an extracted symlink is substituted with
   * its (already validated, root-confined) target. Throws LINK_LOOP if
   * substitutions exceed the cap.
   */
  resolveThroughLinks(segments: string[], entryName: string): string[] {
    let current = segments;
    for (let i = 0; i < MAX_LINK_RESOLUTIONS; i++) {
      const resolved: string[] = [];
      let substituted = false;
      for (const segment of current) {
        resolved.push(segment);
        const target = this.links.get(resolved.join("/"));
        if (target !== undefined) {
          // Replace the symlink prefix with its target and restart.
          const rest = current.slice(resolved.length);
          current = [...target.split("/"), ...rest];
          substituted = true;
          break;
        }
      }
      if (!substituted) return resolved;
    }
    throw new ExtractionError(
      "LINK_LOOP",
      `path resolution exceeded ${MAX_LINK_RESOLUTIONS} link substitutions`,
      entryName,
    );
  }
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
  };
  const state = new ExtractionState();

  try {
    const tar = new TarReader(source, {
      maxArchiveBytes: limits.maxArchiveBytes,
      maxPaxBytes: limits.maxPaxBytes,
    });

    for (;;) {
      const header = await tar.next();
      if (header === null) break;
      await extractEntry(tar, header, state, destRoot, limits, summary);
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
  state: ExtractionState,
  destRoot: string,
  limits: ExtractionLimits,
  summary: ExtractionSummary,
): Promise<void> {
  const segments = normalizePath(header.name, limits);
  const resolved = state.resolveThroughLinks(segments, header.name);
  const relPath = resolved.join("/");

  const prior = state.written.get(relPath);
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
        state.written.set(relPath, "directory");
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
      state.written.set(relPath, "file");
      summary.files++;
      summary.totalBytes += header.size;
      return;
    }
    case "symlink": {
      const target = header.linkName ?? "";
      if (isAbsoluteName(target) || target === "") {
        throw new ExtractionError(
          "ABSOLUTE_PATH",
          "symlink target is absolute or empty",
          header.name,
        );
      }
      const targetSegments = target.split(/[\\/]+/);
      // Resolve the target from the link's directory, through links.
      const parentResolved = state.resolveThroughLinks(resolved.slice(0, -1), header.name);
      const lexical = resolveLexically(parentResolved, targetSegments);
      if (lexical === null) {
        throw new ExtractionError(
          "LINK_ESCAPE",
          "symlink target escapes the extraction root",
          header.name,
        );
      }
      const finalTarget = state.resolveThroughLinks(lexical, header.name);
      await mkdir(resolve(dest, ".."), { recursive: true, mode: 0o755 });
      // Store the original relative target so the tree stays relocatable.
      await symlink(target.split(/[\\/]/).join("/"), dest);
      state.links.set(relPath, finalTarget.join("/"));
      state.written.set(relPath, "symlink");
      summary.symlinks++;
      return;
    }
    case "hardlink": {
      const target = header.linkName ?? "";
      const targetSegments = normalizePath(target, limits);
      const resolvedTarget = state.resolveThroughLinks(targetSegments, header.name).join("/");
      if (state.written.get(resolvedTarget) !== "file") {
        throw new ExtractionError(
          "LINK_TARGET_MISSING",
          "hardlink target was not extracted as a regular file",
          header.name,
        );
      }
      await mkdir(resolve(dest, ".."), { recursive: true, mode: 0o755 });
      await link(safeJoin(destRoot, resolvedTarget, header.name), dest);
      state.written.set(relPath, "hardlink");
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
