// Path classification tests for the corpus relevance gate (#172 review):
// relevant, docs-only, and boundary paths are pinned against the same
// isCorpusRelevant the workflow pipes its diff into.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCorpusRelevant } from "./corpus-gate.mjs";

test("corpus pins and goldens are relevant", () => {
  assert.equal(isCorpusRelevant(["corpus/repos.json"]), true);
  assert.equal(isCorpusRelevant(["corpus/golden/uuid.json"]), true);
});

test("the harness, its parser, tests and streak counter are relevant", () => {
  assert.equal(isCorpusRelevant(["scripts/corpus.mjs"]), true);
  assert.equal(isCorpusRelevant(["scripts/corpus-scan-output.mjs"]), true);
  assert.equal(isCorpusRelevant(["scripts/corpus-streak.mjs"]), true);
});

test("the workflow itself is relevant", () => {
  assert.equal(isCorpusRelevant([".github/workflows/corpus.yml"]), true);
});

test("engine code and the dependency surface are relevant", () => {
  assert.equal(isCorpusRelevant(["packages/core/src/index.ts"]), true);
  assert.equal(isCorpusRelevant(["pnpm-lock.yaml"]), true);
});

test("docs-only and unrelated changes are not relevant", () => {
  assert.equal(isCorpusRelevant(["docs/corpus-promotion.md", "README.md"]), false);
  assert.equal(isCorpusRelevant(["scripts/release.mjs"]), false);
  assert.equal(isCorpusRelevant([".github/workflows/ci.yml"]), false);
});

test("an empty diff is not relevant", () => {
  assert.equal(isCorpusRelevant([]), false);
});

test("one relevant file in a mixed diff gates the scan on", () => {
  assert.equal(isCorpusRelevant(["README.md", "packages/cli/src/main.ts", "docs/x.md"]), true);
});
