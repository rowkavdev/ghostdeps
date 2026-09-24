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
 * Invariants (repos.json `mustNotBeUnused` / `mustBeUnused`): hand-checked
 * names that must never / must always get an `unused` finding at the pin.
 * They are checked in both modes, and --update refuses to write a golden
 * that breaks one, so a golden refresh can't launder a false "unused".
 * Every invariant name must be a dependency the scan declared at the pin
 * (a misspelled name fails instead of holding forever), and repos.json is
 * validated in full, unknown keys included, before the first checkout.
 * Results also go to $GITHUB_STEP_SUMMARY as a table when it is set.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".corpus-cache");
const config = JSON.parse(readFileSync(join(root, "corpus/repos.json"), "utf8"));
validateConfig(config);
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
      // The engine stamps severity (#188); derive only for an unstamped finding.
      severity: f.severity ?? severityOf(f),
      dependency: f.dependency ?? null,
    }))
    .sort((a, b) =>
      [a.kind, a.dependency ?? "", a.severity]
        .join("")
        .localeCompare([b.kind, b.dependency ?? "", b.severity].join("")),
    );
}

/**
 * Validate all of repos.json before the first checkout, so a bad entry can't
 * leave some goldens rewritten under --update. Unknown keys are errors (a
 * misspelled "mustBeUnsued" must not silently check nothing). Every problem
 * is listed, then the run exits 2.
 */
function validateConfig(cfg) {
  const errors = [];
  const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(cfg)) errors.push("root must be an object");
  const TOP = new Set(["$comment", "$invariants", "repos"]);
  const REPO = new Set(["name", "url", "sha", "covers", "mustNotBeUnused", "mustBeUnused"]);
  for (const k of isObj(cfg) ? Object.keys(cfg) : []) {
    if (!TOP.has(k)) errors.push(`unknown top-level key "${k}"`);
  }
  const repos = isObj(cfg) ? cfg.repos : undefined;
  if (!Array.isArray(repos) || repos.length === 0) errors.push('"repos" must be a non-empty array');
  const seen = new Set();
  for (const [i, repo] of (Array.isArray(repos) ? repos : []).entries()) {
    const at = isObj(repo) && typeof repo.name === "string" ? repo.name : `repos[${i}]`;
    if (!isObj(repo)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    for (const k of Object.keys(repo)) {
      if (!REPO.has(k)) errors.push(`${at}: unknown key "${k}"`);
    }
    if (typeof repo.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(repo.name)) {
      errors.push(`${at}: "name" must be a lowercase file-safe string`);
    } else if (seen.has(repo.name)) {
      errors.push(`${at}: duplicate repo name`);
    } else {
      seen.add(repo.name);
    }
    if (typeof repo.url !== "string" || !/^https:\/\/\S+$/.test(repo.url)) {
      errors.push(`${at}: "url" must be an https URL`);
    }
    if (typeof repo.sha !== "string" || !/^[0-9a-f]{40}$/.test(repo.sha)) {
      errors.push(`${at}: "sha" must be a full 40-character commit SHA`);
    }
    if (repo.covers !== undefined && typeof repo.covers !== "string") {
      errors.push(`${at}: "covers" must be a string`);
    }
    const lists = {};
    for (const field of ["mustNotBeUnused", "mustBeUnused"]) {
      const value = repo[field];
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every((n) => typeof n === "string" && n.length > 0)) {
        errors.push(`${at}.${field} must be an array of package names`);
        continue;
      }
      const dupes = value.filter((n, j) => value.indexOf(n) !== j);
      if (dupes.length > 0) errors.push(`${at}.${field} lists ${dupes.join(", ")} more than once`);
      lists[field] = new Set(value);
    }
    for (const n of lists.mustNotBeUnused ?? []) {
      if (lists.mustBeUnused?.has(n)) errors.push(`${at}: ${n} is in both invariant lists`);
    }
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: corpus/repos.json ${e}`);
    process.exit(2);
  }
}

/** A validated repos.json name list (absent means empty). */
const nameList = (repo, field) => repo[field] ?? [];

/**
 * Invariant violations for one run (empty when all hold). A name must be a
 * direct dependency the scan actually declared at the pin: a misspelled or
 * stale name would otherwise "hold" forever while checking nothing.
 */
function invariantViolations(repo, findings, declared) {
  const unused = new Set(findings.filter((f) => f.kind === "unused").map((f) => f.dependency));
  const out = [];
  for (const name of [...nameList(repo, "mustNotBeUnused"), ...nameList(repo, "mustBeUnused")]) {
    if (!declared.has(name)) {
      out.push(`${name} is not a declared dependency at this pin (misspelled or stale invariant)`);
    }
  }
  for (const name of nameList(repo, "mustNotBeUnused")) {
    if (unused.has(name)) out.push(`${name} is reported unused but is hand-checked as used`);
  }
  for (const name of nameList(repo, "mustBeUnused")) {
    if (!unused.has(name))
      out.push(`${name} is no longer reported unused (hand-verified true positive)`);
  }
  return out;
}

const summary = [];
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

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
  const result = code === 0 ? JSON.parse(stdout) : undefined;
  const actual = {
    repo: repo.name,
    sha: repo.sha,
    expectExit: code,
    findings: result ? findingSet(result) : [],
  };
  const declared = new Set(
    (Array.isArray(result?.dependencies) ? result.dependencies : [])
      .map((d) => d?.name)
      .filter((n) => typeof n === "string"),
  );
  const violations = invariantViolations(repo, actual.findings, declared);
  const row = (status) =>
    summary.push({
      repo: repo.name,
      sha: repo.sha.slice(0, 12),
      status,
      findings: actual.findings.length,
      unused: actual.findings.filter((f) => f.kind === "unused").length,
      exit: code,
      invariants:
        nameList(repo, "mustNotBeUnused").length + nameList(repo, "mustBeUnused").length === 0
          ? "-"
          : violations.length === 0
            ? "hold"
            : violations.join("; "),
    });
  for (const v of violations) console.error(`${repo.name}: INVARIANT at ${repo.sha}: ${v}`);
  if (update) {
    if (violations.length > 0) {
      failures += 1;
      console.error(
        `${repo.name}: golden NOT updated - fix the regression, or change repos.json with cited static evidence`,
      );
      row("REFUSED");
      continue;
    }
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`${repo.name}: golden updated (${actual.findings.length} findings, exit ${code})`);
    row("updated");
    continue;
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  const want = JSON.stringify({ ...golden, repo: repo.name, sha: repo.sha });
  const got = JSON.stringify(actual);
  if (want === got && violations.length === 0) {
    console.log(`${repo.name}: OK (${actual.findings.length} findings, exit ${code})`);
    row("OK");
    continue;
  }
  failures += 1;
  row(want === got ? "INVARIANT" : "DRIFT");
  if (want === got) continue;
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
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `### Pinned corpus (${update ? "update" : "check"}): ${failures === 0 ? "green" : `${failures} failing`}`,
    "",
    "| Repo | Pin | Status | Findings | Unused | Exit | Invariants |",
    "|---|---|---|---|---|---|---|",
    ...summary.map(
      (r) =>
        `| ${cell(r.repo)} | \`${r.sha}\` | ${r.status} | ${r.findings} | ${r.unused} | ${r.exit} | ${cell(r.invariants)} |`,
    ),
    "",
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
process.exit(failures === 0 ? 0 : 1);
