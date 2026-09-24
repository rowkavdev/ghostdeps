/**
 * Rate-limit telemetry for the worker's GitHub calls (#256, from the #37
 * research). Every response carries x-ratelimit-* headers; the worker logs
 * them at debug level and warns once when the remaining budget drops below
 * 10% of the limit, so a saturation shows in the logs before it fails runs.
 */

/** Warn when remaining quota falls below this share of the limit. */
export const RATE_LIMIT_WARN_RATIO = 0.1;

interface Log {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

interface Hookable {
  hook: {
    after(
      name: "request",
      fn: (
        response: { headers: Record<string, unknown> },
        options: { method?: string; url?: string },
      ) => void,
    ): void;
  };
}

export interface RateLimitReading {
  readonly limit: number;
  readonly remaining: number;
  readonly used?: number;
  readonly resource?: string;
  readonly reset?: number;
}

/** Reads the x-ratelimit-* headers; undefined when they're missing or malformed. */
export function readRateLimit(headers: Record<string, unknown>): RateLimitReading | undefined {
  const num = (name: string) => {
    const raw = headers[name];
    const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  if (limit === undefined || remaining === undefined || limit <= 0) return undefined;
  const used = num("x-ratelimit-used");
  const reset = num("x-ratelimit-reset");
  const resource = headers["x-ratelimit-resource"];
  return {
    limit,
    remaining,
    ...(used !== undefined ? { used } : {}),
    ...(typeof resource === "string" ? { resource } : {}),
    ...(reset !== undefined ? { reset } : {}),
  };
}

/** Logs each response's rate-limit reading; warns once per client and resource below the threshold. */
export function watchRateLimit(octokit: Hookable, log: Log): void {
  const warned = new Set<string>();
  octokit.hook.after("request", (response, options) => {
    const reading = readRateLimit(response.headers);
    if (!reading) return;
    const resource = reading.resource ?? "core";
    const fields = { ...reading, method: options.method, url: options.url };
    log.debug(fields, "GitHub rate limit");
    if (reading.remaining < reading.limit * RATE_LIMIT_WARN_RATIO) {
      if (!warned.has(resource)) {
        warned.add(resource);
        log.warn(fields, "GitHub rate limit below 10% of the budget");
      }
    } else {
      warned.delete(resource);
    }
  });
}
