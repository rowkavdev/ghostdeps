/**
 * Repo-scoped installation clients for the worker (#38): every job gets a
 * token limited to the one repository it analyses and to the permission
 * subset the worker uses. Workers never see the private key.
 */
import type { Probot } from "probot";
import { ProbotOctokit } from "probot";
import { watchRateLimit } from "../github/rate-limit-log.js";
import { boundedThrottle } from "../github/rate-limit.js";
import type { AnalysisJob } from "../jobs.js";
import type { RepositoryClient } from "./analyse-job.js";
import type { IssuesClient } from "../comments/state.js";

/** What the worker does with a token: read the tarball, write the check run. */
export const WORKER_PERMISSIONS = { contents: "read", checks: "write" } as const;

export function repoScopedClients(app: Probot): (job: AnalysisJob) => Promise<RepositoryClient> {
  return async (job) => {
    const appOctokit = await app.auth();
    const { token } = (await appOctokit.auth({
      type: "installation",
      installationId: job.installationId,
      repositoryIds: [job.repository.id],
      permissions: WORKER_PERMISSIONS,
    })) as { token: string };
    const log = app.log.child({ job: job.key });
    // Bounded rate-limit retries (#255): Probot's class defaults retry forever.
    const octokit = new ProbotOctokit({ auth: { token }, log, throttle: boundedThrottle(log) });
    watchRateLimit(octokit, log);
    return {
      checks: octokit.rest.checks as unknown as RepositoryClient["checks"],
      request: octokit.request as unknown as RepositoryClient["request"],
    };
  };
}

/** Comment delivery is issues:write only - never the wider worker set (ADR 0006 #2). */
export const COMMENT_PERMISSIONS = { issues: "write" } as const;

/**
 * Repo-scoped issues:write client for the maintained PR comment. Minting
 * fails closed on installations that have not granted issues:write, which is
 * exactly the decline path: scanning keeps working, comments stay off.
 */
export function commentScopedClients(app: Probot): (job: AnalysisJob) => Promise<IssuesClient> {
  return async (job) => {
    const appOctokit = await app.auth();
    const { token } = (await appOctokit.auth({
      type: "installation",
      installationId: job.installationId,
      repositoryIds: [job.repository.id],
      permissions: COMMENT_PERMISSIONS,
    })) as { token: string };
    const log = app.log.child({ job: job.key });
    const octokit = new ProbotOctokit({ auth: { token }, log, throttle: boundedThrottle(log) });
    watchRateLimit(octokit, log);
    return { issues: octokit.rest.issues as unknown as IssuesClient["issues"] };
  };
}
