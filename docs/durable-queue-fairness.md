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

- **Starvation bound.** With A lanes holding pending jobs, any job starts within A - 1 worker turns of its lane's previous job. Plain FIFO has no equivalent bound.
- **Ordering.** Each lane is FIFO, so per-repository order is preserved exactly as today; supersede (#257) drops the replaced job inside its lane and changes nothing else.
- **Dedupe.** The durable store dedupes on job state (one pending/running job per key) instead of the count-based window, closing the "key evicted while still running" hole noted in `jobs.ts`. Re-runs keep their distinct `rerequestKey` and are never deduped or superseded.
- **Backpressure.** The global pending cap becomes a per-lane soft cap plus a global hard cap. A lane over its soft cap sheds its own oldest non-re-run jobs to "busy" neutrals (existing limiter semantics, per repository per minute); the global hard cap remains the last-resort `overloaded` result. A small installation's jobs are never shed because a large one is flooding.
- **Bulk scans.** `full_scan` jobs from a fresh installation arrive as a burst (one per repository). They share the installation's lane with PR jobs, quantum 1 like everything else: the burst cannot monopolise workers, and the installation's own PR jobs interleave rather than queue behind their whole scan. If initial scans prove too slow this way, a separate scan class with one lane-wide quantum is the lever, not a priority tier.
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
