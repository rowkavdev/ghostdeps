/**
 * Typed errors for inert archive extraction. Every rejection carries a
 * stable machine-readable `code` so callers (and hostile-fixture tests)
 * assert on the reason, not the message text.
 */

export const EXTRACTION_ERROR_CODES = [
  /** Archive bytes are not a valid tar/gzip stream. */
  "MALFORMED_ARCHIVE",
  /** Archive ends in the middle of an entry or gzip stream. */
  "TRUNCATED_ARCHIVE",
  /** Entry type we deliberately never extract (devices, fifos, sparse...). */
  "UNSUPPORTED_ENTRY",
  /** Entry name or link target is not valid UTF-8. */
  "INVALID_ENCODING",
  /** Entry path or link target is absolute (POSIX, Windows drive, or UNC). */
  "ABSOLUTE_PATH",
  /** Entry path escapes the extraction root via `..`. */
  "PATH_TRAVERSAL",
  /** Normalised path exceeds maxPathBytes. */
  "PATH_TOO_LONG",
  /** Path nesting exceeds maxDepth. */
  "TOO_DEEP",
  /** A path segment NFKC-folds into a separator or dot-segment. */
  "UNICODE_PATH_FOLDING",
  /** A link target resolves outside the extraction root. */
  "LINK_ESCAPE",
  /** Resolving a path through extracted symlinks exceeded the link cap. */
  "LINK_LOOP",
  /** A hardlink points at something not already extracted as a regular file. */
  "LINK_TARGET_MISSING",
  /** Two entries resolve to the same destination path. */
  "DUPLICATE_PATH",
  /** Entry count exceeds maxEntries. */
  "TOO_MANY_ENTRIES",
  /** A single file exceeds maxFileBytes. */
  "FILE_TOO_LARGE",
  /** Sum of extracted file bytes exceeds maxTotalBytes. */
  "TOTAL_SIZE_EXCEEDED",
  /** A pax extended header block exceeds maxPaxBytes. */
  "PAX_TOO_LARGE",
  /** The decompressed tar stream exceeds maxArchiveBytes. */
  "ARCHIVE_TOO_LARGE",
  /** The destination directory exists and is not empty. */
  "DESTINATION_NOT_EMPTY",
] as const;

export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  /** The archive entry that caused the rejection, when applicable. */
  readonly entry?: string;

  constructor(code: ExtractionErrorCode, message: string, entry?: string) {
    super(entry === undefined ? `${code}: ${message}` : `${code}: ${message} (entry: ${entry})`);
    this.name = "ExtractionError";
    this.code = code;
    if (entry !== undefined) {
      this.entry = entry;
    }
  }
}
