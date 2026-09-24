/**
 * Check Run reporter (#32): exactly one GhostDeps check run per head SHA.
 * Re-deliveries and re-runs reuse the existing run instead of creating another.
 * Two writes per analysis: create in_progress, then complete.
 */
import type { AnalysisResult } from "@ghostdeps/core";
import type { AddedLines } from "./diff.js";
import { busyCheck, checkName, renderCheck, type CheckOutput } from "./render.js";

/** external_id prefix for runs that only say the app was too busy. */
export const BUSY_PREFIX = "busy:";

/** The slice of Octokit the reporter needs; Probot's context.octokit satisfies it. */
export interface ChecksClient {
  checks: {
    listForRef(params: {
      owner: string;
      repo: string;
      ref: string;
      check_name: string;
      app_id?: number;
      filter?: "latest" | "all";
      per_page?: number;
    }): Promise<{
      data: {
        check_runs: { id: number; external_id?: string | null; app?: { id?: number } | null }[];
      };
    }>;
    create(params: {
      owner: string;
      repo: string;
      name: string;
      head_sha: string;
      status: "in_progress" | "completed";
      started_at?: string;
      completed_at?: string;
      conclusion?: CheckOutput["conclusion"];
      output?: CheckOutput["output"];
      external_id: string;
    }): Promise<{ data: { id: number } }>;
    update(params: {
      owner: string;
      repo: string;
      check_run_id: number;
      status: "completed";
      completed_at: string;
      conclusion: CheckOutput["conclusion"];
      output: CheckOutput["output"];
    }): Promise<{ data: { id: number } }>;
  };
}

export interface CheckTarget {
  owner: string;
  repo: string;
  headSha: string;
  /** Idempotency key (the job key), stored as external_id. */
  externalId: string;
  /**
   * Our GitHub App id. Required: without it, a same-named run from another
   * app or a workflow's GITHUB_TOKEN would count as ours and suppress analysis.
   */
  appId: number;
}

export class CheckReporter {
  /** Claims in flight in this process, so concurrent duplicates cannot both create a run. */
  readonly #pending = new Map<string, Promise<number>>();

  constructor(private readonly client: ChecksClient) {}

  /** Finds this app's GhostDeps run for the SHA, or undefined. */
  async find(target: CheckTarget): Promise<number | undefined> {
    const params: Parameters<ChecksClient["checks"]["listForRef"]>[0] = {
      owner: target.owner,
      repo: target.repo,
      ref: target.headSha,
      check_name: checkName,
      filter: "latest",
      per_page: 10,
      app_id: target.appId,
    };
    const { data } = await this.client.checks.listForRef(params);
    const run = data.check_runs.find(
      (r) => r.app?.id === target.appId && !(r.external_id ?? "").startsWith(BUSY_PREFIX),
    );
    return run?.id;
  }

  /**
   * Claims the SHA: creates the run in_progress unless this app already has a
   * GhostDeps run for it. `created: false` means a duplicate delivery or a
   * repeat event for an already-analysed SHA - the caller should stop, so the
   * SHA keeps exactly one run and its annotations are never appended twice.
   */
  async start(target: CheckTarget): Promise<{ checkRunId: number; created: boolean }> {
    const inFlight = this.#pending.get(target.externalId);
    if (inFlight) return { checkRunId: await inFlight, created: false };
    const claim = this.#claim(target);
    const id = claim.then((c) => c.checkRunId);
    id.catch(() => undefined); // failure surfaces through `claim` below
    this.#pending.set(target.externalId, id);
    try {
      return await claim;
    } finally {
      this.#pending.delete(target.externalId);
    }
  }

  async #claim(target: CheckTarget): Promise<{ checkRunId: number; created: boolean }> {
    const existing = await this.find(target);
    if (existing !== undefined) return { checkRunId: existing, created: false };
    const { data } = await this.client.checks.create({
      owner: target.owner,
      repo: target.repo,
      name: checkName,
      head_sha: target.headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      external_id: target.externalId,
    });
    return { checkRunId: data.id, created: true };
  }

  /**
   * Records that the job was dropped because the queue was full, so the
   * commit shows a neutral run instead of nothing. GitHub will not redeliver
   * the webhook, so the summary tells the user how to re-run. Busy runs are
   * ignored by `find`, so a later analysis of the same SHA still gets its own run.
   */
  async busy(target: CheckTarget): Promise<number> {
    const { conclusion, output } = busyCheck();
    const now = new Date().toISOString();
    const { data } = await this.client.checks.create({
      owner: target.owner,
      repo: target.repo,
      name: checkName,
      head_sha: target.headSha,
      status: "completed",
      started_at: now,
      completed_at: now,
      conclusion,
      output,
      external_id: `${BUSY_PREFIX}${target.externalId}`,
    });
    return data.id;
  }

  /** Completes the run with a success/neutral conclusion in one request. */
  async complete(
    target: CheckTarget,
    checkRunId: number,
    result: AnalysisResult,
    added: AddedLines,
  ): Promise<void> {
    const { conclusion, output } = renderCheck(result, added);
    await this.client.checks.update({
      owner: target.owner,
      repo: target.repo,
      check_run_id: checkRunId,
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion,
      output,
    });
  }
}
