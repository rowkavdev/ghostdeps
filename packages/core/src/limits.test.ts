import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXCLUDED_DIRECTORIES,
  EXCLUDED_FILE_SUFFIXES,
  MAX_FILE_READ_BYTES,
  MAX_LOCKFILE_BYTES,
  MAX_REPO_FILES,
  hasExcludedSegment,
} from "./limits.js";
import { DEFAULT_SCAN_LIMITS } from "./engine/scanner/limits.js";
import { DEFAULT_EXCLUDED_DIRECTORIES } from "./engine/scanner/exclusions.js";

describe("shared limits (issue #89)", () => {
  it("scanner exclusions re-export the shared list, never a fork", () => {
    assert.equal(DEFAULT_EXCLUDED_DIRECTORIES, EXCLUDED_DIRECTORIES);
  });

  it("scanner defaults mirror the shared ceilings", () => {
    assert.equal(DEFAULT_SCAN_LIMITS.maxFiles, MAX_REPO_FILES);
    assert.equal(DEFAULT_SCAN_LIMITS.maxFileBytes, MAX_FILE_READ_BYTES);
    assert.equal(DEFAULT_SCAN_LIMITS.maxLockfileBytes, MAX_LOCKFILE_BYTES);
  });

  it("the values stay conservative and documented", () => {
    assert.equal(MAX_REPO_FILES, 50_000);
    assert.equal(MAX_FILE_READ_BYTES, 2 * 1024 * 1024);
    assert.equal(MAX_LOCKFILE_BYTES, 32 * 1024 * 1024);
    assert.ok(MAX_LOCKFILE_BYTES > MAX_FILE_READ_BYTES, "lockfiles are legitimately larger");
  });

  it("hasExcludedSegment matches any path segment", () => {
    assert.ok(hasExcludedSegment("node_modules/left-pad/index.js"));
    assert.ok(hasExcludedSegment("packages/a/dist/bundle.js"));
    assert.ok(hasExcludedSegment(".git/config"));
    assert.ok(!hasExcludedSegment("src/index.ts"));
    assert.ok(!hasExcludedSegment("src/distribution/list.ts"), "no substring matching");
  });

  it("excluded suffixes cover minified bundles and source maps", () => {
    for (const suffix of [".min.js", ".min.mjs", ".min.cjs", ".min.css", ".map"])
      assert.ok(EXCLUDED_FILE_SUFFIXES.includes(suffix));
  });
});
