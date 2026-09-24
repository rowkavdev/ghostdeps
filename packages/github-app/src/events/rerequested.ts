/**
 * Re-run on demand (#97): a user clicks "Re-run" on the GhostDeps check in
 * the PR UI and GitHub sends check_run.rerequested to the app that created
 * the run. We re-enqueue analysis for that run's head SHA. The reporter's
 * one-run-per-SHA idempotency makes a repeat analysis safe.
 *
 * Pure function over the (untrusted) payload so it tests without Probot.
 */
import { analysisJobKey, type AnalysisJob } from "../jobs.js";

// Only the fields we read. Everything optional: payloads are untrusted input.
interface CheckRunPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; name?: string; owner?: { login?: string } };
  check_run?: {
    id?: number;
    name?: string;
    head_sha?: string;
    pull_requests?: { number?: number; base?: { sha?: string } }[];
  };
}

export type RerequestDecision =
  | { readonly analyse: true; readonly job: AnalysisJob }
  | { readonly analyse: false; readonly reason: string };

const SHA = /^[0-9a-f]{40}$/;

/**
 * The queue key includes the check run id and delivery GUID, so a re-run is
 * not collapsed onto the original (repository id, head SHA) job, while a
 * redelivery of the same click still collapses.
 */
export function rerequestKey(
  repositoryId: number,
  headSha: string,
  checkRunId: number,
  deliveryId: string,
): string {
  return `${analysisJobKey(repositoryId, headSha)}:rerun:${checkRunId}:${deliveryId}`;
}

export function decideRerequest(
  payload: unknown,
  deliveryId: string,
  checkName: string,
): RerequestDecision {
  const p = (payload ?? {}) as CheckRunPayload;
  if (p.action !== "rerequested") return { analyse: false, reason: `check_run.${p.action ?? "?"}` };
  const run = p.check_run;
  if (run?.name !== checkName) return { analyse: false, reason: "not the GhostDeps check run" };
  const repo = p.repository;
  if (repo?.id === undefined || !repo.name || !repo.owner?.login) {
    return { analyse: false, reason: "payload missing repository" };
  }
  const installationId = p.installation?.id;
  if (installationId === undefined)
    return { analyse: false, reason: "payload missing installation" };
  if (run.id === undefined || !run.head_sha || !SHA.test(run.head_sha)) {
    return { analyse: false, reason: "payload missing check run id or head SHA" };
  }
  // Fork PRs arrive with an empty pull_requests array; analyse the SHA without PR context then.
  const pr = run.pull_requests?.[0];
  const baseSha = pr?.base?.sha;
  return {
    analyse: true,
    job: {
      key: rerequestKey(repo.id, run.head_sha, run.id, deliveryId),
      deliveryId,
      installationId,
      repository: { id: repo.id, owner: repo.owner.login, name: repo.name },
      headSha: run.head_sha,
      trigger: {
        kind: "rerequested",
        checkRunId: run.id,
        ...(pr?.number !== undefined && baseSha && SHA.test(baseSha)
          ? { pullRequest: { number: pr.number, baseSha } }
          : {}),
      },
    },
  };
}
