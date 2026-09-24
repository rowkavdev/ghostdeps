import type { ApplicationFunction, Probot } from "probot";
import { BusyLimiter } from "./checks/busy-limiter.js";
import { CheckReporter } from "./checks/reporter.js";
import { appIdFromEnv } from "./config.js";
import { changedFiles } from "./events/changed-files.js";
import { checkName } from "./checks/render.js";
import { analysedEvents, decide, type ChangedFilesLookup } from "./events/filter.js";
import { decideRerequest } from "./events/rerequested.js";
import { InProcessJobQueue, type JobQueue, type JobWorker } from "./jobs.js";
import { createAnalysisWorker } from "./worker/analyse-job.js";
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
  /** Limits "busy" check runs when the queue is full. Defaults to one per repository per minute. */
  readonly busyLimiter?: BusyLimiter;
}

export function createGhostDepsApp(options: GhostDepsAppOptions = {}): ApplicationFunction {
  return (app: Probot, { addHandler }) => {
    const appId = options.appId ?? appIdFromEnv();
    const busyLimiter = options.busyLimiter ?? new BusyLimiter();
    const worker: JobWorker =
      options.worker ??
      (appId === undefined
        ? async (job) => {
            // Without our app id the reporter cannot recognise its own runs,
            // so write nothing rather than duplicate check runs.
            app.log.warn({ job: job.key }, "APP_ID is not a valid app id; analysis skipped");
          }
        : createAnalysisWorker({ appId, clientFor: repoScopedClients(app), log: app.log }));
    const queue =
      options.queue ??
      new InProcessJobQueue({
        worker,
        onError: (job, error) => app.log.error({ job: job.key, err: error }, "analysis job failed"),
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
        const lookup: ChangedFilesLookup = async (candidate) => {
          try {
            return await changedFiles(context.octokit, candidate);
          } catch (error) {
            context.log.warn(
              { delivery: context.id, err: error },
              "changed-files lookup failed; analysing anyway",
            );
            throw error;
          }
        };
        const decision = await decide(context.name, context.payload, context.id, lookup);
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
      const result = queue.enqueue(decision.job);
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
