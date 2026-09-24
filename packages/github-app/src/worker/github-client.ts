/**
 * Repo-scoped installation clients for the worker (#38): every job gets a
 * token limited to the one repository it analyses and to the permission
 * subset the worker uses. Workers never see the private key.
 */
import type { Probot } from "probot";
import { ProbotOctokit } from "probot";
import type { AnalysisJob } from "../jobs.js";
import type { RepositoryClient } from "./analyse-job.js";

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
    const octokit = new ProbotOctokit({ auth: { token }, log: app.log.child({ job: job.key }) });
    return {
      checks: octokit.rest.checks as unknown as RepositoryClient["checks"],
      request: octokit.request as unknown as RepositoryClient["request"],
    };
  };
}
