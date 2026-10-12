/** Inert slice-4 preparation: no event handler or workflow invokes this module. */
import { createHash, createPublicKey, verify } from "node:crypto";

export interface ApplyEnvelope {
  version: 1;
  repositoryId: number;
  installationId: number;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  commentId: number;
  canonicalBodySha256: string;
  scanScopeSha256: string;
  deliveryId: string;
  nonce: string;
  expiresAt: number;
  findings: readonly { key: string; evidenceSha256: string }[];
}

export interface SignedApplyEnvelope {
  envelope: ApplyEnvelope;
  signature: string; // base64url Ed25519 signature over the canonical envelope bytes
}

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9:._/-]{1,256}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const FIELDS = [
  "version",
  "repositoryId",
  "installationId",
  "pullNumber",
  "baseSha",
  "headSha",
  "commentId",
  "canonicalBodySha256",
  "scanScopeSha256",
  "deliveryId",
  "nonce",
  "expiresAt",
  "findings",
];
const FINDING_FIELDS = ["key", "evidenceSha256"];
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));

export function canonicalEnvelope(e: ApplyEnvelope): Buffer {
  // Fixed field order: signatures never depend on incoming JSON property order.
  return Buffer.from(
    JSON.stringify({
      version: e.version,
      repositoryId: e.repositoryId,
      installationId: e.installationId,
      pullNumber: e.pullNumber,
      baseSha: e.baseSha,
      headSha: e.headSha,
      commentId: e.commentId,
      canonicalBodySha256: e.canonicalBodySha256,
      scanScopeSha256: e.scanScopeSha256,
      deliveryId: e.deliveryId,
      nonce: e.nonce,
      expiresAt: e.expiresAt,
      findings: e.findings.map((f) => ({ key: f.key, evidenceSha256: f.evidenceSha256 })),
    }),
    "utf8",
  );
}

export function verifyApplyEnvelope(
  raw: string,
  pinnedPublicKeyPem: string,
  expected: { repositoryId: number; installationId: number; now: number },
): ApplyEnvelope {
  if (Buffer.byteLength(raw) > 32768) throw new Error("envelope too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid envelope JSON");
  }
  if (!record(parsed) || !exact(parsed, ["envelope", "signature"]) || !record(parsed.envelope))
    throw new Error("invalid signed envelope shape");
  const e = parsed.envelope;
  if (
    !exact(e, FIELDS) ||
    e.version !== 1 ||
    !integer(e.repositoryId) ||
    !integer(e.installationId) ||
    !integer(e.pullNumber) ||
    !integer(e.commentId) ||
    typeof e.baseSha !== "string" ||
    !SHA.test(e.baseSha) ||
    typeof e.headSha !== "string" ||
    !SHA.test(e.headSha) ||
    typeof e.canonicalBodySha256 !== "string" ||
    !DIGEST.test(e.canonicalBodySha256) ||
    typeof e.scanScopeSha256 !== "string" ||
    !DIGEST.test(e.scanScopeSha256) ||
    typeof e.deliveryId !== "string" ||
    !ID.test(e.deliveryId) ||
    typeof e.nonce !== "string" ||
    !ID.test(e.nonce) ||
    !integer(e.expiresAt) ||
    !Array.isArray(e.findings) ||
    !e.findings.length ||
    e.findings.length > 32 ||
    !e.findings.every(
      (f: unknown) =>
        record(f) &&
        exact(f, FINDING_FIELDS) &&
        typeof f.key === "string" &&
        KEY.test(f.key) &&
        typeof f.evidenceSha256 === "string" &&
        DIGEST.test(f.evidenceSha256),
    )
  )
    throw new Error("invalid envelope claims");
  const envelope = e as unknown as ApplyEnvelope;
  if (new Set(envelope.findings.map((f) => f.key)).size !== envelope.findings.length)
    throw new Error("duplicate finding");
  if (
    envelope.repositoryId !== expected.repositoryId ||
    envelope.installationId !== expected.installationId
  )
    throw new Error("wrong recipient");
  if (
    !Number.isSafeInteger(expected.now) ||
    expected.now >= envelope.expiresAt ||
    envelope.expiresAt - expected.now > 300_000
  )
    throw new Error("expired or excessive lifetime");
  if (typeof parsed.signature !== "string" || !SIG.test(parsed.signature))
    throw new Error("invalid signature encoding");
  const signature = Buffer.from(parsed.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== parsed.signature)
    throw new Error("invalid signature bytes");
  const key = createPublicKey(pinnedPublicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, canonicalEnvelope(envelope), key, signature)
  )
    throw new Error("signature verification failed");
  return envelope;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
