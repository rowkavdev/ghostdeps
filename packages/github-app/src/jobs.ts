/**
 * The job boundary from ADR 0003: webhook handlers emit AnalysisJobs, a
 * worker consumes them. v0.1 is an in-process queue; a durable queue can
 * replace it later behind the same JobQueue interface.
 */

/** Repository identity. Key on `id`; names are for display and can change. */
export interface JobRepository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
}

export type AnalysisTrigger =
  | {
      readonly kind: "pull_request";
      readonly number: number;
      readonly action: "opened" | "synchronize" | "reopened";
      readonly baseSha: string;
      /**
       * Set when the complete changed-file list had analysable source but no
       * manifest or lockfile (#101). If the diff can't then be read in full,
       * the worker stays PR-scoped instead of analysing the whole repository.
       */
      readonly sourceOnly?: true;
      /**
       * For synchronize: the PR's head before this push (the payload's
       * `before`). Only a queued job for exactly this head is superseded
       * (#257), so a late or redelivered event never drops a newer head.
       */
      readonly beforeSha?: string;
    }
  | { readonly kind: "push"; readonly ref: string; readonly beforeSha: string }
  | { readonly kind: "full_scan"; readonly reason: "installation" | "explicit" }
  | {
      /** A user re-ran the GhostDeps check from the UI (check_run.rerequested). */
      readonly kind: "rerequested";
      readonly checkRunId: number;
      /** Present when GitHub linked the run to a PR in the same repository (not for forks). */
      readonly pullRequest?: {
        readonly number: number;
        readonly baseSha: string;
        /** Same meaning as the pull_request trigger's sourceOnly, from a files-API lookup at re-run time (#196). */
        readonly sourceOnly?: true;
      };
    };

export interface AnalysisJob {
  /**
   * Idempotency key: one analysis per (repository id, head SHA). Re-runs
   * (trigger "rerequested") extend it so they are not collapsed; see rerequestKey.
   */
  readonly key: string;
  /** X-GitHub-Delivery GUID of the webhook that produced the job. */
  readonly deliveryId: string;
  readonly installationId: number;
  readonly repository: JobRepository;
  readonly headSha: string;
  readonly trigger: AnalysisTrigger;
}

export function analysisJobKey(repositoryId: number, headSha: string): string {
  return `${repositoryId}:${headSha}`;
}

/** "overloaded" means the queue is full and the job was dropped; callers should log it. */
export type EnqueueResult = "queued" | "duplicate" | "overloaded";

export interface JobQueue {
  /** Must return quickly: webhook deliveries time out after 10 seconds. */
  enqueue(job: AnalysisJob): EnqueueResult;
}

export type JobWorker = (job: AnalysisJob) => Promise<void>;

export interface InProcessJobQueueOptions {
  readonly worker: JobWorker;
  /** Maximum jobs running at once. Default 2. */
  readonly concurrency?: number;
  /**
   * How many recent job keys to remember for duplicate collapse. Default 1000.
   * Count-based and evicted oldest-first, so a key can be re-queued if this
   * many newer keys arrive while its job is still running. Acceptable for
   * v0.1; a durable queue should dedupe on job state instead.
   */
  readonly dedupeWindow?: number;
  /** Maximum jobs waiting to run. Beyond this, enqueue returns "overloaded". Default 500. */
  readonly maxPending?: number;
  readonly onError?: (job: AnalysisJob, error: unknown) => void;
  /** Called for each queued job dropped because its PR's head moved past it (#257). */
  readonly onSuperseded?: (dropped: AnalysisJob, by: AnalysisJob) => void;
}

/** v0.1 queue: in memory, bounded concurrency, duplicate keys collapse. */
export class InProcessJobQueue implements JobQueue {
  readonly #worker: JobWorker;
  readonly #concurrency: number;
  readonly #dedupeWindow: number;
  readonly #maxPending: number;
  readonly #onError: (job: AnalysisJob, error: unknown) => void;
  readonly #onSuperseded: (dropped: AnalysisJob, by: AnalysisJob) => void;
  readonly #pending: AnalysisJob[] = [];
  readonly #seen = new Set<string>();
  #running = 0;
  #idleWaiters: Array<() => void> = [];

  constructor(options: InProcessJobQueueOptions) {
    this.#worker = options.worker;
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#dedupeWindow = Math.max(1, options.dedupeWindow ?? 1000);
    this.#maxPending = Math.max(1, options.maxPending ?? 500);
    this.#onError = options.onError ?? (() => {});
    this.#onSuperseded = options.onSuperseded ?? (() => {});
  }

  enqueue(job: AnalysisJob): EnqueueResult {
    if (this.#seen.has(job.key)) return "duplicate";
    this.#dropSuperseded(job);
    if (this.#pending.length >= this.#maxPending) return "overloaded";
    this.#seen.add(job.key);
    if (this.#seen.size > this.#dedupeWindow) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    this.#pending.push(job);
    this.#drain();
    return "queued";
  }

  get size(): number {
    return this.#pending.length + this.#running;
  }

  /** Resolves once no jobs are pending or running. */
  onIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * A new head for a PR (#257): a synchronize event says which head it
   * replaced (`beforeSha`). A queued pull_request job for exactly that head
   * of the same PR would analyse a commit whose check is already superseded,
   * so drop it. Matching on `beforeSha`, not just "a different head", keeps
   * a late or redelivered older event from dropping the current head's job.
   * Re-runs the user asked for are never dropped and never supersede.
   * Running jobs are left to finish. A dropped job never created its check
   * run, so nothing needs cleaning up, and its key is forgotten so that head
   * can be queued again later.
   */
  #dropSuperseded(job: AnalysisJob): void {
    const t = job.trigger;
    if (t.kind !== "pull_request" || t.beforeSha === undefined) return;
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const queued = this.#pending[i]!;
      if (
        queued.trigger.kind === "pull_request" &&
        queued.trigger.number === t.number &&
        queued.repository.id === job.repository.id &&
        queued.headSha === t.beforeSha &&
        queued.headSha !== job.headSha
      ) {
        this.#pending.splice(i, 1);
        this.#seen.delete(queued.key);
        this.#onSuperseded(queued, job);
      }
    }
  }

  #drain(): void {
    while (this.#running < this.#concurrency) {
      const job = this.#pending.shift();
      if (!job) break;
      this.#running++;
      void this.#run(job);
    }
    if (this.size === 0) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  async #run(job: AnalysisJob): Promise<void> {
    try {
      await this.#worker(job);
    } catch (error) {
      this.#onError(job, error);
    } finally {
      this.#running--;
      this.#drain();
    }
  }
}
