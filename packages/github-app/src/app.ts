import type { ApplicationFunction, Probot } from "probot";
import { changedFiles } from "./events/changed-files.js";
import { analysedEvents, decide, type ChangedFilesLookup } from "./events/filter.js";
import { InProcessJobQueue, type JobQueue } from "./jobs.js";

export const HEALTH_PATH = "/healthz";

export interface GhostDepsAppOptions {
  /** Job boundary. Defaults to an in-process queue whose worker only logs (the analysis worker lands separately). */
  readonly queue?: JobQueue;
}

export function createGhostDepsApp(options: GhostDepsAppOptions = {}): ApplicationFunction {
  return (app: Probot, { addHandler }) => {
    const queue =
      options.queue ??
      new InProcessJobQueue({
        worker: async (job) => {
          app.log.info(
            { job: job.key, trigger: job.trigger.kind },
            "analysis job received (no worker yet)",
          );
        },
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
        } else {
          context.log.info(fields, "analysis job");
        }
      },
    );
  };
}
