import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeUtf8Length, readRepositoryFileHead, utf8Head } from "./repository-head.js";
import type { RepositoryHandle } from "./types/index.js";

const files: Record<string, string> = {
  "yarn.lock": "__metadata:\n  version: 8\n",
  // "é" is 2 bytes, "€" is 3, "😀" is 4.
  "multi.txt": "aé€😀z",
};

const withoutHead: RepositoryHandle = {
  async listFiles() {
    return Object.keys(files);
  },
  async readFile(path) {
    const text = files[path];
    if (text === undefined) throw new Error(`not found: ${path}`);
    return text;
  },
  async exists(path) {
    return path in files;
  },
};

const withHead: RepositoryHandle = {
  ...withoutHead,
  async readFileHead(path, maxBytes) {
    const text = files[path];
    return text === undefined ? undefined : utf8Head(Buffer.from(text, "utf8"), maxBytes);
  },
};

describe("readRepositoryFileHead (#113 contract)", () => {
  it("returns byte-equivalent prefixes with and without readFileHead, across multibyte boundaries", async () => {
    const total = Buffer.byteLength(files["multi.txt"]!, "utf8");
    for (let n = 0; n <= total + 1; n++) {
      const a = await readRepositoryFileHead(withHead, "multi.txt", n);
      const b = await readRepositoryFileHead(withoutHead, "multi.txt", n);
      assert.equal(a, b, `maxBytes ${n}`);
      assert.ok(!a!.includes("\ufffd"), `no replacement char at ${n}`);
      assert.ok(Buffer.byteLength(a!, "utf8") <= n, `at most ${n} bytes`);
    }
    // Torn characters are dropped whole.
    assert.equal(await readRepositoryFileHead(withoutHead, "multi.txt", 2), "a");
    assert.equal(await readRepositoryFileHead(withoutHead, "multi.txt", 3), "aé");
    assert.equal(await readRepositoryFileHead(withoutHead, "multi.txt", 5), "aé");
    assert.equal(await readRepositoryFileHead(withoutHead, "multi.txt", 6), "aé€");
    assert.equal(await readRepositoryFileHead(withoutHead, "multi.txt", 9), "aé€");
    assert.equal(await readRepositoryFileHead(withoutHead, "multi.txt", 10), "aé€😀");
  });

  it("caps source bytes, not lines", async () => {
    assert.equal(await readRepositoryFileHead(withHead, "yarn.lock", 13), "__metadata:\n ");
  });

  it("feature-detects readFileHead rather than trusting a version", async () => {
    let headCalls = 0;
    const spy: RepositoryHandle = {
      ...withHead,
      async readFileHead(path, maxBytes) {
        headCalls++;
        return withHead.readFileHead!(path, maxBytes);
      },
    };
    await readRepositoryFileHead(spy, "yarn.lock", 4);
    assert.equal(headCalls, 1);
    const notAFunction = { ...withoutHead, readFileHead: "nope" } as unknown as RepositoryHandle;
    assert.equal(await readRepositoryFileHead(notAFunction, "yarn.lock", 4), "__me");
  });

  it("maps not-found and throwing handles to undefined", async () => {
    assert.equal(await readRepositoryFileHead(withHead, "missing", 10), undefined);
    assert.equal(await readRepositoryFileHead(withoutHead, "missing", 10), undefined);
    const throwing: RepositoryHandle = {
      ...withoutHead,
      async readFileHead() {
        throw new Error("boom");
      },
    };
    assert.equal(await readRepositoryFileHead(throwing, "yarn.lock", 10), undefined);
  });

  it("completeUtf8Length drops only an unfinished trailing sequence", () => {
    assert.equal(completeUtf8Length(Buffer.from([0x61, 0xe2, 0x82])), 1);
    assert.equal(completeUtf8Length(Buffer.from([0x61, 0xe2, 0x82, 0xac])), 4);
    assert.equal(completeUtf8Length(Buffer.from([0xf0, 0x9f, 0x98])), 0);
    assert.equal(completeUtf8Length(Buffer.from([])), 0);
  });
});
