#!/usr/bin/env node
/**
 * Pinned-corpus regression harness (#172).
 *
 * Runs `ghostdeps scan --json` against real repositories pinned by full commit
 * SHA (corpus/repos.json) and fails when the produced finding set drifts from
 * the golden expectations (corpus/golden/<name>.json). A golden entry is the
 * exact set of { kind, severity, dependency } the CLI must produce at that
 * pin, plus the expected exit code - scoped to what the CLI emits today, and
 * deliberately verdict-agnostic so new finding kinds just appear in diffs.
 *
 * Usage:
 *   node scripts/corpus.mjs            check mode: diff against goldens
 *   node scripts/corpus.mjs --update   regenerate goldens (ride PR review)
 *
 * Requires a build first (`pnpm build`): the runner spawns the built CLI and
 * imports core's severity ladder from dist, so severity is computed exactly
 * the way the renderers compute it, never reimplemented here.
 *
 * Checkouts are shallow and read-only: nothing in a corpus repo is installed
 * or executed, matching the scanner's static-analysis contract (ADR 0004).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".corpus-cache");
const config = JSON.parse(readFileSync(join(root, "corpus/repos.json"), "utf8"));
const update = process.argv.includes("--update");

const cliPath = join(root, "packages/cli/dist/main.js");
if (!existsSync(cliPath)) {
  console.error("error: packages/cli/dist is missing - run `pnpm build` first");
  process.exit(2);
}
const { severityOf } = await import(join(root, "packages/core/dist/index.js"));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
}

/** Shallow-fetch the pinned SHA into a cached, read-only checkout. */
function ensureCheckout(repo) {
  const dir = join(cacheDir, `${repo.name}-${repo.sha.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["remote", "add", "origin", repo.url], dir);
  git(["fetch", "-q", "--depth", "1", "origin", repo.sha], dir);
  git(["checkout", "-q", "FETCH_HEAD"], dir);
  return dir;
}

/** The comparable finding set: kind, computed severity, dependency (or null). */
function findingSet(result) {
  return result.findings
    .map((f) => ({
      kind: f.kind,
      severity: severityOf(f),
      dependency: f.dependency ?? null,
    }))
    .sort((a, b) =>
      [a.kind, a.dependency ?? "", a.severity]
        .join("")
        .localeCompare([b.kind, b.dependency ?? "", b.severity].join("")),
    );
}

let failures = 0;
for (const repo of config.repos) {
  const dir = ensureCheckout(repo);
  let code = 0;
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [cliPath, "scan", "--json", dir], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
  } catch (error) {
    code = error.status ?? 2;
    stdout = error.stdout ?? "";
  }
  const goldenPath = join(root, "corpus/golden", `${repo.name}.json`);
  const actual = {
    repo: repo.name,
    sha: repo.sha,
    expectExit: code,
    findings: code === 0 ? findingSet(JSON.parse(stdout)) : [],
  };
  if (update) {
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`${repo.name}: golden updated (${actual.findings.length} findings, exit ${code})`);
    continue;
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  const want = JSON.stringify({ ...golden, repo: repo.name, sha: repo.sha });
  const got = JSON.stringify(actual);
  if (want === got) {
    console.log(`${repo.name}: OK (${actual.findings.length} findings, exit ${code})`);
    continue;
  }
  failures += 1;
  console.error(`${repo.name}: DRIFT at ${repo.sha}`);
  if (golden.expectExit !== actual.expectExit) {
    console.error(`  exit code: expected ${golden.expectExit}, got ${actual.expectExit}`);
  }
  const key = (f) => `${f.kind}|${f.severity}|${f.dependency}`;
  const before = new Map(golden.findings.map((f) => [key(f), f]));
  const after = new Map(actual.findings.map((f) => [key(f), f]));
  for (const [k, f] of before) {
    if (!after.has(k)) console.error(`  missing: ${f.kind} ${f.severity} ${f.dependency}`);
  }
  for (const [k, f] of after) {
    if (!before.has(k)) console.error(`  new:     ${f.kind} ${f.severity} ${f.dependency}`);
  }
  console.error("  If this drift is intended, regenerate: node scripts/corpus.mjs --update");
}
process.exit(failures === 0 ? 0 : 1);
