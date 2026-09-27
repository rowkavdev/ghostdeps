#!/usr/bin/env node
/**
 * Corpus streak (#172): the machine-visible counter for the cap-lift clock.
 *
 * The #173/#178 caps lift after 14 consecutive green nightly corpus runs.
 * This script computes that streak statelessly from the Actions run history
 * of the corpus workflow and publishes it as an upserted comment on #172
 * (machine-readable fenced JSON + human summary) and the job summary.
 *
 * Rule (from the cap ruling): green +1, red resets, no-signal neither counts
 * nor resets, and a third consecutive no-signal day breaks the window with
 * older history - it stops the count without erasing a newer live streak.
 * A day is green when a scheduled run's corpus job concluded success that
 * UTC day, red when one concluded failure/cancelled, and no-signal when no
 * scheduled run exists for that day. Only fully elapsed days are evaluated
 * (yesterday and older): the night still in progress is not a miss yet.
 * Scheduled runs only - workflow_dispatch runs are not the nightly clock.
 *
 * The corpus job's conclusion is used, not the workflow run's, so a failure
 * of this streak job itself can never reset the streak it reports.
 *
 * Env: GITHUB_TOKEN (actions: read, issues: write), GITHUB_REPOSITORY,
 * optional CORPUS_WORKFLOW (default corpus.yml), STREAK_ISSUE (default 172).
 */
import { appendFileSync } from "node:fs";
import { CAP_LIFT_TARGET, computeStreak } from "./corpus-streak-lib.mjs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const workflow = process.env.CORPUS_WORKFLOW ?? "corpus.yml";
const issueNumber = Number(process.env.STREAK_ISSUE ?? "172");
const MAX_PAGES = 2; // 200 scheduled runs ~= 6+ months of nightlies
const MARKER = "<!-- corpus-streak -->";

if (!token || !repo) {
  console.error("error: GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  process.exit(2);
}

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function apiWrite(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Scheduled corpus runs, oldest pages fetched only while still needed. */
async function listScheduledRuns() {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await api(
      `/actions/workflows/${workflow}/runs?event=schedule&per_page=100&page=${page}`,
    );
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
  }
  return runs.filter((r) => r.status === "completed");
}

/**
 * The corpus job's conclusion for a run. A successful run implies a green
 * corpus job with no extra call; anything else is checked per-job so this
 * streak job's own failure is never read as a corpus red.
 */
async function corpusConclusion(run) {
  if (run.conclusion === "success") return "success";
  const data = await api(`/actions/runs/${run.id}/jobs?per_page=100`);
  const job = data.jobs.find((j) => j.name === "corpus");
  return job?.conclusion ?? "missing";
}

const day = (iso) => iso.slice(0, 10);

function utcDay(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const runs = await listScheduledRuns();
const byDay = new Map(); // utc date -> "green" | "red"
for (const run of runs) {
  const d = day(run.created_at);
  const conclusion = await corpusConclusion(run);
  const color = conclusion === "success" ? "green" : "red";
  if (byDay.get(d) !== "green") byDay.set(d, color);
}

// Build the newest-first sequence of fully elapsed days, then let the pure
// computeStreak apply the cap ruling (sequence semantics are unit-tested in
// scripts/corpus-streak.test.mjs).
const days = [];
let exhausted = false;
for (let offset = -1; offset > -370; offset -= 1) {
  const d = utcDay(offset);
  const color = byDay.get(d);
  if (color !== undefined) {
    days.push({ date: d, color });
    continue;
  }
  if (runs.length === 0 || d < day(runs.at(-1).created_at)) {
    exhausted = true; // beyond recorded history; older days are unknowable
    break;
  }
  days.push({ date: d, color: "miss" });
}

const state = {
  ...computeStreak(days, { exhaustedHistory: exhausted }),
  evaluatedThrough: utcDay(-1),
  rule: "green +1; red resets; no-signal skips; third consecutive miss breaks the window",
};

const json = JSON.stringify(state, null, 2);
console.log(json);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Corpus streak (#172)",
      "",
      `**${state.streak} / ${CAP_LIFT_TARGET} consecutive green nightlies**` +
        (state.capLiftReady ? " - cap lift ready" : ""),
      "",
      "```json",
      json,
      "```",
      "",
    ].join("\n"),
  );
}

// Publish: one upserted comment on the issue, marked so it is findable.
const body = [
  MARKER,
  `**Corpus streak: ${state.streak} / ${CAP_LIFT_TARGET} consecutive green nightlies**` +
    (state.capLiftReady ? " - **cap lift ready**" : ""),
  "",
  "Machine-readable state (updated every nightly):",
  "",
  "```json",
  json,
  "```",
].join("\n");
const comments = await api(`/issues/${issueNumber}/comments?per_page=100`);
const existing = comments.find((c) => c.body?.includes(MARKER));
if (existing) {
  await apiWrite("PATCH", `/issues/comments/${existing.id}`, { body });
  console.log(`updated streak comment ${existing.id}`);
} else {
  const created = await apiWrite("POST", `/issues/${issueNumber}/comments`, { body });
  console.log(`created streak comment ${created.id}`);
}
