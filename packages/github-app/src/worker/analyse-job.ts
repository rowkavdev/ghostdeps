/**
 * The analysis worker (#127, ADR 0003): turns an AnalysisJob into a check run.
 *
 *   job -> repo-scoped installation client -> codeload tarball
 *       -> core extractTarball (inert, hostile-input validated)
 *       -> PR jobs: dependency changes from the base...head diff (#115)
 *       -> core analyseRepositoryIsolated (adapters in worker threads, #112)
 *       -> CheckReporter
 *
 * Repository code is never executed: the tarball is only extracted through
 * core, and adapters parse files statically inside isolated workers.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyseRepositoryIsolated,
  extractTarball,
  ExtractionError,
  FsRepositoryHandle,
  scanCompletenessFindings,
  type AnalysisResult,
  type DependencyChange,
  type RecommendationPolicy,
  type SourceLineChanges,
} from "@ghostdeps/core";
import type { AddedLines } from "../checks/diff.js";
import { CheckReporter, type ChecksClient, type CheckTarget } from "../checks/reporter.js";
import type { AnalysisJob, JobWorker } from "../jobs.js";
import { pullRequestContext, type PullRequestClient } from "../pull-request/changes.js";
import { downloadTarball, tarballUrl, TarballError, type TarballClient } from "./tarball.js";

/** Adapter modules run by default, as specifiers core's isolation tier can import. */
export const DEFAULT_ADAPTER_MODULES: readonly string[] = [
  new URL("./adapters/javascript-typescript.js", import.meta.url).href,
];

/** Everything the worker needs from GitHub, scoped to one repository. */
export type RepositoryClient = ChecksClient & TarballClient & PullRequestClient;

/** Per-run engine options the worker derives from the job. */
export interface AnalyseRunOptions {
  /** Present only for PR jobs whose dependency changes were read in full. */
  readonly pullRequestChanges?: readonly DependencyChange[];
  /**
   * Removed and added source lines, set together with pullRequestChanges
   * (#101). Core bounds them and adapters report removed usages, so a PR
   * that removes a dependency's last import gets removed-last-usage.
   */
  readonly pullRequestSourceChanges?: readonly SourceLineChanges[];
  /** Core's recommendation policy; omitted means facts only, no verdicts. */
  readonly recommend?: RecommendationPolicy;
}

export interface AnalysisWorkerOptions {
  /** Our GitHub App id, so the reporter only ever counts our own runs. */
  readonly appId: number;
  /** A client whose token is scoped to this one repository (and our permission subset). */
  readonly clientFor: (job: AnalysisJob) => Promise<RepositoryClient>;
  readonly adapterModules?: readonly string[];
  /** Parent directory for per-job checkouts. Default: the OS temp dir. */
  readonly workRoot?: string;
  readonly maxTarballBytes?: number;
  /** Wall-clock budget for download + extraction. Default 5 minutes. */
  readonly downloadTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  /**
   * Core's recommendation policy for verdicts ("unused", "should-be-dev"...).
   * Omit for facts only. The app default is createDefaultPolicy(), the same
   * default the CLI scan uses; see GhostDepsAppOptions.recommendations.
   */
  readonly recommend?: RecommendationPolicy;
  /** Checkout scan limits/exclusions. Defaults to core's. */
  readonly scan?: CheckoutScanOptions;
  /** Swap the engine in tests. Defaults to core's isolated engine. */
  readonly analyse?: (
    root: string,
    adapterModules: readonly string[],
    run: AnalyseRunOptions,
  ) => Promise<AnalysisResult>;
  readonly log?: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
  };
}

/** Scan options for the checkout (limits, exclusions); core defaults otherwise. */
export type CheckoutScanOptions = NonNullable<Parameters<typeof FsRepositoryHandle.open>[1]>;

/**
 * Scan the checkout and run core's isolated engine. The scan-completeness
 * notes go to core as AnalyseOptions.scanCompleteness (and scanIncomplete):
 * core appends the notes and caps absence findings, so the app never calls
 * a dependency "unused" on a partial checkout and never post-processes the
 * result itself (ADR 0004, #136, #161).
 */
export async function analyseCheckout(
  root: string,
  adapterModules: readonly string[],
  run: AnalyseRunOptions,
  scan: CheckoutScanOptions = {},
  engine: typeof analyseRepositoryIsolated = analyseRepositoryIsolated,
): Promise<AnalysisResult> {
  const handle = await FsRepositoryHandle.open(root, scan);
  const scanCompleteness = scanCompletenessFindings(handle.scan);
  return engine(handle, {
    adapters: adapterModules,
    ...(run.pullRequestChanges ? { pullRequestChanges: run.pullRequestChanges } : {}),
    ...(run.pullRequestSourceChanges
      ? { pullRequestSourceChanges: run.pullRequestSourceChanges }
      : {}),
    ...(run.recommend ? { recommend: run.recommend } : {}),
    ...(scanCompleteness.length > 0 ? { scanIncomplete: true, scanCompleteness } : {}),
  });
}

/**
 * App-authored status note (#195): the app, not core, skipped removed-usage
 * analysis because it could not read the PR diff in full. Core's own notes
 * (e.g. pr-source-changes-capped) only arise when source changes were passed,
 * which this path never does, so the two never double up.
 */
export const SKIPPED_REMOVED_USAGE_NOTE =
  "Removed-usage check skipped: this pull request's diff was too large or unavailable to read in full, so GhostDeps did not check whether it removed the last use of a dependency.";

/** The PR base for jobs that have one; fork re-runs and pushes have none. */
function pullRequestBase(job: AnalysisJob): string | undefined {
  if (job.trigger.kind === "pull_request") return job.trigger.baseSha;
  if (job.trigger.kind === "rerequested") return job.trigger.pullRequest?.baseSha;
  return undefined;
}

/** Codeload tarballs wrap everything in one `owner-repo-sha/` directory. */
async function checkoutRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const only = entries.length === 1 ? entries[0] : undefined;
  return only?.isDirectory() ? join(dir, only.name) : dir;
}

/** A plain, repository-free explanation for the check summary. */
export function failureReason(error: unknown): string {
  if (error instanceof ExtractionError) {
    return `the repository archive was rejected by the safety checks (${error.code}).`;
  }
  if (error instanceof TarballError) {
    return error.code === "TOO_LARGE"
      ? "the repository archive is larger than GhostDeps will download."
      : "the repository archive could not be downloaded.";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "downloading the repository archive took too long.";
  }
  return "an internal error stopped the analysis.";
}

export function createAnalysisWorker(options: AnalysisWorkerOptions): JobWorker {
  const adapterModules = options.adapterModules ?? DEFAULT_ADAPTER_MODULES;
  const analyse =
    options.analyse ??
    ((root: string, modules: readonly string[], run: AnalyseRunOptions) =>
      analyseCheckout(root, modules, run, options.scan));
  const timeoutMs = options.downloadTimeoutMs ?? 5 * 60 * 1000;

  return async (job) => {
    const client = await options.clientFor(job);
    const reporter = new CheckReporter(client);
    const target: CheckTarget = {
      owner: job.repository.owner,
      repo: job.repository.name,
      headSha: job.headSha,
      externalId: job.key,
      appId: options.appId,
    };

    let checkRunId: number;
    if (job.trigger.kind === "rerequested") {
      checkRunId = await reporter.restart(target);
    } else {
      const claim = await reporter.start(target);
      if (!claim.created) {
        options.log?.info({ job: job.key }, "SHA already has a GhostDeps run; skipped");
        return;
      }
      checkRunId = claim.checkRunId;
    }

    const workDir = await mkdtemp(join(options.workRoot ?? tmpdir(), "ghostdeps-"));
    try {
      const url = await tarballUrl(client, {
        owner: target.owner,
        repo: target.repo,
        sha: job.headSha,
      });
      const destDir = join(workDir, "checkout");
      await extractTarball(
        downloadTarball(url, {
          signal: AbortSignal.timeout(timeoutMs),
          ...(options.maxTarballBytes !== undefined ? { maxBytes: options.maxTarballBytes } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
        { destDir },
      );
      let added: AddedLines = new Map();
      const appNotes: string[] = [];
      const run: {
        pullRequestChanges?: readonly DependencyChange[];
        pullRequestSourceChanges?: readonly SourceLineChanges[];
        recommend?: RecommendationPolicy;
      } = options.recommend ? { recommend: options.recommend } : {};
      // baseSha is from the payload at enqueue time. If the base branch has
      // moved since, base...head still diffs from the merge base, so the
      // change list is still the PR's own.
      const baseSha = pullRequestBase(job);
      if (baseSha !== undefined) {
        const pr = await pullRequestContext(client, {
          owner: target.owner,
          repo: target.repo,
          baseSha,
          headSha: job.headSha,
        });
        added = pr.added;
        if (pr.complete) {
          run.pullRequestChanges = pr.dependencyChanges.changes;
          run.pullRequestSourceChanges = pr.dependencyChanges.sourceLineChanges;
        } else if (job.trigger.kind === "pull_request" && job.trigger.sourceOnly === true) {
          // A source-only PR changed no dependencies, so a full analysis would
          // post repository-wide verdicts it didn't cause. Stay PR-scoped and
          // quiet; without the full diff there is no removed-last-usage (#101).
          run.pullRequestChanges = [];
          appNotes.push(SKIPPED_REMOVED_USAGE_NOTE);
          options.log?.warn(
            { job: job.key, limitations: pr.dependencyChanges.limitations },
            "PR diff incomplete on a source-only PR; staying PR-scoped",
          );
        } else {
          // Scoping to a partial change list could hide a finding: analyse in full.
          options.log?.warn(
            { job: job.key, limitations: pr.dependencyChanges.limitations },
            "PR dependency changes incomplete; analysing the full repository",
          );
        }
      }
      const result = await analyse(await checkoutRoot(destDir), adapterModules, run);
      await reporter.complete(target, checkRunId, result, added, appNotes);
      options.log?.info({ job: job.key, findings: result.findings.length }, "analysis complete");
    } catch (error) {
      options.log?.warn({ job: job.key, err: error }, "analysis failed");
      await reporter.fail(target, checkRunId, failureReason(error));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
