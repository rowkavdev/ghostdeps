# ADR 0003: GitHub App architecture

- Status: Accepted
- Date: 2026-09-24

## Context

The GitHub App is the primary interface. It must react to pull requests, pushes, and installations; analyse dependency changes; and report through the Checks API with annotations — without noisy bot comments. It processes untrusted repositories, must respect least-privilege permissions, and must not be over-engineered for v0.1 while keeping clean boundaries between GitHub integration, job orchestration, checkout, analysis, storage and reporting. The analysis engine must remain independently usable from the CLI.

## Decision

**Probot (Node.js, TypeScript) as the app framework, deployed initially as a single long-lived service, with a queue-shaped internal boundary.**

Components and boundaries:

```text
GitHub webhook
   │
   ▼
@ghostdeps/github-app (Probot)
   │  - signature verification (Probot built-in)
   │  - event filtering (is this event worth analysis?)
   │  - emits AnalysisJob onto the job boundary
   ▼
Job boundary (interface, not infrastructure)
   │  - v0.1: in-process queue with concurrency limits
   │  - later: durable queue (SQS/BullMQ/Postgres) behind the same interface
   ▼
Analysis worker
   │  - shallow checkout via tarball download (no git clone, no hooks)
   │  - runs @ghostdeps/core analysis engine
   ▼
Reporter
   - GitHub Checks API: one check run per analysis, annotations per finding
   - PR comments only when they add value beyond the check (rare)
```

Key choices:

- **Probot** over hand-rolled `@octokit/app` plumbing: it gives webhook verification, app/installation auth, event typing, and a test story (nock-recorded payloads) out of the box, and remains actively released (v14 line). The boundaries above mean Probot stays replaceable; only the thin delivery layer depends on it.
- **Checkout by codeload tarball**, never `git clone`: no git metadata, no hooks, no smudge filters, fixed size limits, and no way for repo content to influence the client (ADR 0004).
- **Least-privilege permissions** (documented in docs/github-app.md, to be mirrored exactly in the app manifest):
  - `contents: read` — read manifests, lockfiles, source via tarball/API
  - `pull_requests: read` — diffs to see dependency changes in context
  - `checks: write` — create check runs and annotations
  - `metadata: read` — implicit, always granted
  - Webhook events: `pull_request`, `push`, `installation`, `installation_repositories`. Nothing else.
  - No `issues`, no `actions`, no `contents: write`. Remediation PRs (M4) will request `contents: write` + `pull_requests: write` as a separate, opt-in app permission change, not silently.
- **Check behaviour:** exactly one `ghostdeps` check run per analysed head SHA. Neutral success with a quiet summary when nothing is found ("No significant dependency issues found."). Annotations attach to manifest/source lines. Conclusions: `success` (nothing notable), `neutral` (findings worth review), never `failure` — GhostDeps advises, it does not gate.
- **Rate limits:** installation tokens, conditional requests with ETags for API reads, and backoff on secondary limits. Analysis jobs are idempotent per (repo, SHA); duplicate webhook deliveries collapse onto the same check run.
- **Storage:** v0.1 keeps none beyond job state. Scan history/dashboards are post-M1 and will be a separate ADR.

## Alternatives considered

**Hand-rolled on `@octokit/app` + `@octokit/webhooks`.** Fewer dependencies, more control. Rejected for v0.1: re-implementing auth token caching, verification, and event routing is undifferentiated work with real security surface; Probot is the maintained convention and its pieces (octokit) remain directly accessible.

**Serverless (Lambda/Vercel functions) per webhook.** Scales to zero, but cold starts against multi-minute analysis jobs and checkout size limits fight the workload; a worker model is the honest shape. The job boundary keeps a later serverless or queued deployment possible.

**GitHub Actions reusable workflow instead of an App.** Zero infrastructure for users, but it is a different product: no central app, no installation model, heavier for repos to adopt, and Actions minutes on every consumer repo. The spec is explicit that the App is primary.

## Consequences

- We operate one small service for v0.1; deployment docs live in docs/github-app.md.
- Upgrading to a durable queue is an internal change invisible to the analysis engine.
- The permission set is a product feature: it is documented publicly and reviewed on every PR that touches the manifest.
