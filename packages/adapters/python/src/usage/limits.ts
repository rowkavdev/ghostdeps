import { MAX_FILE_READ_BYTES } from "@ghostdeps/core";

/**
 * Parse-input cap for one Python source file: deliberately stricter than
 * core's read cap because a full statement scan costs far more per byte than
 * reading. Head scans (scan.ts) and reconstructed removed-file bases
 * (removed.ts, #868) share it.
 */
export const MAX_PYTHON_SOURCE_BYTES = Math.min(1_000_000, MAX_FILE_READ_BYTES);
