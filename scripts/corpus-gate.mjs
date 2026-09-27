/**
 * Corpus relevance gate (#172): the single source of truth for which changed
 * paths must run the full pinned-corpus scan on a PR - engine code, the
 * harness, the corpus itself, this workflow, or the dependency surface the
 * detectors see. The changes job in corpus.yml pipes `git diff --name-only`
 * into this script; the tests pin the classification, so the workflow and
 * its tests can never disagree about the path list.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const RELEVANT =
  /^(corpus\/|scripts\/corpus|\.github\/workflows\/corpus\.yml|packages\/|pnpm-lock\.yaml)/;

/** True when any changed path can drift corpus findings. */
export function isCorpusRelevant(changedFiles) {
  return changedFiles.some((f) => RELEVANT.test(f));
}

async function main() {
  const files = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const f = line.trim();
    if (f !== "") files.push(f);
  }
  process.stdout.write(`${isCorpusRelevant(files)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
