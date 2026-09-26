/** Canonical bounded repository snapshot digest. Never runs repository code. */
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { RepositoryHandle } from "../types/index.js";

const MAX_FILES = 100_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const SHA256 = /^[a-f0-9]{64}$/;
export type NativeSnapshotBinding =
  | { status: "verified"; snapshotSha256: string; policy: string }
  | { status: "blocked"; binding: "caller-asserted"; reason: string };
const safePath = (name: string): boolean =>
  !name.startsWith("/") &&
  !name.includes("\\") &&
  name.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  Buffer.byteLength(name) <= MAX_PATH_BYTES;
const length = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/**
 * Domain `ghostdeps-native-tree-v1\0`, 32-byte SHA-256 exclusion/scope policy
 * digest, then scanner-visible sorted entries. For each file:
 * type `F`, uint64-be path byte length, UTF-8 path, uint64-be byte length,
 * exact raw bytes. For each in-tree symlink: type `L`, path framing above,
 * uint64-be target byte length and UTF-8 raw target. No symlink is followed.
 * Escaping links, incomplete listings and any read/cap error block the hash.
 */
/** One implementation serves scan-time minting and producer-time comparison. */
export async function mintNativeSnapshot(
  repository: RepositoryHandle,
): Promise<NativeSnapshotBinding> {
  return calculate(repository);
}
export async function verifyNativeSnapshot(
  repository: RepositoryHandle,
  snapshotSha256: string,
): Promise<NativeSnapshotBinding> {
  if (!SHA256.test(snapshotSha256))
    return { status: "blocked", binding: "caller-asserted", reason: "invalid-snapshot-digest" };
  return calculate(repository, snapshotSha256);
}
async function calculate(
  repository: RepositoryHandle,
  expected?: string,
): Promise<NativeSnapshotBinding> {
  const blocked = (reason: string): NativeSnapshotBinding => ({
    status: "blocked",
    binding: "caller-asserted",
    reason,
  });
  if (!repository.listEntries || !repository.readFileBytes)
    return blocked("snapshot-capability-unavailable");
  try {
    const listing = await repository.listEntries();
    if (!listing.complete || listing.limitations.length) return blocked("incomplete-listing");
    if (!SHA256.test(listing.policy)) return blocked("policy-unavailable");
    if (!Array.isArray(listing.entries) || listing.entries.length > MAX_FILES)
      return blocked("file-count-cap");
    const sorted = [...listing.entries].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    );
    const seen = new Set<string>();
    const seenFolded = new Set<string>();
    const hash = createHash("sha256")
      .update("ghostdeps-native-tree-v1\0")
      .update(Buffer.from(listing.policy, "hex"));
    let total = 0;
    for (const entry of sorted) {
      if (
        entry.path.normalize("NFC") !== entry.path ||
        !safePath(entry.path) ||
        seen.has(entry.path)
      )
        return blocked("unsafe-or-duplicate-path");
      seen.add(entry.path);
      const folded = entry.path.toLowerCase();
      if (seenFolded.has(folded)) return blocked("unsafe-or-duplicate-path");
      seenFolded.add(folded);
      const name = Buffer.from(entry.path);
      if (entry.kind === "symlink") {
        if (
          typeof entry.target !== "string" ||
          !entry.target ||
          entry.target.startsWith("/") ||
          entry.target.includes("\\") ||
          !safePath(
            path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target)),
          )
        )
          return blocked("symlink-escape");
        if (Buffer.byteLength(entry.target) > MAX_PATH_BYTES) return blocked("byte-cap");
        const target = Buffer.from(entry.target);
        hash
          .update("L")
          .update(length(name.length))
          .update(name)
          .update(length(target.length))
          .update(target);
      } else if (entry.kind === "file") {
        const bytes = await repository.readFileBytes(entry.path, entry);
        if (!(bytes instanceof Uint8Array)) return blocked("invalid-file-bytes");
        if (bytes.byteLength > MAX_FILE_BYTES || total + bytes.byteLength > MAX_TOTAL_BYTES)
          return blocked("byte-cap");
        total += bytes.byteLength;
        hash
          .update("F")
          .update(length(name.length))
          .update(name)
          .update(length(bytes.byteLength))
          .update(bytes);
      } else return blocked("unsupported-entry");
    }
    // One fresh enumeration pass; read each listed file against its stat
    // identity. A mismatched/vanished file blocks rather than stitching states.
    const actual = hash.digest();
    if (expected && !timingSafeEqual(actual, Buffer.from(expected, "hex")))
      return blocked("snapshot-mismatch");
    return { status: "verified", snapshotSha256: actual.toString("hex"), policy: listing.policy };
  } catch {
    return blocked("snapshot-read-failed");
  }
}
