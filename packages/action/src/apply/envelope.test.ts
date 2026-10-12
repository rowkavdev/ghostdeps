import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalEnvelope, verifyApplyEnvelope, type ApplyEnvelope } from "./envelope.js";
import { commitVerifiedBatch, type CommitOnlyPort } from "./commit-only.js";
import { sha256 } from "./envelope.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const now = 1_800_000_000_000;
const envelope: ApplyEnvelope = {
  version: 1,
  repositoryId: 1,
  installationId: 2,
  pullNumber: 3,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  commentId: 4,
  canonicalBodySha256: "c".repeat(64),
  scanScopeSha256: "d".repeat(64),
  deliveryId: "delivery-1",
  nonce: "nonce-1",
  expiresAt: now + 60_000,
  findings: [{ key: "unused:js:abc", evidenceSha256: "e".repeat(64) }],
};
const signed = (e: ApplyEnvelope) =>
  JSON.stringify({
    envelope: e,
    signature: sign(null, canonicalEnvelope(e), privateKey).toString("base64url"),
  });
const check = (s: string) =>
  verifyApplyEnvelope(s, pem, { repositoryId: 1, installationId: 2, now });

describe("inert signed envelope", () => {
  it("accepts a bounded signature for the exact recipient", () =>
    assert.deepEqual(check(signed(envelope)), envelope));
  it("rejects modified claims", () =>
    assert.throws(() =>
      check(
        JSON.stringify({
          envelope: { ...envelope, pullNumber: 9 },
          signature: JSON.parse(signed(envelope)).signature,
        }),
      ),
    ));
  it("rejects stale, future, duplicate and foreign claims", () => {
    for (const e of [
      { ...envelope, expiresAt: now },
      { ...envelope, expiresAt: now + 301_000 },
      { ...envelope, installationId: 3 },
      { ...envelope, findings: [envelope.findings[0]!, envelope.findings[0]!] },
    ])
      assert.throws(() => check(signed(e)));
  });
  it("rejects unknown fields and oversized input", () => {
    assert.throws(() => check(signed({ ...envelope, unexpected: 1 } as ApplyEnvelope)));
    assert.throws(() => check("x".repeat(32769)));
  });
});

function port(over: Partial<CommitOnlyPort> = {}): CommitOnlyPort & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    readHead: async () => envelope.headSha,
    revalidate: async () => ({
      oldHeadSha: envelope.headSha,
      provenance: "fresh-runner-validation",
      files: [
        { path: "package.json", bytes: Buffer.from("{}"), sha256: sha256(Buffer.from("{}")) },
        { path: "package-lock.json", bytes: Buffer.from("{}"), sha256: sha256(Buffer.from("{}")) },
      ],
    }),
    createCommit: async () => {
      writes.push("commit");
      return "f".repeat(40);
    },
    updateRefNonForce: async () => {
      writes.push("cas");
    },
    ...over,
  };
}

describe("commit-only CAS boundary", () => {
  it("writes one commit only after fresh validation and head reads", async () => {
    const p = port();
    assert.equal(await commitVerifiedBatch(envelope, p), "f".repeat(40));
    assert.deepEqual(p.writes, ["commit", "cas"]);
  });
  it("does not write when head moved", async () => {
    const p = port({ readHead: async () => "c".repeat(40) });
    await assert.rejects(commitVerifiedBatch(envelope, p));
    assert.deepEqual(p.writes, []);
  });
  it("does not write a hash mismatch or manifest-only batch", async () => {
    const p = port({
      revalidate: async () => ({
        oldHeadSha: envelope.headSha,
        provenance: "fresh-runner-validation",
        files: [{ path: "package.json", bytes: Buffer.from("{}"), sha256: "0".repeat(64) }],
      }),
    });
    await assert.rejects(commitVerifiedBatch(envelope, p));
    assert.deepEqual(p.writes, []);
  });
});
