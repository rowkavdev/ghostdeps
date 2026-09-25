# @ghostdeps/github-app

The GitHub App delivery layer (Probot). Architecture: [ADR 0003](../../docs/adr/0003-github-app-architecture.md). Operational reference: [docs/github-app.md](../../docs/github-app.md).

What is here (M0):

- `src/app.ts` - the Probot app function. Webhook signatures are verified by Probot before any handler runs. `pull_request` `opened`/`synchronize`/`reopened` emit an `AnalysisJob`; every other action is ignored. `installation.created` and `installation_repositories.added` queue full scans of newly granted repositories. `GET /healthz` returns liveness only: status, integer uptimeSeconds, and an optional validated deploy-supplied version.
- `src/jobs.ts` - the job boundary: `AnalysisJob`, the `JobQueue` interface, and the v0.1 `InProcessJobQueue` (bounded concurrency, duplicate (repository id, head SHA) keys collapse onto one job).
- `test/fixtures/` - webhook payloads the tests sign and post through the real middleware.

- `src/worker/` - the analysis worker: repo-scoped token, codeload tarball, core extraction and isolated analysis, then the check run (see docs/github-app.md).

## Running locally

Use a development-only GitHub App registration, never the production app. With `APP_ID`, `PRIVATE_KEY` and `WEBHOOK_SECRET` set (and `WEBHOOK_PROXY_URL` for smee.io delivery):

```bash
pnpm --filter @ghostdeps/github-app build
pnpm --filter @ghostdeps/github-app start
```
