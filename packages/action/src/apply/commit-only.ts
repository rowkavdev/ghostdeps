/** Inert, injectable commit-only CAS core. No runner, secret, checkout or dispatch wiring. */
import { sha256, type ApplyEnvelope } from "./envelope.js";

export interface VerifiedFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}
export interface VerifiedBatch {
  oldHeadSha: string;
  files: readonly VerifiedFile[];
  // Revalidated independently against the current PR/comment and static overlay.
  provenance: "fresh-runner-validation";
}
export interface CommitOnlyPort {
  // Must use a dedicated, repository-scoped App installation token, never GITHUB_TOKEN.
  readHead(): Promise<string>;
  // Must re-read PR, comment, permissions, scan provenance and selected tick state.
  revalidate(e: ApplyEnvelope): Promise<VerifiedBatch>;
  // Write blobs/tree/commit using the dedicated App token; do not checkout or run npm here.
  createCommit(parent: string, files: readonly VerifiedFile[], message: string): Promise<string>;
  // GitHub PATCH git/refs/heads/<branch> force:false; rejection means no overwrite.
  updateRefNonForce(newSha: string): Promise<void>;
}

const safePath = (p: string): boolean =>
  p.length > 0 &&
  p.length <= 512 &&
  !p.startsWith("/") &&
  p.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  /(^|\/)package(-lock)?\.json$/.test(p);

/** A network failure after updateRef is ambiguous: caller MUST read branch before retrying. */
export async function commitVerifiedBatch(e: ApplyEnvelope, port: CommitOnlyPort): Promise<string> {
  const batch = await port.revalidate(e);
  if (batch.provenance !== "fresh-runner-validation" || batch.oldHeadSha !== e.headSha)
    throw new Error("missing fresh validation");
  if (
    batch.files.length !== 2 ||
    !batch.files.every(
      (file) =>
        safePath(file.path) && file.bytes.length <= 2_000_000 && sha256(file.bytes) === file.sha256,
    ) ||
    new Set(batch.files.map((file) => file.path)).size !== batch.files.length ||
    !batch.files.some(
      (file) => file.path.endsWith("/package.json") || file.path === "package.json",
    ) ||
    !batch.files.some(
      (file) => file.path.endsWith("/package-lock.json") || file.path === "package-lock.json",
    ) ||
    batch.files[0]!.path.replace(/(?:^|\/)package(?:-lock)?\.json$/, "") !==
      batch.files[1]!.path.replace(/(?:^|\/)package(?:-lock)?\.json$/, "")
  )
    throw new Error("unverified manifest/lockfile pair");
  if ((await port.readHead()) !== e.headSha) throw new Error("PR head moved");
  // No user-provided text or file path is interpolated in a commit message.
  const commit = await port.createCommit(
    e.headSha,
    batch.files,
    "ghostdeps: apply maintainer-selected dependency fix",
  );
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("invalid commit identity");
  if ((await port.readHead()) !== e.headSha) throw new Error("PR head moved before CAS");
  await port.updateRefNonForce(commit);
  return commit;
}
