import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceLineChanges } from "../types/index.js";
import { reconstructBase } from "./reconstruct-base.js";

const change = (
  removed: [number, string][],
  added: [number, string][] = [],
): SourceLineChanges => ({
  path: "x.ts",
  removedLines: removed.map(([line, text]) => ({ line, text })),
  addedLines: added.map(([line, text]) => ({ line, text })),
});

describe("reconstructBase (#259)", () => {
  it("rebuilds base from head, removed and added lines", () => {
    assert.deepEqual(reconstructBase(["a", "NEW", "c"], change([[2, "b"]], [[2, "NEW"]])), [
      "a",
      "b",
      "c",
    ]);
  });

  it("puts a removed line back between shared lines", () => {
    assert.deepEqual(reconstructBase(["a", "c"], change([[2, "b"]])), ["a", "b", "c"]);
  });

  it("drops added lines", () => {
    assert.deepEqual(
      reconstructBase(
        ["a", "x", "y", "b"],
        change(
          [],
          [
            [2, "x"],
            [3, "y"],
          ],
        ),
      ),
      ["a", "b"],
    );
  });

  it("rebuilds a deleted file from its removed lines alone", () => {
    assert.deepEqual(
      reconstructBase(
        [],
        change([
          [1, "import a from 'a';"],
          [2, "a();"],
        ]),
      ),
      ["import a from 'a';", "a();"],
    );
  });

  it("appends removed trailing lines", () => {
    assert.deepEqual(
      reconstructBase(
        ["a"],
        change([
          [2, "b"],
          [3, "c"],
        ]),
      ),
      ["a", "b", "c"],
    );
  });

  it("returns head unchanged for an empty change", () => {
    assert.deepEqual(reconstructBase(["a", "b"], change([])), ["a", "b"]);
  });

  it("is undefined when an added line is past the end of head", () => {
    assert.equal(reconstructBase(["a"], change([], [[2, "x"]])), undefined);
  });

  it("is undefined when a removed line cannot be placed", () => {
    // Base line 5 would need three shared lines before it; head has one.
    assert.equal(reconstructBase(["a"], change([[5, "e"]])), undefined);
  });
});
