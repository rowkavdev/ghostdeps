/**
 * Bounded head reads on a RepositoryHandle (#113). Lets adapters sniff a
 * large file (e.g. the first 512 bytes of yarn.lock for the berry
 * `__metadata:` block) without reading it whole.
 *
 * Contract (Architecture Lead sign-off on #113):
 * - `RepositoryHandle.readFileHead` is optional. Core feature-detects it
 *   (`typeof handle.readFileHead === "function"`) and never branches on
 *   adapterApiVersion, which stays 0.1.0.
 * - `maxBytes` caps the SOURCE BYTES read, not output characters. The result
 *   is the decoded prefix with any trailing partial UTF-8 sequence dropped:
 *   no replacement character, no torn multibyte character.
 * - Without readFileHead, core falls back to readFile and slices by encoded
 *   length the same way, so both paths return the same prefix.
 * - Consumers must not assume the prefix ends on a line boundary.
 * - `undefined` means exactly readFile's not-found. The helper normalises a
 *   throwing handle (either path) to undefined.
 */
import type { RepositoryHandle } from "./types/index.js";

/**
 * Length of `bytes` with any trailing incomplete UTF-8 sequence removed.
 * Only the last 1-3 bytes can belong to an unfinished character.
 */
export function completeUtf8Length(bytes: Uint8Array): number {
  const end = bytes.length;
  for (let back = 1; back <= Math.min(3, end); back++) {
    const b = bytes[end - back]!;
    if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? end - back : end;
  }
  return end;
}

/** Decode at most `maxBytes` bytes of UTF-8, dropping a torn trailing character. */
export function utf8Head(bytes: Uint8Array, maxBytes: number): string {
  const cut = bytes.subarray(0, Math.max(0, Math.floor(maxBytes)));
  return new TextDecoder("utf-8").decode(cut.subarray(0, completeUtf8Length(cut)));
}

/**
 * Read at most `maxBytes` source bytes from the start of `path`. Uses the
 * handle's readFileHead when it has one, else readFile plus a byte slice.
 * Returns undefined when the file cannot be read (readFile's not-found).
 */
export async function readRepositoryFileHead(
  handle: RepositoryHandle,
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    if (typeof handle.readFileHead === "function") {
      return await handle.readFileHead(path, maxBytes);
    }
    return utf8Head(Buffer.from(await handle.readFile(path), "utf8"), maxBytes);
  } catch {
    return undefined;
  }
}
