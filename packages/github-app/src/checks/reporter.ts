/**
 * Check Run reporter (#32): exactly one GhostDeps check run per head SHA.
 * Re-deliveries and re-runs reuse the existing run instead of creating another.
 * Two writes per analysis: create in_progress, then complete.
 */
import type { AnalysisResult } from "@ghostdeps/core";
import type { AddedLines } from "./diff.js";
import { checkName, renderCheck, type CheckOutput } from "./render.js";

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
    }): Promise<{ data: { check_runs: { id: number; app?: { id?: number } | null }[] } }>;
    create(params: {
      owner: string;
      repo: string;
      name: string;
      head_sha: string;
      status: "in_progress";
      started_at: string;
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
  /** Idempotency key, stored as external_id (see jobKey in events/filter). */
  externalId: string;
  /** Our GitHub App id, so another app's run with the same name is never touched. */
  appId?: number;
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
    };
    if (target.appId !== undefined) params.app_id = target.appId;
    const { data } = await this.client.checks.listForRef(params);
    const run = data.check_runs.find(
      (r) => target.appId === undefined || r.app?.id === target.appId,
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
