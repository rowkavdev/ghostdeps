/**
 * Action entry: read the CLI's AnalysisResult JSON, render it with the same
 * check-run mapping the GitHub App uses (checks/render.ts, see checks/SYNC.md),
 * and create ONE completed check run named `ghostdeps` with the workflow's
 * GITHUB_TOKEN. Advisory by design: conclusions are success/neutral, never
 * failure. Known losses versus the app (fork PRs, re-run semantics, no cache)
 * are documented in packages/action/README.md and docs/github-action.md.
 */
import { appendFile, readFile } from "node:fs/promises";
import {
  checkName,
  failedCheck,
  renderCheck,
  type CheckAnnotation,
  type CheckOutput,
} from "@ghostdeps/checks-renderer";
import { addedLinesFromFiles, type AddedLines } from "@ghostdeps/checks-renderer";
import type { AnalysisResult } from "@ghostdeps/core";

const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
const maxFilePages = 5; // mirrors the app's PR-files cap (#36)
const maxForkAnnotations = 10; // GitHub's per-step workflow-command cap

interface Env {
  token: string;
  owner: string;
  repo: string;
  sha: string;
  eventName: string;
  event: Record<string, unknown>;
}

export class ActionError extends Error {}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ActionError(`missing required environment variable ${name}`);
  return v;
}

async function readEnv(): Promise<Env> {
  const [owner, repo] = env("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) throw new ActionError("GITHUB_REPOSITORY is not owner/repo");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let event: Record<string, unknown> = {};
  if (eventPath) {
    try {
      event = JSON.parse(await readFile(eventPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new ActionError(`could not parse GITHUB_EVENT_PATH (${eventPath})`);
    }
  }
  return {
    token: env("GHOSTDEPS_GITHUB_TOKEN"),
    owner,
    repo,
    sha: env("GITHUB_SHA"),
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    event,
  };
}

interface PullRequestInfo {
  number: number;
  fork: boolean;
}

function pullRequestInfo(event: Record<string, unknown>): PullRequestInfo | undefined {
  const pr = event.pull_request as
    { number?: number; head?: { sha?: string; repo?: { fork?: boolean } | null } } | undefined;
  if (typeof pr?.number !== "number") return undefined;
  return { number: pr.number, fork: pr.head?.repo?.fork === true };
}

async function api<T>(e: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${e.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new ActionError(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/** Added lines across the PR's files, paginating like the app does (100/page, 5 pages max). */
async function pullRequestAddedLines(
  e: Env,
  pr: number,
): Promise<{ added: AddedLines; notes: string[] }> {
  const files: { filename: string; patch?: string }[] = [];
  for (let page = 1; page <= maxFilePages; page++) {
    const chunk = await api<{ filename: string; patch?: string }[]>(
      e,
      "GET",
      `/repos/${e.owner}/${e.repo}/pulls/${pr}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(chunk)) throw new ActionError("unexpected PR files response");
    files.push(...chunk);
    if (chunk.length < 100) break;
    if (page === maxFilePages) {
      return {
        added: addedLinesFromFiles(files),
        notes: [
          `PR file list truncated at ${maxFilePages * 100} files; annotations cover only those files.`,
        ],
      };
    }
  }
  return { added: addedLinesFromFiles(files), notes: [] };
}

/** renderCheck with a neutral fallback: malformed findings must never crash the poster. */
function safeRender(
  parsed: AnalysisResult,
  added: AddedLines,
  notes: readonly string[],
): CheckOutput {
  try {
    return renderCheck(parsed, added, notes);
  } catch {
    return failedCheck("ghostdeps output could not be rendered");
  }
}

function isAnalysisResult(json: unknown): json is AnalysisResult {
  if (typeof json !== "object" || json === null) return false;
  const findings = (json as { findings?: unknown }).findings;
  // Check membership, not just the array: [null] must not reach the renderer.
  return (
    Array.isArray(findings) &&
    findings.every(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { kind?: unknown }).kind === "string" &&
        typeof (f as { summary?: unknown }).summary === "string" &&
        Array.isArray((f as { evidence?: unknown }).evidence) &&
        Array.isArray((f as { limitations?: unknown }).limitations),
    )
  );
}

function isCliError(json: unknown): json is { error: { code: string; message: string } } {
  return (
    typeof json === "object" &&
    json !== null &&
    "error" in json &&
    typeof (json as { error?: { message?: unknown } }).error?.message === "string"
  );
}

async function writeStepSummary(markdown: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) await appendFile(path, `${markdown}\n`);
}

async function setOutput(name: string, value: string): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (path) await appendFile(path, `${name}=${value}\n`);
}

/** Fork-PR fallback: workflow-command notices, which need no token and show on the diff. */
function emitWorkflowCommands(annotations: readonly CheckAnnotation[]): number {
  let n = 0;
  for (const a of annotations) {
    if (n >= maxForkAnnotations) break;
    const title = a.title.replaceAll("\n", " ");
    const message = a.message.replaceAll("\r", "").replaceAll("\n", "%0A");
    console.log(`::notice file=${a.path},line=${a.start_line},title=${title}::${message}`);
    n++;
  }
  return n;
}

async function createCheckRun(e: Env, headSha: string, rendered: CheckOutput): Promise<void> {
  await api(e, "POST", `/repos/${e.owner}/${e.repo}/check-runs`, {
    name: process.env.GHOSTDEPS_CHECK_NAME ?? checkName,
    head_sha: headSha,
    status: "completed",
    completed_at: new Date().toISOString(),
    conclusion: rendered.conclusion,
    output: rendered.output,
  });
}

export async function main(resultPath: string): Promise<number> {
  const e = await readEnv();
  const pr = pullRequestInfo(e.event);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    parsed = { error: { code: "error", message: "ghostdeps produced no readable JSON output" } };
  }

  let rendered: CheckOutput;
  if (isCliError(parsed)) {
    rendered = failedCheck(parsed.error.message);
  } else if (!isAnalysisResult(parsed)) {
    rendered = failedCheck("ghostdeps output was not an AnalysisResult");
  } else if (pr) {
    // Added lines are read-only, so fork PRs get them too; only check-run
    // creation needs write access. If the read fails on a fork, degrade to
    // no annotations rather than failing.
    try {
      const r = await pullRequestAddedLines(e, pr.number);
      rendered = safeRender(parsed, r.added, r.notes);
    } catch (err) {
      if (!pr.fork) throw err;
      rendered = safeRender(parsed, new Map(), [
        "Could not read the PR file list, so no annotations were posted.",
      ]);
    }
  } else {
    rendered = safeRender(parsed, new Map(), []);
  }

  await setOutput("conclusion", rendered.conclusion);
  await writeStepSummary(`## ${rendered.output.title}\n\n${rendered.output.summary}`);

  if (pr?.fork) {
    // Read-only GITHUB_TOKEN cannot create check runs on fork PRs. Degrade to
    // workflow-command annotations (no token needed, shown on the diff).
    const emitted = emitWorkflowCommands(rendered.output.annotations);
    console.log(
      `ghostdeps: fork PR - check run skipped (read-only GITHUB_TOKEN); ` +
        `${emitted} of ${rendered.output.annotations.length} annotations posted as workflow notices. ` +
        `Install the GhostDeps GitHub App for full fork-PR support.`,
    );
    return 0;
  }

  await createCheckRun(e, e.sha, rendered);
  console.log(`ghostdeps: check run completed (${rendered.conclusion}).`);
  return 0;
}

// Run only as the action entry, not under tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const resultPath = process.argv[2];
  if (!resultPath) {
    console.error("usage: post-check.js <analysis-result.json>");
    process.exit(2);
  }
  main(resultPath).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
