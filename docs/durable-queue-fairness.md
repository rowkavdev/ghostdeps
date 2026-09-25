# Durable queue and per-installation fairness

Design note for #258 (from #37 research, PR #252). ADR 0003 keeps the job boundary an interface so the v0.1 in-process queue can be replaced by a durable one (SQS/BullMQ/Postgres) without touching the analysis engine. This note settles the scheduling design for that move; it does not pick the backend or schedule the work.

## Current behaviour (v0.1)

`InProcessJobQueue` (`packages/github-app/src/jobs.ts`) is one FIFO across all installations: concurrency 2, at most 500 pending jobs, duplicate collapse on (repository id, head SHA) with a 1,000-key count window, supersede of a queued PR job when `synchronize` names its head as `before` (#257), and the "GhostDeps was busy" limiter (one neutral run per repository per minute) when the queue is full. Webhook handlers must still answer inside GitHub's 10-second delivery timeout, so `enqueue` stays synchronous and cheap.

## Problem

FIFO across installations means one busy installation can delay every other installation: a large organisation pushing often fills both worker slots and, eventually, the pending queue, at which point other installations' jobs are dropped to "busy" neutrals even though their own load is trivial. At 2 concurrent jobs this is mostly theoretical today (github-api-limits.md, gap 4), which is why it is deferred to the durable-queue move rather than patched in place.

## Goals and non-goals

Goals:

- No installation can starve another: every queued job runs within a bounded number of worker turns, regardless of other installations' load.
- Overload sheds from the installation causing it, not from whoever arrives next.
- Everything v0.1 already guarantees keeps working: per-(repo, SHA) idempotency, supersede on `before`, re-runs never dropped, busy neutral behaviour, per-repository ordering.

Non-goals: choosing the queue backend, multi-replica worker coordination, priority tiers or paid-tier scheduling, and cross-SHA result caching (rejected in github-api-limits.md).

## Design

**Per-installation lanes with deficit round-robin (DRR) scheduling.** The queue keeps one logical lane per installation id; a lane exists only while it holds pending jobs. The worker scheduler walks lanes round-robin and runs one job per lane per visit (quantum = 1 job). A lane that is empty at its turn is skipped and accumulates no credit, so a previously quiet installation cannot bank backlog against others.

- **Starvation bound.** The bound is on lane service first: with A non-empty lanes and quantum 1, each lane is served once per scheduling round of at most A jobs, so every lane drains at at least 1/A of worker throughput. Within a lane, the bounded class rule (below) then bounds each job: an interactive job at class position p starts within (p + 1) * A * (S + 1) / S worker turns, and the oldest bulk job starts within (S + 1) * A. What this rules out is the unbounded case: under today's cross-installation FIFO, a sustained burst from one installation can postpone another installation's job indefinitely (no bound at any load); here every queued job has a finite, computable worst-case wait. Within a lane, a burst still delays the lane's own later jobs - that is the installation delaying itself, which is correct.
- **Ordering.** Each lane is FIFO within each class, and per-repository order is preserved within each class. Across classes a newer interactive job for a repository can overtake an older bulk scan of the same repository; that is safe because every job carries its own head SHA, jobs share no mutable state, and results land on per-SHA check runs. Supersede (#257) drops the replaced job inside its lane and changes nothing else.
- **Dedupe.** The durable store dedupes on job state (one pending/running job per key) instead of the count-based window, closing the "key evicted while still running" hole noted in `jobs.ts`. Re-runs keep their distinct `rerequestKey` and are never deduped or superseded.
- **Backpressure with reserved admission.** A bare global hard cap would still shed a small installation's jobs whenever a large one fills the queue, so admission is per-lane: each lane's cap is max(R, C / A) where C is the global pending target, A the number of active lanes and R a small fixed reserve (suggest 20). A lane at its cap sheds its own incoming jobs to "busy" neutrals (existing limiter semantics, per repository per minute); a lane below its cap is always admitted, even when other lanes are flooding. Global pending is then bounded by the sum of lane caps (at most C + A * R), which the implementation sizes to memory; there is no separate global hard cap that can fire against a quiet installation.
- **Bulk scans and bounded class service.** `full_scan` jobs from a fresh installation arrive as a burst (one per repository). Plain FIFO inside a lane would make the installation's own PR jobs queue behind its whole scan, so each lane carries two classes: interactive (`pull_request`, `push`, `rerequested`) and bulk (`full_scan`). The scheduler picks the lane by DRR, then applies the class rule: serve the oldest interactive job, except that once the lane's oldest bulk job has been passed over S times (suggest S = 4) it is served at the next lane turn and its count resets. Unconditional interactive-first would let sustained PR traffic starve a bulk scan forever, so the aging is part of the contract, not a tuning knob: bulk gets at least 1 in S + 1 of the lane's turns, interactive at least S in S + 1. The burst therefore cannot monopolise workers (DRR across lanes), cannot starve the installation's own PR jobs (interactive preference), and is itself guaranteed to finish (aging). There is no cross-lane priority tier.
- **Interface change.** `JobQueue.enqueue` becomes async (`Promise<EnqueueResult>`); durable writes have latency and failure modes the sync signature hides. The 10-second webhook budget is unaffected: enqueue is one insert. Everything else about the boundary (job shape, key scheme, worker contract) is unchanged, per ADR 0003's "internal change invisible to the analysis engine".

**Backend direction.** ADR 0003 names SQS, BullMQ and Postgres without choosing. The scheduling design above is backend-neutral, but the lane model favours a store that can query "oldest pending job per installation" directly: Postgres (`SELECT ... FOR UPDATE SKIP LOCKED` with a partial index on (installation id, enqueued at)) does this in one statement, needs no extra service if a database arrives for other features, and keeps the self-hosted single-node deployment story. BullMQ needs Redis and expresses lanes as one queue per installation with manual rotation; SQS has no cross-queue fair scheduler at all, so fairness would be re-implemented in the worker with per-installation queues and polling. Default to Postgres when the move happens unless deployment constraints have changed by then; decide in a short ADR at that point.

**Retry and loss.** A durable queue changes the failure contract: a worker crash returns the job to its lane after a visibility timeout instead of losing it (today a restart loses all pending jobs - deployment.md). Jobs get a bounded attempt count (suggest 3); a job that exhausts attempts completes its check run `neutral` as "GhostDeps could not run" rather than disappearing, matching the rate-limit failure path from #255. Restart semantics in deployment.md get rewritten when this lands.

**Observability.** Log per-lane pending depth and per-job queue wait (dequeue time minus enqueue time) alongside the existing rate-limit telemetry (#256), and warn when any lane's oldest job waits past a threshold (suggest 10 minutes). Fairness bugs show up as one lane's wait growing while others stay flat.

## What does not change

The job envelope already carries `installationId`; no new fields are needed. The BusyLimiter, the (repository id, head SHA) key scheme, the check-run contract (one run per head, never `failure`), and the webhook event surface are all untouched.

## Open questions

- Backend choice (Postgres vs BullMQ vs SQS) - deferred to the implementation ADR.
- Attempt count and visibility timeout values.
- Whether re-runs should jump their lane (today they bypass dedupe only); default here is no special treatment.
- Multi-replica workers: DRR assumes one scheduler; with multiple workers, lane order is approximate. Acceptable - fairness needs a bound, not strict rotation.
