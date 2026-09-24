import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTrailingCommas } from "./bun.js";

describe("stripTrailingCommas", () => {
  it("removes trailing commas but never touches strings", () => {
    const text = `{ "a": [1, 2, ], "b": "x, }", "c": "q\\", ]", }`;
    assert.deepEqual(JSON.parse(stripTrailingCommas(text)), { a: [1, 2], b: "x, }", c: 'q", ]' });
  });
});
