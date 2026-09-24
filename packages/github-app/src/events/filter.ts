/**
 * Event filtering (#36): decides which webhook deliveries are worth an
 * analysis job. Pure functions over payloads plus an injected changed-files
 * lookup, so the rules are testable without Probot or the network.
 *
 * Default-deny: anything not in `analysedEvents` short-circuits quietly.
 * Duplicate deliveries are collapsed later by the job queue (one job per
 * repository id + head SHA), so this module does not track delivery GUIDs.
 */
import { analysisJobKey, type AnalysisJob, type AnalysisTrigger } from "../jobs.js";
import { dependencyFilesIn, sourceFilesIn } from "./manifests.js";

/** Event/action pairs that can lead to analysis. `push` has no action. */
export const analysedEvents = {
  pull_request: ["opened", "synchronize", "reopened"],
  push: [],
} as const satisfies Record<string, readonly string[]>;

type AnalysedPrAction = (typeof analysedEvents.pull_request)[number];

/** GitHub includes at most 20 commits in a push payload; at the cap the file list may be incomplete. */
export const PUSH_PAYLOAD_COMMIT_CAP = 20;

/** An analysis target before its changed files are known. */
export type Candidate = Omit<AnalysisJob, "deliveryId"> & {
  /** Changed paths from the payload, when it carries a complete list (pushes only). */
  readonly payloadFiles?: readonly string[];
};

export type PreFilterResult = { readonly candidate: Candidate } | { readonly skip: string };

export type Decision =
  | {
      readonly analyse: true;
      readonly job: AnalysisJob;
      readonly dependencyFiles: readonly string[];
      /** Analysable source files among the changes (PRs only; #101). */
      readonly sourceFiles: readonly string[];
    }
  | { readonly analyse: false; readonly reason: string };

/**
 * Changed files for a candidate (PR files or compare API). `complete: false`
 * means the API capped the list, so a missing manifest proves nothing.
 */
export interface ChangedFiles {
  readonly files: readonly string[];
  readonly complete: boolean;
}

export type ChangedFilesLookup = (candidate: Candidate) => Promise<ChangedFiles>;

// Only the payload fields we read. Everything is optional: payloads are untrusted input.
interface RepositoryPayload {
  id?: number;
  name?: string;
  owner?: { login?: string };
  default_branch?: string;
}
interface Payload {
  action?: string;
  number?: number;
  installation?: { id?: number };
  repository?: RepositoryPayload;
  pull_request?: { number?: number; head?: { sha?: string }; base?: { sha?: string } };
  ref?: string;
  before?: string;
  after?: string;
  deleted?: boolean;
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
}

const ZERO_SHA = /^0+$/;

function isAnalysedPrAction(action: string | undefined): action is AnalysedPrAction {
  return (analysedEvents.pull_request as readonly string[]).includes(action ?? "");
}

function base(p: Payload): Omit<Candidate, "headSha" | "trigger" | "key"> | string {
  const r = p.repository;
  if (r?.id === undefined || !r.name || !r.owner?.login) return "payload missing repository";
  if (p.installation?.id === undefined) return "payload missing installation";
  return {
    installationId: p.installation.id,
    repository: { id: r.id, owner: r.owner.login, name: r.name },
  };
}

/**
 * Stage 1: cheap, synchronous checks on event name, action and payload.
 * No network. Returns a candidate or the reason to skip.
 */
export function preFilter(eventName: string, payload: unknown): PreFilterResult {
  const p = (payload ?? {}) as Payload;

  if (eventName === "pull_request") {
    if (!isAnalysedPrAction(p.action))
      return { skip: `pull_request.${p.action ?? "?"} is not analysed` };
    const b = base(p);
    if (typeof b === "string") return { skip: b };
    const headSha = p.pull_request?.head?.sha;
    const baseSha = p.pull_request?.base?.sha;
    const number = p.pull_request?.number ?? p.number;
    if (!headSha || !baseSha || number === undefined) {
      return { skip: "pull_request payload missing number or SHAs" };
    }
    const trigger: AnalysisTrigger = { kind: "pull_request", number, action: p.action, baseSha };
    return { candidate: { ...b, key: analysisJobKey(b.repository.id, headSha), headSha, trigger } };
  }

  if (eventName === "push") {
    const b = base(p);
    if (typeof b === "string") return { skip: b };
    if (!p.ref || !p.after) return { skip: "push payload missing ref or after" };
    if (p.deleted === true || ZERO_SHA.test(p.after)) return { skip: "branch deletion" };
    if (!p.ref.startsWith("refs/heads/")) return { skip: "tag or non-branch push" };
    const branch = p.ref.slice("refs/heads/".length);
    if (!p.repository?.default_branch || branch !== p.repository.default_branch) {
      return { skip: "push to a non-default branch" };
    }
    if (!p.before || ZERO_SHA.test(p.before)) return { skip: "new branch push has no diff" };
    const commits = p.commits ?? [];
    const complete = commits.length > 0 && commits.length < PUSH_PAYLOAD_COMMIT_CAP;
    const files = new Set<string>();
    for (const c of commits) {
      for (const f of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])])
        files.add(f);
    }
    const trigger: AnalysisTrigger = { kind: "push", ref: p.ref, beforeSha: p.before };
    const candidate: Candidate = {
      ...b,
      key: analysisJobKey(b.repository.id, p.after),
      headSha: p.after,
      trigger,
      ...(complete ? { payloadFiles: [...files] } : {}),
    };
    return { candidate };
  }

  return { skip: `event ${eventName} is not analysed` };
}

/**
 * Stage 2: decide from the changed files. Uses the payload's list when it is
 * complete, otherwise the injected lookup. Quiet short-circuit when no
 * dependency manifest or lockfile changed and, for PRs with the source
 * trigger on, no analysable source file changed either (#101).
 *
 * When the file list is incomplete or the lookup fails, it analyses anyway:
 * a skipped relevant change is worse than one extra job for an irrelevant one.
 */
export interface DecideOptions {
  /**
   * Also analyse PRs that change only analysable source (#101), so a
   * removed last import is reported. The app passes this explicitly (on
   * unless GHOSTDEPS_SOURCE_PR_TRIGGER turns it off); omitted means off.
   */
  readonly sourcePrTrigger?: boolean;
}

export async function decide(
  eventName: string,
  payload: unknown,
  deliveryId: string,
  lookup: ChangedFilesLookup,
  options: DecideOptions = {},
): Promise<Decision> {
  const pre = preFilter(eventName, payload);
  if ("skip" in pre) return { analyse: false, reason: pre.skip };
  const { payloadFiles, ...rest } = pre.candidate;
  const job: AnalysisJob = { ...rest, deliveryId };
  let changed: ChangedFiles;
  if (payloadFiles) {
    changed = { files: payloadFiles, complete: true };
  } else {
    try {
      changed = await lookup(pre.candidate);
    } catch {
      return { analyse: true, job, dependencyFiles: [], sourceFiles: [] };
    }
  }
  const dependencyFiles = dependencyFilesIn(changed.files);
  // Source-only PRs are analysed too (#101): removing the last import of a
  // dependency is what makes it unused. Pushes stay manifest-only.
  const sourceFiles =
    eventName === "pull_request" && options.sourcePrTrigger === true
      ? sourceFilesIn(changed.files)
      : [];
  if (dependencyFiles.length === 0 && sourceFiles.length === 0 && changed.complete) {
    return {
      analyse: false,
      reason:
        eventName === "pull_request" && options.sourcePrTrigger === true
          ? "no dependency manifest, lockfile or analysable source changed"
          : "no dependency manifest or lockfile changed",
    };
  }
  const sourceOnly =
    job.trigger.kind === "pull_request" &&
    changed.complete &&
    dependencyFiles.length === 0 &&
    sourceFiles.length > 0;
  return {
    analyse: true,
    job: sourceOnly ? { ...job, trigger: { ...job.trigger, sourceOnly: true } } : job,
    dependencyFiles,
    sourceFiles,
  };
}
