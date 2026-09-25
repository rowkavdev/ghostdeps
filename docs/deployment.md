# Deploy the GhostDeps GitHub App

GhostDeps v0.1 runs as one always-on Node 22 process (ADR 0003), not a serverless function. The process receives GitHub webhooks, queues work in memory and writes results to GitHub Checks. Start with **2 vCPU / 4 GiB RAM** for a small installation. The in-process queue runs **2 jobs at a time by default**, matching the 2 vCPU baseline (concurrency = cores); this is a code default, not a configurable environment setting. Profiling shows this workload becomes CPU-bound before memory-bound. Allow **at least ~150 MiB of temporary `/tmp` space per concurrent job** for bounded tarball extraction, then leave headroom for the OS and other temporary files. On the 2-job baseline, plan for at least ~300 MiB of available temporary space, not a tiny tmpfs. Monitor CPU, memory, temporary-disk space, queue pressure and API limits before increasing load. There is no database, external storage, dashboard or multi-replica coordination in v0.1. Restarting loses waiting jobs and the in-memory re-run cache. A durable queue and horizontal scaling are future work, not a supported deployment mode. GitHub will not automatically redeliver accepted jobs lost on restart; use the check's re-run button or push a new commit when needed.

The operator needs a host with outbound HTTPS to GitHub's API and codeload, a public HTTPS endpoint for GitHub's webhooks, and TLS termination (for example at a reverse proxy). Never expose the Node listener directly to the internet without TLS termination. The app does not execute repository code; it downloads bounded tarballs and analyses them in isolated workers.

## Register and install

The app lane owns production registration and the installation itself. Use [`packages/github-app/app.yml`](../packages/github-app/app.yml) as the registration manifest, rather than manually requesting broader permissions. Record the resulting **App ID**, generate/download a **private key**, and set a random **webhook secret** in the GitHub App's settings. Set the webhook URL to `https://YOUR_HOST/api/github/webhooks` (Probot's default path); it must reach this one service through the TLS proxy. Select the repositories to install on in GitHub's App installation flow. The manifest requests read-only contents and pull requests, write access to Checks, and implicit metadata read. See [GitHub App permissions and triggers](github-app.md) for the exact table and expected checks.

After installation, a new PR with a changed manifest or source file, or a qualifying push to the default branch, should produce a `ghostdeps` check. Installation events themselves log a no-op in v0.1. To verify delivery, inspect the GitHub App's recent deliveries for HTTP 2xx, then inspect the check on the commit. A 200 from `/healthz` proves the HTTP process is answering, not that GitHub auth, delivery or analysis succeeded.

## Environment

| Name                          | Required    | Meaning                                                                                                                                            |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ID`                      | Yes         | Numeric GitHub App ID; without it GhostDeps does not write check runs.                                                                             |
| `PRIVATE_KEY`                 | Yes         | Complete PEM from the App settings, as an environment value (literal newlines, escaped `\\n`, or base64). Keep it outside the repository and logs. |
| `WEBHOOK_SECRET`              | Yes         | The secret set on the GitHub App webhook; Probot verifies signatures.                                                                              |
| `NODE_ENV`                    | Recommended | `production`, which disables Probot's setup mode and uses JSON logging.                                                                            |
| `PORT`                        | Optional    | HTTP listener port, default `3000`.                                                                                                                |
| `HOST`                        | Optional    | Listener address; default is loopback. Use `0.0.0.0` only behind a trusted proxy/container network.                                                |
| `LOG_LEVEL`                   | Optional    | Probot log level (`info` by default). Do not log secrets or repository contents.                                                                   |
| `GHOSTDEPS_SOURCE_PR_TRIGGER` | Optional    | `false`/`0` disables source-only PR analysis; default on.                                                                                          |
| `GHOSTDEPS_RECOMMENDATIONS`   | Optional    | `false`/`0` disables verdicts and reports facts only; default on.                                                                                  |
| `GHOSTDEPS_FOOTPRINT`         | Optional    | `true`/`1` opts in to public npm install-footprint lookups; default off.                                                                           |

Do not commit credentials or paste them into shell history. Use your platform's secret manager to inject env vars into the one running process. Rotate by setting the new GitHub key/webhook secret and changing the process environment together; restart, then check deliveries and a real analysis.

## Container deployment

From the repository root:

```sh
docker build -t ghostdeps:YOUR_COMMIT .
docker run --name ghostdeps --restart unless-stopped --cpus 2 --memory 4g \
  --env-file /secure/path/ghostdeps.env -p 127.0.0.1:3000:3000 \
  ghostdeps:YOUR_COMMIT
curl --fail http://127.0.0.1:3000/healthz
```

Prepare `/secure/path/ghostdeps.env` outside the repository with `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, and `NODE_ENV=production`; limit its permissions to the deploy operator. Docker's `--env-file` is line-oriented: encode a multiline PEM as a single-line base64 value for `PRIVATE_KEY`. It is decoded by Probot; do not put the key in the Dockerfile or image. Publish HTTPS through a reverse proxy to loopback port 3000, forwarding the webhook path unchanged. The image runs as an unprivileged user and requires no writable persistent volume. Its `/healthz` check uses Node's built-in fetch. The Docker image build and health check have not been tested in this workspace (Docker is unavailable); the pnpm production deployment artifact has been built and inspected.

## Direct Node/systemd deployment

If not using Docker, install Node 22+ and pnpm via Corepack. In a release checkout, build and produce a standalone production package:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @ghostdeps/github-app deploy --prod /opt/ghostdeps/releases/YOUR_COMMIT
ln -sfn /opt/ghostdeps/releases/YOUR_COMMIT /opt/ghostdeps/current
```

The `deploy` output includes the compiled app and workspace adapter dependencies. Run as a dedicated unprivileged user. A sample unit follows; set `HOST=127.0.0.1` and terminate HTTPS at a local reverse proxy. The environment file must be root-controlled (`chmod 600`) and outside the repo. It uses systemd's `EnvironmentFile` syntax, **not** Docker's env-file syntax; for a multiline PEM, use one quoted base64 value. Restart policy restores the process, not the dropped in-memory jobs.

```ini
# /etc/systemd/system/ghostdeps.service
[Unit]
Description=GhostDeps GitHub App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ghostdeps
Group=ghostdeps
WorkingDirectory=/opt/ghostdeps/current
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
EnvironmentFile=/etc/ghostdeps/ghostdeps.env
ExecStart=/usr/bin/node /opt/ghostdeps/current/node_modules/probot/bin/probot.js run /opt/ghostdeps/current/dist/index.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Adjust `ExecStart`'s Node path for the installed Node binary. After installing the unit: `systemctl daemon-reload && systemctl enable --now ghostdeps`, then check `systemctl status ghostdeps` and `journalctl -u ghostdeps`. Never print the environment file in diagnostics.

## Upgrade and rollback

Build a new image tagged by commit SHA, or a new `/opt/ghostdeps/releases/<sha>` directory. Keep the old image or release. Deploy **one instance at a time**, restart it, check `/healthz`, confirm a fresh GitHub webhook delivery and a real check run, and watch logs for failures. A health 200 alone is not an end-to-end check. On failure, restore the previous image or the `current` symlink and restart. Re-run any work interrupted during restart from GitHub; because the queue is in memory, no pending jobs transfer between versions. If GitHub App manifest permissions/events change, review them in GitHub and communicate them to installers before assuming the new version works; do not silently widen access.
