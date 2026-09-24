import type { ApplicationFunction, Probot } from "probot";
import { analysisJobKey, InProcessJobQueue, type JobQueue } from "./jobs.js";

export const HEALTH_PATH = "/healthz";

/** Pull request actions that can change the dependency picture. Default-deny the rest. */
const ANALYSED_PR_ACTIONS = ["opened", "synchronize", "reopened"] as const;

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
      if (req.method !== "GET" || req.url !== HEALTH_PATH) return false;
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
      ANALYSED_PR_ACTIONS.map((a) => `pull_request.${a}` as const),
      async (context) => {
        const { payload } = context;
        const installationId = payload.installation?.id;
        if (installationId === undefined) {
          context.log.warn({ delivery: context.id }, "pull_request without installation; ignored");
          return;
        }
        const action = payload.action;
        const result = queue.enqueue({
          key: analysisJobKey(payload.repository.id, payload.pull_request.head.sha),
          deliveryId: context.id,
          installationId,
          repository: {
            id: payload.repository.id,
            owner: payload.repository.owner.login,
            name: payload.repository.name,
          },
          headSha: payload.pull_request.head.sha,
          trigger: {
            kind: "pull_request",
            number: payload.pull_request.number,
            action,
            baseSha: payload.pull_request.base.sha,
          },
        });
        context.log.info(
          { delivery: context.id, repository: payload.repository.id, result },
          "pull_request analysis job",
        );
      },
    );
  };
}
