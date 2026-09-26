import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FsRepositoryHandle } from "../engine/scanner/handle.js";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import { mintNativeSnapshot, verifyNativeSnapshot } from "./snapshot.js";

const policy = "c".repeat(64);
const digest = (entries: readonly { path: string; bytes: Uint8Array }[]) => {
  const h = createHash("sha256")
    .update("ghostdeps-native-tree-v1\0")
    .update(Buffer.from(policy, "hex"));
  const len = (value: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(value));
    return b;
  };
  for (const { path, bytes } of [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  )) {
    const name = Buffer.from(path);
    h.update("F").update(len(name.length)).update(name).update(len(bytes.length)).update(bytes);
  }
  return h.digest("hex");
};
const mock = (
  entries: RepositoryTreeEntry[],
  contents: Record<string, Uint8Array>,
): RepositoryHandle => ({
  listFiles: async () =>
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
  exists: async (name) => name in contents,
  readFile: async (name) => Buffer.from(contents[name]!).toString("utf8"),
  readFileBytes: async (name) => contents[name]!,
  listEntries: async () => ({ entries, complete: true, limitations: [], policy }),
});

describe("canonical repository snapshot binding (#440)", () => {
  it("verifies byte-identical typed tree in sorted path order", async () => {
    const a = new Uint8Array([0xff, 0x00, 0x61]);
    const b = new Uint8Array([10]);
    const repo = mock(
      [
        { path: "b", kind: "file" },
        { path: "a", kind: "file" },
      ],
      { a, b },
    );
    const expected = digest([
      { path: "a", bytes: a },
      { path: "b", bytes: b },
    ]);
    assert.deepEqual(await verifyNativeSnapshot(repo, expected), {
      status: "verified",
      snapshotSha256: expected,
      policy,
    });
    assert.equal(
      (
        await verifyNativeSnapshot(
          mock(
            [
              { path: "a", kind: "file" },
              { path: "b", kind: "file" },
            ],
            { a: new Uint8Array([0xff, 0x00, 0x62]), b },
          ),
          expected,
        )
      ).status,
      "blocked",
    );
  });
  it("refuses missing capability, incomplete listing, and file-count and byte caps", async () => {
    const tiny = digest([{ path: "a", bytes: new Uint8Array([1]) }]);
    assert.equal(
      (
        await verifyNativeSnapshot(
          { listFiles: async () => ["a"], readFile: async () => "x", exists: async () => true },
          tiny,
        )
      ).status,
      "blocked",
    );
    const repo = mock([{ path: "a", kind: "file" }], { a: new Uint8Array([1]) });
    repo.listEntries = async () => ({
      entries: [{ path: "a", kind: "file" }],
      complete: false,
      limitations: ["truncated:max-files"],
      policy,
    });
    assert.deepEqual(await verifyNativeSnapshot(repo, tiny), {
      status: "blocked",
      binding: "caller-asserted",
      reason: "incomplete-listing",
    });
    repo.listEntries = async () => ({
      entries: Array.from({ length: 100001 }, (_, i) => ({ path: `f${i}`, kind: "file" as const })),
      complete: true,
      limitations: [],
      policy,
    });
    assert.deepEqual(await verifyNativeSnapshot(repo, tiny), {
      status: "blocked",
      binding: "caller-asserted",
      reason: "file-count-cap",
    });
    const tooLarge = mock([{ path: "huge", kind: "file" }], {
      huge: new Uint8Array(32 * 1024 * 1024 + 1),
    });
    assert.deepEqual(await verifyNativeSnapshot(tooLarge, tiny), {
      status: "blocked",
      binding: "caller-asserted",
      reason: "byte-cap",
    });
  });
  it("FsRepositoryHandle exposes symlinks and refuses escaping links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-snapshot-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src/a"), "ok");
      await symlink("../../outside", path.join(root, "src/escape"));
      const handle = await FsRepositoryHandle.open(root);
      const listed = await handle.listEntries();
      assert.equal(
        listed.entries.find((entry) => entry.path === "src/escape")?.target,
        "../../outside",
      );
      assert.deepEqual(await verifyNativeSnapshot(handle, "a".repeat(64)), {
        status: "blocked",
        binding: "caller-asserted",
        reason: "symlink-escape",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("keeps excluded node_modules outside the scanner-visible domain, but binds policy", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "ghostdeps-visible-one-"));
  const second = await mkdtemp(path.join(tmpdir(), "ghostdeps-visible-two-"));
  try {
    for (const root of [first, second]) {
      await writeFile(path.join(root, "package.json"), '{"name":"same"}');
      await mkdir(path.join(root, "node_modules"));
    }
    await writeFile(path.join(first, "node_modules/dep.js"), "one");
    await writeFile(path.join(second, "node_modules/dep.js"), "different");
    const a = await FsRepositoryHandle.open(first);
    const b = await FsRepositoryHandle.open(second);
    const minted = await mintNativeSnapshot(a);
    assert.equal(minted.status, "verified");
    if (minted.status !== "verified") return;
    // Intentional: the scanner excludes node_modules under the recorded policy.
    assert.deepEqual(await verifyNativeSnapshot(b, minted.snapshotSha256), minted);
    const otherPolicy = await FsRepositoryHandle.open(second, {
      excludedDirectories: new Set([".git"]),
    });
    const changed = await mintNativeSnapshot(otherPolicy);
    assert.equal(changed.status, "verified");
    if (changed.status !== "verified") return;
    assert.notEqual(changed.snapshotSha256, minted.snapshotSha256);
    assert.notEqual(changed.policy, minted.policy);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

it("re-enumerates the same FsRepositoryHandle after a file is added", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-refresh-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    const handle = await FsRepositoryHandle.open(root);
    const before = await mintNativeSnapshot(handle);
    assert.equal(before.status, "verified");
    if (before.status !== "verified") return;
    await writeFile(
      path.join(root, "ghostdeps.targets.json"),
      '{"schemaVersion":1,"complete":true,"targets":[]}',
    );
    const after = await mintNativeSnapshot(handle);
    assert.equal(after.status, "verified");
    if (after.status !== "verified") return;
    assert.notEqual(before.snapshotSha256, after.snapshotSha256);
    assert.equal((await verifyNativeSnapshot(handle, before.snapshotSha256)).status, "blocked");
    assert.deepEqual(await verifyNativeSnapshot(handle, after.snapshotSha256), after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("blocks if a listed file changes before the byte read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-change-"));
  try {
    await writeFile(path.join(root, "package.json"), "old");
    const handle = await FsRepositoryHandle.open(root);
    const original = handle.listEntries.bind(handle);
    handle.listEntries = async () => {
      const listing = await original();
      await writeFile(path.join(root, "package.json"), "new value");
      return listing;
    };
    assert.deepEqual(await mintNativeSnapshot(handle), {
      status: "blocked",
      binding: "caller-asserted",
      reason: "snapshot-read-failed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("blocks when a visible file is added between the first listing and byte reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-midpass-add-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    const handle = await FsRepositoryHandle.open(root);
    const minted = await mintNativeSnapshot(handle);
    assert.equal(minted.status, "verified");
    if (minted.status !== "verified") return;
    const read = handle.readFileBytes.bind(handle);
    let injected = false;
    handle.readFileBytes = async (name, expected) => {
      if (!injected) {
        injected = true;
        await writeFile(path.join(root, "ghostdeps.targets.json"), "{}");
      }
      return read(name, expected);
    };
    assert.deepEqual(await verifyNativeSnapshot(handle, minted.snapshotSha256), {
      status: "blocked",
      binding: "caller-asserted",
      reason: "listing-changed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
