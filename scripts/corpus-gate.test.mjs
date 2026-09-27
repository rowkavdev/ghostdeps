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

// Integration tests for the changes job's filter step (#172 review): the
// exact shell construct the workflow runs must fail the step when git diff
// fails - never write corpus=false from a swallowed substitution.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const gatePath = join(dirname(fileURLToPath(import.meta.url)), "corpus-gate.mjs");

// Scratch repos carry their own identity: CI runners have none configured.
const GIT_IDENTITY = ["-c", "user.name=corpus-gate-test", "-c", "user.email=test@example.invalid"];

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "corpus-gate-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", [...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "base"], {
    cwd: dir,
  });
  return dir;
}

// Mirrors the filter step in .github/workflows/corpus.yml, runner shell
// included (bash -eo pipefail).
function runFilterStep(dir, ref, outFile) {
  execFileSync(
    "bash",
    [
      "-eo",
      "pipefail",
      "-c",
      `relevant=$(git diff --name-only "${ref}...HEAD" | node "${gatePath}")\n` +
        `echo "corpus=\${relevant}" >> "${outFile}"`,
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("a failed git diff fails the step and writes nothing", () => {
  const dir = gitRepo();
  const outFile = join(dir, "github-output");
  assert.throws(() => runFilterStep(dir, "0000000000000000000000000000000000000000", outFile));
  assert.throws(() => readFileSync(outFile, "utf8"), /ENOENT/);
});

test("a valid diff writes the gated value the corpus job reads", () => {
  const dir = gitRepo();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "-b", "pr"], { cwd: dir });
  execFileSync("git", [...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "docs"], {
    cwd: dir,
  });
  const outFile = join(dir, "github-output");
  runFilterStep(dir, base, outFile);
  assert.equal(readFileSync(outFile, "utf8").trim(), "corpus=false");
});
