/**
 * Deliberate handling of GitHub rate limits (#255, from the #37 research).
 *
 * The worker retries a rate-limited request only when the wait is short and
 * only a couple of times; otherwise the request fails and the run ends
 * neutral with "re-run later" instead of holding a worker slot until the
 * limit resets. Probot's class defaults, which the worker's client used to
 * get, retry every rate limit for as long as it lasts.
 *
 * The webhook never waits: its changed-files lookup has a deadline, and a
 * lookup that misses it takes the incomplete-list path (analyse anyway).
 */

/** Longest wait, in seconds, the worker accepts before retrying. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;
/** Retries per request after a rate-limit response. */
export const MAX_RATE_LIMIT_RETRIES = 2;
/** How long the webhook waits for the changed-files lookup (ms). GitHub times deliveries out at 10 s. */
export const WEBHOOK_LOOKUP_DEADLINE_MS = 5_000;

interface ThrottledRequest {
  readonly method?: string;
  readonly url?: string;
}

interface Log {
  warn(obj: object, msg: string): void;
}

type Handler = (
  retryAfter: number,
  options: ThrottledRequest,
  octokit: unknown,
  retryCount: number,
) => boolean;

/** Whether a rate-limited request should be retried after `retryAfter` seconds. */
export function shouldRetryRateLimit(retryAfter: number, retryCount: number): boolean {
  return retryAfter <= MAX_RATE_LIMIT_WAIT_SECONDS && retryCount < MAX_RATE_LIMIT_RETRIES;
}

/** Throttle handlers for the worker's Octokit (plugin-throttling options). */
export function boundedThrottle(log: Log): { onRateLimit: Handler; onSecondaryRateLimit: Handler } {
  const handler =
    (kind: "primary" | "secondary"): Handler =>
    (retryAfter, options, _octokit, retryCount) => {
      const retry = shouldRetryRateLimit(retryAfter, retryCount);
      log.warn(
        { kind, method: options.method, url: options.url, retryAfter, retryCount, retry },
        retry ? "GitHub rate limit hit; retrying" : "GitHub rate limit hit; giving up",
      );
      return retry;
    };
  return { onRateLimit: handler("primary"), onSecondaryRateLimit: handler("secondary") };
}

/**
 * A GitHub rate-limit response (primary or secondary), as the throttling
 * plugin recognises them: 403/429 with no remaining quota, a secondary-limit
 * message or a retry-after header, or a GraphQL RATE_LIMITED error.
 */
export function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, unknown>; data?: { errors?: { type?: string }[] } };
  };
  const headers = e.response?.headers ?? {};
  if (e.response?.data?.errors?.some((x) => x.type === "RATE_LIMITED")) return true;
  if (e.status !== 403 && e.status !== 429) return false;
  return (
    headers["x-ratelimit-remaining"] === "0" ||
    headers["retry-after"] !== undefined ||
    /\b(secondary )?rate limit\b/i.test(e.message ?? "")
  );
}

/** Rejects if `work` takes longer than `ms`; the work itself is left to settle on its own. */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    // A lookup that lost the race may still fail later; don't let that surface as unhandled.
    work.catch(() => undefined);
  }
}

/**
 * Throttle handlers that never wait (webhook lookups, #255 follow-up): a
 * rate-limited lookup fails at once instead of leaving a request asleep
 * until the reset, which would fire together with every other one and feed
 * the secondary limit. The lookup is best-effort; a failure means "analyse
 * anyway".
 */
export function noWaitThrottle(log: Log): { onRateLimit: Handler; onSecondaryRateLimit: Handler } {
  const handler =
    (kind: "primary" | "secondary"): Handler =>
    (retryAfter, options) => {
      log.warn(
        { kind, method: options.method, url: options.url, retryAfter },
        "GitHub rate limit hit in the webhook; not waiting",
      );
      return false;
    };
  return { onRateLimit: handler("primary"), onSecondaryRateLimit: handler("secondary") };
}
