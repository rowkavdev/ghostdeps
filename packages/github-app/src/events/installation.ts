/** Installation setup: full scans for newly granted repositories only (#340). */
import { analysisJobKey, type AnalysisJob, type JobRepository } from "../jobs.js";

interface RepositoryPayload {
  id?: number;
  name?: string;
  full_name?: string;
}

interface InstallationPayload {
  action?: string;
  installation?: { id?: number };
  repositories?: RepositoryPayload[];
  repositories_added?: RepositoryPayload[];
}

/** Reject malformed or unrelated installation actions before any API lookup. */
export function installationCandidates(
  eventName: string,
  payload: unknown,
): { installationId: number; repository: JobRepository }[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as InstallationPayload;
  const repos =
    eventName === "installation" && p.action === "created"
      ? p.repositories
      : eventName === "installation_repositories" && p.action === "added"
        ? p.repositories_added
        : undefined;
  if (!Number.isSafeInteger(p.installation?.id) || !Array.isArray(repos)) return [];
  const seen = new Set<number>();
  const out: { installationId: number; repository: JobRepository }[] = [];
  for (const repo of repos) {
    if (!repo || !Number.isSafeInteger(repo.id) || !repo.name || typeof repo.full_name !== "string")
      continue;
    const [owner, name, extra] = repo.full_name.split("/");
    if (!owner || name !== repo.name || extra || seen.has(repo.id!)) continue;
    seen.add(repo.id!);
    out.push({
      installationId: p.installation!.id!,
      repository: { id: repo.id!, owner, name },
    });
  }
  return out;
}

/** The head is resolved from GitHub, never from the delivery's mutable branch hint. */
export function installationJob(
  candidate: ReturnType<typeof installationCandidates>[number],
  headSha: string,
  deliveryId: string,
): AnalysisJob {
  return {
    ...candidate,
    deliveryId,
    headSha,
    key: analysisJobKey(candidate.repository.id, headSha),
    trigger: { kind: "full_scan", reason: "installation" },
  };
}
