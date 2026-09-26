import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMarker, MAX_MARKER_KEYS, MAX_MARKER_LINE, parseMarker } from "./marker.js";

const KEY = "a".repeat(64);
const SHA = "b".repeat(40);

describe("comment marker", () => {
  it("round-trips a well-formed marker", () => {
    const marker = { repositoryId: 7, pullNumber: 42, headSha: SHA, keys: [KEY] };
    assert.deepEqual(parseMarker(buildMarker(marker)), marker);
  });

  it("accepts an empty key list", () => {
    const marker = { repositoryId: 1, pullNumber: 2, headSha: SHA, keys: [] };
    assert.deepEqual(parseMarker(buildMarker(marker)), marker);
  });

  it("rejects malformed input at build time", () => {
    assert.throws(() => buildMarker({ repositoryId: 0, pullNumber: 1, headSha: SHA, keys: [] }));
    assert.throws(() => buildMarker({ repositoryId: 1, pullNumber: 1, headSha: "xyz", keys: [] }));
    assert.throws(() =>
      buildMarker({ repositoryId: 1, pullNumber: 1, headSha: SHA, keys: ["not-hex"] }),
    );
    assert.throws(() =>
      buildMarker({
        repositoryId: 1,
        pullNumber: 1,
        headSha: SHA,
        keys: Array.from({ length: MAX_MARKER_KEYS + 1 }, () => KEY),
      }),
    );
  });

  it("parses only a first-line marker, never a later forged one", () => {
    const good = buildMarker({ repositoryId: 1, pullNumber: 2, headSha: SHA, keys: [] });
    assert.equal(parseMarker(`hello\n${good}`), undefined);
    const forged = buildMarker({ repositoryId: 999, pullNumber: 2, headSha: SHA, keys: [] });
    assert.deepEqual(parseMarker(`${good}\n${forged}`)?.repositoryId, 1);
  });

  it("round-trips at the full key budget and stays inside the parse budget", () => {
    const keys = Array.from({ length: MAX_MARKER_KEYS }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const marker = { repositoryId: 123456789, pullNumber: 987654, headSha: SHA, keys };
    const line = buildMarker(marker);
    assert.ok(line.length <= MAX_MARKER_LINE, `marker line ${line.length} chars`);
    assert.deepEqual(parseMarker(line), marker);
  });

  it("rejects duplicate keys", () => {
    const body = `<!-- ghostdeps-comment:v1 repo:1 pr:2 sha:${SHA} keys:${KEY},${KEY} -->`;
    assert.equal(parseMarker(body), undefined);
  });
});
