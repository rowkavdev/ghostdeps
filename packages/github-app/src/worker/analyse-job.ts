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
  fixtureRootsDigest,
  fixtureScope,
  FsRepositoryHandle,
  parseFixtureRootsText,
  resolveLimits,
  scanCompletenessFindings,
  type AnalysisResult,
  normaliseAnalysisResult,
  severityOf,
  type DependencyChange,
  type RecommendationPolicy,
  type PackageMetadataProvider,
  type ScanLimits,
  type ScanScope,
  type SourceLineChanges,
} from "@ghostdeps/core";
import { evaluateNativeProduction } from "@ghostdeps/javascript-typescript";
import type { AddedLines } from "@ghostdeps/checks-renderer";
import { CheckReporter, type ChecksClient, type CheckTarget } from "../checks/reporter.js";
import type { AnalysisJob, JobWorker } from "../jobs.js";
import { pullRequestContext, type PullRequestClient } from "../pull-request/changes.js";
import { isRateLimitError } from "../github/rate-limit.js";
import type { NpmMetadataService, RunMetadataProvider } from "./npm-metadata.js";
import type { RegistryMetadataService } from "./registry-metadata.js";
import { isCacheable, ResultCache, resultCacheKey } from "./result-cache.js";
import {
  deliverComment,
  defaultCommentAdapters,
  type CommenterOptions,
} from "../comments/commenter.js";
import type { IssuesClient } from "../comments/state.js";
import { downloadTarball, tarballUrl, TarballError, type TarballClient } from "./tarball.js";

/** Adapter modules run by default, as specifiers core's isolation tier can import. */
export const DEFAULT_ADAPTER_MODULES: readonly string[] = [
  new URL("./adapters/javascript-typescript.js", import.meta.url).href,
  new URL("./adapters/rust.js", import.meta.url).href,
  new URL("./adapters/go.js", import.meta.url).href,
  new URL("./adapters/python.js", import.meta.url).href,
];

/** Everything the worker needs from GitHub, scoped to one repository. */
export type RepositoryClient = ChecksClient & TarballClient & PullRequestClient;

/** Per-run engine options the worker derives from the job. */
export interface AnalyseRunOptions {
  /** Present only for PR jobs whose dependency changes were read in full. */
  readonly pullRequestChanges?: readonly DependencyChange[];
  /**
   * Honour a committed repo-root `.ghostdeps.json` (#354). Set by the worker
   * only for genuine full scans (jobs with no PR base: pushes, fork/unlinked
   * re-runs). Never derived from the absence of pullRequestChanges: a
   * PR-triggered run whose diff could not be read falls back to a
   * whole-repository analysis without pullRequestChanges, and scoping that
   * head-only fallback would hide changed fixture paths from the PR contract.
   */
  readonly fixtureScope?: boolean;
  /** Stamped onto the scope record: the analysed head commit (#354). */
  readonly analysedSha?: string;
  /**
   * Removed and added source lines, set together with pullRequestChanges
   * (#101). Core bounds them and adapters report removed usages, so a PR
   * that removes a dependency's last import gets removed-last-usage.
   */
  readonly pullRequestSourceChanges?: readonly SourceLineChanges[];
  /** Core's recommendation policy; omitted means facts only, no verdicts. */
  readonly recommend?: RecommendationPolicy;
  /** Registry metadata for install footprints (#174); omitted means none. */
  readonly metadata?: PackageMetadataProvider;
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
  /**
   * Same-SHA re-run result cache (#174): holds the posted check output.
   * Defaults to an in-process cache bounded by bytes (16 MiB) and per
   * repository (4 entries); false turns it off.
   */
  readonly resultCache?: ResultCache | false;
  /**
   * npm install-footprint metadata (#174). Off unless set; each job gets a
   * provider with its own fetch budget. Only public-registry packages are
   * ever queried (docs/security-model.md).
   */
  readonly metadata?: NpmMetadataService | RegistryMetadataService;
  /** Checkout scan limits/exclusions. Defaults to core's. */
  readonly scan?: CheckoutScanOptions;
  /**
   * PR-comment delivery (slice 3, gated): when set together with
   * commentClientFor, a completed PR analysis also maintains the single PR
   * comment from the same AnalysisResult. Delivery failures never affect
   * the check run. Off unless the app opts in (GHOSTDEPS_PR_COMMENT).
   */
  readonly comments?: CommenterOptions;
  /** Minted narrowed to issues:write for the job's repository (#326 pattern). */
  readonly commentClientFor?: (job: AnalysisJob) => Promise<IssuesClient>;
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
 * Fixture scope (#354) applies to full scans only, and only when the worker
 * says so. A PR analysis compares the head against its base, and the design
 * requires one effective scope on both sides with old/new config disclosure -
 * the PR diff slice, not this one. Scoping only the head checkout would
 * silently reinterpret the comparison, so PR-triggered runs stay unscoped
 * even when they fall back to a whole-repository analysis.
 */
export const fixtureScopeEnabled = (run: AnalyseRunOptions): boolean => run.fixtureScope === true;

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
  const handle = await FsRepositoryHandle.open(
    root,
    fixtureScopeEnabled(run)
      ? {
          ...scan,
          fixtureScope: true,
          ...(run.analysedSha !== undefined ? { analysedSha: run.analysedSha } : {}),
        }
      : scan,
  );
  const scanCompleteness = scanCompletenessFindings(handle.scan);
  const result = await engine(handle, {
    adapters: adapterModules,
    // Mirror the CLI (#426/#481): a committed config is disclosed; the empty
    // "none" record is not, so checks on unconfigured repos are unchanged.
    ...(handle.scan.scope && handle.scan.scope.source !== "none"
      ? { scanScope: handle.scan.scope }
      : {}),
    ...(run.pullRequestChanges ? { pullRequestChanges: run.pullRequestChanges } : {}),
    ...(run.pullRequestSourceChanges
      ? { pullRequestSourceChanges: run.pullRequestSourceChanges }
      : {}),
    ...(run.recommend ? { recommend: run.recommend } : {}),
    ...(run.metadata ? { metadata: run.metadata } : {}),
    ...(scanCompleteness.length > 0 ? { scanIncomplete: true, scanCompleteness } : {}),
  });
  // Injected test engines may return a partial result; production engines always
  // supply dependencies. An absent surface cannot be promoted to a verdict.
  if (!Array.isArray(result.dependencies) || !run.recommend) return result;
  const changed = run.pullRequestChanges;
  const scopedDependencies =
    changed === undefined
      ? result.dependencies
      : result.dependencies.filter((dependency) =>
          changed.some(
            (c) =>
              c.change !== "removed" &&
              c.name === dependency.name &&
              c.ecosystem === dependency.project.ecosystem &&
              c.manifest === dependency.declaredIn,
          ),
        );
  // A source-only PR has no changed dependency to evaluate. Do not import
  // unrelated repository-wide native gaps into the check conclusion.
  if (scopedDependencies.length === 0) return result;
  const native = await evaluateNativeProduction(handle, scopedDependencies);
  return normaliseAnalysisResult({
    ...result,
    findings: [
      ...result.findings,
      ...native.findings.map((finding) => ({ ...finding, severity: severityOf(finding) })),
    ],
    ...(native.evaluations.length ? { nativeEvaluations: native.evaluations } : {}),
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

/**
 * App-authored status note (#196, #354): the app couldn't read the PR's
 * changes in full, so it analysed the whole repository rather than scoping to
 * the PR. The scan is UNSCOPED - no fixture roots are applied, and the
 * base/head scope comparison is unavailable - because an unknown change set
 * is not an empty one.
 */
export const FULL_FALLBACK_NOTE =
  "Pull request changes couldn't be read in full, so GhostDeps analysed the whole repository UNSCOPED: no fixture roots were applied, no excluded changed paths are disclosed, and any fixture-scope configuration change in this pull request could not be compared. Findings may include dependencies this pull request didn't change. An unknown change set is not an empty one.";

const SCOPE_CONFIG = ".ghostdeps.json";

/**
 * Bounded disclosure of changed paths under excluded fixture roots (#354): the
 * count and up to 10 sorted examples, so a fixture-only pull request still
 * gets a visible check instead of looking like nothing happened.
 */
export function excludedChangesNote(
  excluded: {
    count: number;
    examples: readonly string[];
  },
  partial = false,
): string {
  const shown = excluded.examples.join(", ");
  const extra = excluded.count - excluded.examples.length;
  return (
    `This pull request changes ${partial ? "at least " : ""}${excluded.count} file(s) ` +
    `under excluded fixture roots ` +
    `(${shown}${extra > 0 ? `, +${extra} more` : ""}); they were not analysed.` +
    (partial
      ? " The diff was not read in full, so this count is a minimum, not the pull request's total."
      : "")
  );
}

/**
 * The base side's committed scope config (#354): `roots: null` means no config
 * file (404), a roots array means a committed config (possibly declaring an
 * empty root list - presence matters for the old/new comparison), and
 * `unknown` means it could not be read or parsed.
 */
async function baseScopeRoots(
  client: PullRequestClient,
  target: { owner: string; repo: string },
  baseSha: string,
  limits: ScanLimits,
): Promise<{ roots: string[] | null } | { unknown: true }> {
  let text: unknown;
  try {
    ({ data: text } = await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: target.owner,
      repo: target.repo,
      path: SCOPE_CONFIG,
      ref: baseSha,
      mediaType: { format: "raw" },
    }));
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    return status === 404 ? { roots: null } : { unknown: true };
  }
  if (typeof text !== "string") return { unknown: true };
  try {
    return { roots: parseFixtureRootsText(text, limits, SCOPE_CONFIG) };
  } catch {
    return { unknown: true };
  }
}

/**
 * Old/new scope comparison (#354): a config edit in the PR is disclosed with
 * both digests and the added/removed roots, and marks the diff interpretation
 * incomplete. Never claims the config is unchanged - silence means identical.
 */
function scopeComparisonNote(
  headScope: ScanScope,
  base: { roots: string[] | null } | { unknown: true },
): string | undefined {
  const headDigest = headScope.source === "none" ? null : headScope.configDigest;
  // An unreadable base config never implies "unchanged", even when the head
  // has no config either - the change state is simply unknown.
  if ("unknown" in base) {
    return "The base revision's fixture scope configuration could not be read, so whether this pull request changed it is unknown; the diff interpretation is incomplete.";
  }
  const baseRoots = base.roots ?? [];
  const baseDigest = base.roots === null ? null : fixtureRootsDigest(base.roots);
  if (baseDigest === headDigest) return undefined;
  const headRoots = headScope.roots.map((r) => r.root);
  const added = headRoots.filter((r) => !baseRoots.includes(r));
  const removed = baseRoots.filter((r) => !headRoots.includes(r));
  return (
    `Fixture scope configuration changed in this pull request ` +
    `(config digest ${baseDigest ?? "none"} -> ${headDigest ?? "none"}; ` +
    `roots added: ${added.length > 0 ? added.join(", ") : "none"}; ` +
    `roots removed: ${removed.length > 0 ? removed.join(", ") : "none"}); ` +
    "the diff interpretation is incomplete."
  );
}

/** Source-only per the changed-file list, on the first run or a re-run (#101, #196). */
function sourceOnly(job: AnalysisJob): boolean {
  if (job.trigger.kind === "pull_request") return job.trigger.sourceOnly === true;
  if (job.trigger.kind === "rerequested") return job.trigger.pullRequest?.sourceOnly === true;
  return false;
}

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
  if (isRateLimitError(error)) {
    return "GitHub's API rate limit was reached. Wait a few minutes before re-running.";
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
  const cache =
    options.resultCache === false ? undefined : (options.resultCache ?? new ResultCache());
  const cacheContext = {
    adapterModules,
    recommend: options.recommend !== undefined,
    footprint: options.metadata !== undefined,
    ...(options.scan !== undefined ? { scan: options.scan } : {}),
  };

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

    const cacheKey = resultCacheKey(job, cacheContext);
    if (job.trigger.kind === "rerequested") {
      const hit = cache?.get(job.repository.id, cacheKey);
      if (hit) {
        try {
          await reporter.completeRendered(target, checkRunId, hit);
          options.log?.info({ job: job.key }, "re-run served from the same-SHA result cache");
          return;
        } catch (error) {
          options.log?.warn({ job: job.key, err: error }, "cached re-run could not be reported");
          await reporter.fail(target, checkRunId, failureReason(error));
          return;
        }
      }
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
      const footprint: RunMetadataProvider | undefined = options.metadata?.forRun();
      const run: {
        pullRequestChanges?: readonly DependencyChange[];
        pullRequestSourceChanges?: readonly SourceLineChanges[];
        fixtureScope?: boolean;
        analysedSha?: string;
        recommend?: RecommendationPolicy;
        metadata?: PackageMetadataProvider;
      } = {
        ...(options.recommend ? { recommend: options.recommend } : {}),
        ...(footprint ? { metadata: footprint } : {}),
      };
      // baseSha is from the payload at enqueue time. If the base branch has
      // moved since, base...head still diffs from the merge base, so the
      // change list is still the PR's own.
      const baseSha = pullRequestBase(job);
      const root = await checkoutRoot(destDir);
      run.analysedSha = job.headSha;
      if (baseSha === undefined) {
        // Full scans (pushes, fork/unlinked re-runs) honour the committed
        // .ghostdeps.json at the analysed ref (#354).
        run.fixtureScope = true;
      } else {
        // PR-linked runs use the head's effective fixture scope for BOTH
        // snapshots (#354): the change extraction is filtered to it below and
        // the head checkout is scanned with it, so excluded fixture paths
        // never drive verdicts on either side. The head config is read up
        // front; a malformed one fails the run, as on full scans.
        const limits = resolveLimits(options.scan?.limits);
        const headScope = await fixtureScope(root, limits);
        run.fixtureScope = true;
        const pr = await pullRequestContext(
          client,
          {
            owner: target.owner,
            repo: target.repo,
            baseSha,
            headSha: job.headSha,
          },
          headScope.roots.map((r) => r.root),
        );
        added = pr.added;
        if (pr.complete) {
          if (pr.excludedChanged.count > 0) {
            appNotes.push(excludedChangesNote(pr.excludedChanged));
          }
          const scopeNote = scopeComparisonNote(
            headScope,
            await baseScopeRoots(client, target, baseSha, limits),
          );
          if (scopeNote !== undefined) appNotes.push(scopeNote);
          run.pullRequestChanges = pr.dependencyChanges.changes;
          run.pullRequestSourceChanges = pr.dependencyChanges.sourceLineChanges;
        } else if (sourceOnly(job)) {
          // A source-only PR changed no dependencies, so a full analysis would
          // post repository-wide verdicts it didn't cause. Stay PR-scoped and
          // quiet; without the full diff there is no removed-last-usage (#101).
          // The excluded-path disclosure and scope comparison still apply: a
          // fixture-only source PR must get a visible check (#354 review).
          run.pullRequestChanges = [];
          appNotes.push(SKIPPED_REMOVED_USAGE_NOTE);
          if (pr.excludedChanged.count > 0) {
            // The diff was capped or cut, so the parsed count can undercount:
            // disclose it as a minimum (#354 review).
            appNotes.push(excludedChangesNote(pr.excludedChanged, true));
          }
          const scopeNote = scopeComparisonNote(
            headScope,
            await baseScopeRoots(client, target, baseSha, limits),
          );
          if (scopeNote !== undefined) appNotes.push(scopeNote);
          options.log?.warn(
            { job: job.key, limitations: pr.dependencyChanges.limitations },
            "PR diff incomplete on a source-only PR; staying PR-scoped",
          );
        } else {
          // Unknown is not an empty change set (#354): fall back to an
          // UNSCOPED full head scan with the note, and claim no excluded-path
          // counts, no config comparison and no removed-last-usage.
          run.fixtureScope = false;
          appNotes.push(FULL_FALLBACK_NOTE);
          options.log?.warn(
            { job: job.key, limitations: pr.dependencyChanges.limitations },
            "PR dependency changes incomplete; analysing the full repository unscoped",
          );
        }
      }
      const result = await analyse(root, adapterModules, run);
      const posted = await reporter.complete(target, checkRunId, result, added, appNotes);
      // Slice 3 (gated): maintain the one PR comment from the SAME result.
      // The comment is additive - any failure leaves the completed check as
      // the delivered output (decline-preserves-scans, ADR 0006 #3).
      if (options.comments && options.commentClientFor && job.trigger.kind === "pull_request") {
        try {
          const issues = await options.commentClientFor(job);
          const outcome = await deliverComment(
            issues,
            options.comments,
            {
              owner: target.owner,
              repo: target.repo,
              repositoryId: job.repository.id,
              pullNumber: job.trigger.number,
              headSha: job.headSha,
            },
            await checkoutRoot(destDir),
            defaultCommentAdapters(),
            result,
          );
          options.log?.info({ job: job.key, comment: outcome.action }, "PR comment maintained");
        } catch (error) {
          options.log?.warn(
            { job: job.key, err: error },
            "PR comment delivery unavailable; check result stands",
          );
        }
      }
      // A footprint cut short (budget, deadline, registry error) is fine to
      // post but never cached: a cached truncation would under-report on
      // every re-run of this head (#313 review, ADR 0004).
      if (cache && isCacheable(result, appNotes) && (footprint?.complete ?? true)) {
        cache.set(job.repository.id, cacheKey, posted);
      }
      options.log?.info({ job: job.key, findings: result.findings.length }, "analysis complete");
    } catch (error) {
      options.log?.warn({ job: job.key, err: error }, "analysis failed");
      await reporter.fail(target, checkRunId, failureReason(error));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };
}
