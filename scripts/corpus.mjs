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
 * Golden hygiene (#172 audit): a missing, malformed or stale golden fails
 * with an actionable message, never a stack trace; goldens and repos.json
 * must correspond one-to-one; a golden pinned at a different SHA fails as a
 * moved pin, not an opaque diff. --update is local-only (it refuses under
 * CI): goldens change only through corpus-touching PRs, never a silent
 * regen. An unparseable scan result at exit 0 fails the pin, it does not
 * crash the run.
 *
 * Usage:
 *   node scripts/corpus.mjs                     check mode: diff against goldens
 *   node scripts/corpus.mjs --only chalk,uuid   check a subset (after a fix)
 *   node scripts/corpus.mjs --update            regenerate goldens (local only; ride PR review)
 *
 * Requires a build first (`pnpm build`): the runner spawns the built CLI and
 * imports core's severity ladder from dist, so severity is computed exactly
 * the way the renderers compute it, never reimplemented here.
 *
 * Checkouts are shallow and read-only: nothing in a corpus repo is installed
 * or executed, matching the scanner's static-analysis contract (ADR 0004).
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".corpus-cache");
const config = JSON.parse(readFileSync(join(root, "corpus/repos.json"), "utf8"));
validateConfig(config);
// Correspondence, both directions (#172 audit): every golden names a repo in
// repos.json. A golden no repo claims is a pin nobody checks - fail loudly.
// (The other direction, a repo with no golden, is caught per-repo below.)
{
  const stray = readdirSync(join(root, "corpus/golden"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((name) => !config.repos.some((r) => r.name === name))
    .sort();
  if (stray.length > 0) {
    for (const name of stray) {
      console.error(
        `error: corpus/golden/${name}.json has no repos.json entry - remove the file or add the repo`,
      );
    }
    process.exit(2);
  }
}
const update = process.argv.includes("--update");
if (update && process.env.CI) {
  console.error(
    "error: --update is local-only: goldens change only through corpus-touching PRs (#172), never by a CI regen",
  );
  process.exit(2);
}
const onlyArg = process.argv.indexOf("--only");
const only =
  onlyArg === -1
    ? undefined
    : new Set(
        String(process.argv[onlyArg + 1] ?? "")
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean),
      );
if (only !== undefined && only.size === 0) {
  console.error('error: --only needs a comma-separated repo list, e.g. --only chalk,uuid');
  process.exit(2);
}
if (only !== undefined) {
  const unknown = [...only].filter((n) => !config.repos.some((r) => r.name === n));
  if (unknown.length > 0) {
    console.error(
      `error: --only names no corpus repo: ${unknown.join(", ")} (have: ${config.repos.map((r) => r.name).join(", ")})`,
    );
    process.exit(2);
  }
}

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

/**
 * Load and validate one golden (#172 audit). Every failure mode - missing
 * file, bad JSON, wrong shape, unknown keys, a pin that moved - comes back
 * as an actionable message instead of a crash or an opaque diff.
 */
function loadGolden(repo, goldenPath) {
  let raw;
  try {
    raw = readFileSync(goldenPath, "utf8");
  } catch {
    return {
      error:
        `golden corpus/golden/${repo.name}.json is missing - generate it locally with ` +
        `\`node scripts/corpus.mjs --update --only ${repo.name}\` and ride a corpus PR`,
    };
  }
  let golden;
  try {
    golden = JSON.parse(raw);
  } catch (error) {
    return {
      error: `golden corpus/golden/${repo.name}.json is not valid JSON: ${error.message}`,
    };
  }
  if (typeof golden !== "object" || golden === null || Array.isArray(golden)) {
    return { error: `golden corpus/golden/${repo.name}.json must be an object` };
  }
  const errors = [];
  const KEYS = new Set(["repo", "sha", "expectExit", "findings"]);
  for (const k of Object.keys(golden)) {
    if (!KEYS.has(k)) errors.push(`unknown key "${k}"`);
  }
  if (golden.repo !== repo.name) {
    errors.push(`"repo" is ${JSON.stringify(golden.repo)}, expected "${repo.name}"`);
  }
  if (golden.sha !== repo.sha) {
    errors.push(
      `"sha" is ${golden.sha}, expected ${repo.sha} - the pin moved; regenerate the golden in the same PR`,
    );
  }
  if (typeof golden.expectExit !== "number") errors.push('"expectExit" must be a number');
  if (!Array.isArray(golden.findings)) {
    errors.push('"findings" must be an array');
  } else {
    const bad = golden.findings.findIndex(
      (f) =>
        typeof f?.kind !== "string" ||
        typeof f?.severity !== "string" ||
        !(typeof f?.dependency === "string" || f?.dependency === null),
    );
    if (bad !== -1) {
      errors.push(`findings[${bad}] must be { kind: string, severity: string, dependency: string|null }`);
    }
  }
  return errors.length > 0
    ? { error: `golden corpus/golden/${repo.name}.json: ${errors.join("; ")}` }
    : { golden };
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
  if (only !== undefined && !only.has(repo.name)) continue;
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
  let result;
  if (code === 0) {
    try {
      result = JSON.parse(stdout);
    } catch {
      failures += 1;
      console.error(
        `${repo.name}: scan exited 0 but its --json output was not parseable - the CLI contract broke; investigate before touching any golden`,
      );
      row("BAD-JSON");
      continue;
    }
  }
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
  const loaded = loadGolden(repo, goldenPath);
  if (loaded.error !== undefined) {
    failures += 1;
    console.error(`${repo.name}: ${loaded.error}`);
    row("GOLDEN");
    continue;
  }
  const golden = loaded.golden;
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
  console.error(
    `  If this drift is intended, regenerate locally: node scripts/corpus.mjs --update --only ${repo.name} (goldens change only through corpus-touching PRs)`,
  );
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
