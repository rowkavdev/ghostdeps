import { ProbotOctokit, type ApplicationFunction, type Probot } from "probot";
import { BusyLimiter } from "./checks/busy-limiter.js";
import { CheckReporter } from "./checks/reporter.js";
import { createDefaultPolicy } from "@ghostdeps/core";
import {
  appIdFromEnv,
  footprintFromEnv,
  recommendationsFromEnv,
  sourcePrTriggerFromEnv,
} from "./config.js";
import { changedFiles } from "./events/changed-files.js";
import { checkName } from "./checks/render.js";
import {
  analysedEvents,
  decide,
  withRerunSourceOnly,
  type ChangedFilesLookup,
} from "./events/filter.js";
import { decideRerequest } from "./events/rerequested.js";
import { InProcessJobQueue, type JobQueue, type JobWorker } from "./jobs.js";
import { createAnalysisWorker } from "./worker/analyse-job.js";
import { NpmMetadataService } from "./worker/npm-metadata.js";
import { noWaitThrottle, WEBHOOK_LOOKUP_DEADLINE_MS, withDeadline } from "./github/rate-limit.js";
import { repoScopedClients } from "./worker/github-client.js";

export const HEALTH_PATH = "/healthz";

export interface GhostDepsAppOptions {
  /** Job boundary. Defaults to an in-process queue running the analysis worker. */
  readonly queue?: JobQueue;
  /** Worker for the default queue. Defaults to the analysis worker (#127). */
  readonly worker?: JobWorker;
  /**
   * This GitHub App's id, used to recognise our own check runs. Defaults to
   * the APP_ID environment variable that `probot run` also reads. Without it,
   * no check runs are written.
   */
  readonly appId?: number;
  /**
   * Analyse PRs that change only source files (#101), so removing a
   * dependency's last import is reported. Defaults to on;
   * GHOSTDEPS_SOURCE_PR_TRIGGER=false (or 0) turns it off.
   */
  readonly sourcePrTrigger?: boolean;
  /**
   * Recommendation verdicts (core's default policy, as in the CLI scan).
   * Defaults to on; GHOSTDEPS_RECOMMENDATIONS=false (or 0) turns them off,
   * leaving facts only.
   */
  readonly recommendations?: boolean;
  /**
   * Install footprints from the public npm registry (#174). Off by default;
   * GHOSTDEPS_FOOTPRINT=true (or 1) turns them on. Only packages the
   * lockfile resolved from registry.npmjs.org are ever queried.
   */
  readonly footprint?: boolean;
  /** Limits "busy" check runs when the queue is full. Defaults to one per repository per minute. */
  readonly busyLimiter?: BusyLimiter;
}

type LookupOctokit = Parameters<typeof changedFiles>[0];

/**
 * An installation client for webhook lookups that never sleeps on a rate
 * limit and never retries (#255 follow-up). The token comes from Probot's
 * token cache, so this costs no extra token request.
 */
async function noWaitOctokit(
  app: Probot,
  installationId: number,
  log: { warn(obj: object, msg: string): void },
): Promise<LookupOctokit> {
  const appOctokit = await app.auth();
  const { token } = (await appOctokit.auth({ type: "installation", installationId })) as {
    token: string;
  };
  return new ProbotOctokit({
    auth: { token },
    throttle: noWaitThrottle(log),
    retry: { enabled: false },
  }) as unknown as LookupOctokit;
}

/** The changed-files lookup both first runs and re-runs use (#36, #196). */
function changedFilesLookup(
  app: Probot,
  context: {
    id: string;
    log: { warn(obj: object, msg: string): void };
  },
): ChangedFilesLookup {
  return async (candidate) => {
    try {
      // The webhook never waits on a rate limit (#255): its client fails a
      // rate-limited request at once, and past the deadline the lookup counts
      // as failed; either way the event takes the analyse-anyway path.
      const octokit = await noWaitOctokit(app, candidate.installationId, context.log);
      return await withDeadline(
        changedFiles(octokit, candidate),
        WEBHOOK_LOOKUP_DEADLINE_MS,
        "changed-files lookup",
      );
    } catch (error) {
      context.log.warn(
        { delivery: context.id, err: error },
        "changed-files lookup failed; analysing anyway",
      );
      throw error;
    }
  };
}

export function createGhostDepsApp(options: GhostDepsAppOptions = {}): ApplicationFunction {
  return (app: Probot, { addHandler }) => {
    const appId = options.appId ?? appIdFromEnv();
    const sourcePrTrigger = options.sourcePrTrigger ?? sourcePrTriggerFromEnv();
    const busyLimiter = options.busyLimiter ?? new BusyLimiter();
    const worker: JobWorker =
      options.worker ??
      (appId === undefined
        ? async (job) => {
            // Without our app id the reporter cannot recognise its own runs,
            // so write nothing rather than duplicate check runs.
            app.log.warn({ job: job.key }, "APP_ID is not a valid app id; analysis skipped");
          }
        : createAnalysisWorker({
            appId,
            clientFor: repoScopedClients(app),
            log: app.log,
            ...((options.recommendations ?? recommendationsFromEnv())
              ? { recommend: createDefaultPolicy() }
              : {}),
            ...((options.footprint ?? footprintFromEnv())
              ? { metadata: new NpmMetadataService() }
              : {}),
          }));
    const queue =
      options.queue ??
      new InProcessJobQueue({
        worker,
        onError: (job, error) => app.log.error({ job: job.key, err: error }, "analysis job failed"),
        onSuperseded: (dropped, by) =>
          app.log.info(
            { job: dropped.key, supersededBy: by.key, repository: dropped.repository.id },
            "queued analysis dropped: the pull request's head moved past it",
          ),
      });

    addHandler((req, res) => {
      if (req.method !== "GET" || req.url?.split("?")[0] !== HEALTH_PATH) return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return true;
    });

    app.on(["installation", "installation_repositories"], async (context) => {
      const repositories =
        "repositories" in context.payload
          ? (context.payload.repositories ?? [])
          : "repositories_added" in context.payload
            ? context.payload.repositories_added
            : [];
      context.log.info(
        {
          event: context.name,
          action: context.payload.action,
          installation: context.payload.installation.id,
          repositories: repositories.map((r) => r.id),
        },
        "installation event received (no-op in v0.1)",
      );
    });

    app.on(
      [...analysedEvents.pull_request.map((a) => `pull_request.${a}` as const), "push"],
      async (context) => {
        const decision = await decide(
          context.name,
          context.payload,
          context.id,
          changedFilesLookup(app, context),
          { sourcePrTrigger },
        );
        if (!decision.analyse) {
          context.log.debug({ delivery: context.id, reason: decision.reason }, "event skipped");
          return;
        }
        const result = queue.enqueue(decision.job);
        const fields = {
          delivery: context.id,
          repository: decision.job.repository.id,
          trigger: decision.job.trigger.kind,
          dependencyFiles: decision.dependencyFiles.length,
          sourceFiles: decision.sourceFiles.length,
          result,
        };
        if (result === "overloaded") {
          context.log.warn(fields, "analysis queue full; job dropped");
          // GitHub won't redeliver, so leave a neutral run saying so instead of silence.
          const job = decision.job;
          if (appId === undefined) {
            context.log.warn(fields, "APP_ID not configured; no busy check run written");
          } else if (busyLimiter.allow(job.repository.id)) {
            try {
              await new CheckReporter(context.octokit.rest).busy({
                owner: job.repository.owner,
                repo: job.repository.name,
                headSha: job.headSha,
                externalId: job.key,
                appId,
              });
            } catch (error) {
              context.log.warn({ ...fields, err: error }, "busy check run failed");
            }
          }
        } else {
          context.log.info(fields, "analysis job");
        }
      },
    );

    // Re-run button (#97). Other check_run actions (created, completed,
    // requested_action) are ignored.
    app.on("check_run.rerequested", async (context) => {
      const decision = decideRerequest(context.payload, context.id, checkName);
      if (!decision.analyse) {
        context.log.debug({ delivery: context.id, reason: decision.reason }, "re-run skipped");
        return;
      }
      // Same lookup and source-only rule as the first run (#196).
      const job = await withRerunSourceOnly(decision.job, changedFilesLookup(app, context), {
        sourcePrTrigger,
      });
      const result = queue.enqueue(job);
      const fields = {
        delivery: context.id,
        repository: decision.job.repository.id,
        trigger: decision.job.trigger.kind,
        result,
      };
      if (result === "overloaded") {
        context.log.warn(fields, "analysis queue full; re-run dropped");
      } else {
        context.log.info(fields, "analysis re-run");
      }
    });
  };
}
