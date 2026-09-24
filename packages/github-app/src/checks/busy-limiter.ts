/**
 * Rate limit for "GhostDeps was busy" check runs. When the queue is full,
 * every dropped job would otherwise cost a token fetch plus a create call,
 * adding API load exactly when the app is overloaded. At most one busy run
 * per repository per window; the rest are only logged.
 */
export interface BusyLimiterOptions {
  /** Window per repository. Default 60 seconds. */
  readonly windowMs?: number;
  /** Repositories remembered at once; oldest evicted first. Default 1,000. */
  readonly maxRepositories?: number;
  readonly now?: () => number;
}

export class BusyLimiter {
  readonly #last = new Map<number, number>();
  readonly #windowMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: BusyLimiterOptions = {}) {
    this.#windowMs = options.windowMs ?? 60_000;
    this.#max = Math.max(1, options.maxRepositories ?? 1000);
    this.#now = options.now ?? Date.now;
  }

  /** True (and records it) when a busy run may be created for this repository now. */
  allow(repositoryId: number): boolean {
    const now = this.#now();
    const last = this.#last.get(repositoryId);
    if (last !== undefined && now - last < this.#windowMs) return false;
    this.#last.delete(repositoryId);
    this.#last.set(repositoryId, now);
    while (this.#last.size > this.#max) {
      const oldest = this.#last.keys().next().value;
      if (oldest === undefined) break;
      this.#last.delete(oldest);
    }
    return true;
  }
}
