/**
 * Cached npm registry metadata for install footprints (#174, #59 slice B).
 * Core asks a `PackageMetadataProvider` for the install sizes of exact
 * package versions; this is the GitHub App's npm implementation. Not wired
 * into analysis yet: that waits for core's version-aware closure walk
 * (#288), because until then core can overcount.
 *
 * Egress rules (docs/security-model.md): unauthenticated, read-only GETs to
 * the public npm registry only, never with a GitHub token. Every run has a
 * fetch budget and a per-request timeout, answers are cached in a bounded
 * LRU, and any failure just leaves a package unsized. The footprint is
 * advisory, so nothing here throws, caps a check or reports an error.
 */
import { createHash } from "node:crypto";
import {
  isPublicNpmRegistryOrigin,
  normaliseRegistryOrigin,
  PUBLIC_NPM_REGISTRY_ORIGINS,
  type PackageMetadataProvider,
  type PackageRegistryFacts,
  type PackageVersionRef,
} from "@ghostdeps/core";

/** The only ecosystem served. PyPI, crates.io and Go size data is too weak for now. */
export const NPM_ECOSYSTEM = "javascript-typescript";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPM_SIZE_BASIS = "npm registry dist.unpackedSize";

/** The fetch surface this module needs; global fetch by default, a stub in tests. */
export type FetchLike = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  /** The response body as a byte stream (a web ReadableStream is async iterable). */
  body: (AsyncIterable<Uint8Array> & { cancel?(): Promise<void> }) | null;
}>;

/**
 * A provider for one run. `complete` is true only when every answer it gave
 * was fully resolved and none is still pending, so callers can refuse to
 * persist anything built on a truncated footprint (#313 review).
 */
export interface RunMetadataProvider extends PackageMetadataProvider {
  readonly complete: boolean;
  packageFacts?(request: {
    ecosystem: string;
    packages: readonly PackageVersionRef[];
  }): Promise<readonly PackageRegistryFacts[] | undefined>;
}

/** Drop a body we won't read, so the connection can be reused (#313 review). */
async function discard(body: { cancel?(): Promise<void> } | null): Promise<void> {
  try {
    await body?.cancel?.();
  } catch {
    // Nothing to clean up if cancelling fails.
  }
}

/**
 * The body as text, or undefined once it passes `max` bytes. Reads the
 * stream in chunks, so a chunked response with no content-length can't
 * make it buffer more than the cap.
 */
export async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  max: number,
): Promise<string | undefined> {
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface NpmMetadataOptions {
  /** Cached name@version sizes (and known misses), least recently used go first. Default 50,000. */
  readonly maxVersions?: number;
  /** Cached whole answers keyed by the resolved dependency set. Default 256. */
  readonly maxAnswers?: number;
  /** Registry requests allowed per run. Past it, the rest stay unsized. Default 300. */
  readonly fetchBudget?: number;
  /** Per-request timeout in ms. Default 3,000. */
  readonly requestTimeoutMs?: number;
  /** Whole-run deadline in ms, under core's 10 s provider timeout. Default 8,000. */
  readonly runTimeoutMs?: number;
  /** Parallel registry requests. Default 8. */
  readonly concurrency?: number;
  /** Largest version document read, in bytes. Default 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Positive and known-missing version cache lifetime. Default 24 h. */
  readonly versionTtlMs?: number;
  /** Complete answer cache lifetime. Default 1 h. */
  readonly answerTtlMs?: number;
  readonly fetch?: FetchLike;
}

/** A requested version; `origin` is core's lockfile registry origin when known. */
type Ref = PackageVersionRef;

/**
 * Only versions whose lockfile origin is on core's public npm allowlist
 * (PUBLIC_NPM_REGISTRY_ORIGINS: npmjs and yarn classic's mirror, exact
 * match, #174 step 3). A package from anywhere else may be private, so its
 * name never leaves the installation and a 404 can't reveal it. No origin,
 * no query.
 */
export function publicRefs(packages: readonly PackageVersionRef[]): Ref[] {
  const out: Ref[] = [];
  for (const p of packages) {
    if (!p || !isPublicNpmRegistryOrigin(p.origin)) continue;
    out.push({ name: p.name, version: p.version, origin: normaliseRegistryOrigin(p.origin)! });
  }
  return out;
}

type Answer = { basis: string; sizes: (PackageVersionRef & { bytes: number })[] };

// npm package names: lower-case, URL-safe, optional @scope/, at most 214 chars.
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// Exact versions only (semver with optional prerelease/build). Lockfiles from
// hostile repos can hold anything; nothing else reaches a URL.
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,100})?(?:\+[0-9A-Za-z.-]{1,100})?$/;

/** A registry-safe name@version, or undefined. */
export function registryPath(ref: PackageVersionRef): string | undefined {
  if (typeof ref.name !== "string" || typeof ref.version !== "string") return undefined;
  if (ref.name.length > 214 || !NAME.test(ref.name) || !VERSION.test(ref.version)) return undefined;
  return `${ref.name.replace("/", "%2F")}/${encodeURIComponent(ref.version)}`;
}

/**
 * The content key for a request: a hash of the resolved dependency set the
 * lockfiles produced, origin included. Source-only changes leave it alone, so those runs are
 * answered without touching the version cache or the registry; any change
 * to a resolved name@version misses.
 */
export function answerKey(ecosystem: string, packages: readonly Ref[]): string {
  const lines = packages.map((p) => `${p.origin ?? ""}\0${p.name}\0${p.version}`).sort();
  return createHash("sha256").update(ecosystem).update("\n").update(lines.join("\n")).digest("hex");
}

/** An abort signal that fires after `ms`; `clear` stops the timer. */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

class Lru<V> {
  readonly #map = new Map<string, { value: V; expires: number }>();
  constructor(
    readonly max: number,
    readonly ttlMs: number,
  ) {}
  get(key: string): V | undefined {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expires) {
      this.#map.delete(key);
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }
  has(key: string): boolean {
    return this.#map.has(key);
  }
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.#map.size > this.max) this.#map.delete(this.#map.keys().next().value!);
  }
  get size(): number {
    return this.#map.size;
  }
}

/**
 * Process-wide npm size cache. Call `forRun()` once per analysis for a
 * provider with that run's fetch budget and deadline.
 */
export class NpmMetadataService {
  // Known size in bytes, or null for a version the registry has no size for.
  readonly publicOrigins = PUBLIC_NPM_REGISTRY_ORIGINS;
  readonly #versions: Lru<number | null>;
  readonly #facts: Lru<PackageRegistryFacts | null>;
  readonly #answers: Lru<Answer>;
  readonly #options: Required<
    Omit<NpmMetadataOptions, "maxVersions" | "maxAnswers" | "versionTtlMs" | "answerTtlMs">
  >;

  constructor(options: NpmMetadataOptions = {}) {
    this.#versions = new Lru(
      Math.max(1, options.maxVersions ?? 50_000),
      Math.max(1, options.versionTtlMs ?? 86_400_000),
    );
    this.#facts = new Lru(
      Math.max(1, options.maxVersions ?? 50_000),
      Math.max(1, options.versionTtlMs ?? 86_400_000),
    );
    this.#answers = new Lru(
      Math.max(1, options.maxAnswers ?? 256),
      Math.max(1, options.answerTtlMs ?? 3_600_000),
    );
    this.#options = {
      fetchBudget: Math.max(0, options.fetchBudget ?? 300),
      requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? 3_000),
      runTimeoutMs: Math.max(1, options.runTimeoutMs ?? 8_000),
      concurrency: Math.max(1, options.concurrency ?? 8),
      maxResponseBytes: Math.max(1, options.maxResponseBytes ?? 1024 * 1024),
      fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike),
    };
  }

  /** A provider for one analysis run. */
  forRun(): RunMetadataProvider {
    let budget = this.#options.fetchBudget;
    let pending = 0;
    let truncated = false;
    return {
      get complete() {
        return pending === 0 && !truncated;
      },
      packageFacts: async ({ ecosystem, packages }) => {
        pending++;
        try {
          if (ecosystem !== NPM_ECOSYSTEM || !Array.isArray(packages)) return undefined;
          const wanted = publicRefs(packages);
          const out: PackageRegistryFacts[] = [];
          const seen = new Set<string>();
          const run = timeoutSignal(this.#options.runTimeoutMs);
          try {
            for (const ref of wanted) {
              if (run.signal.aborted) {
                truncated = true;
                break;
              }
              const path = registryPath(ref);
              if (!path || seen.has(path)) continue;
              seen.add(path);
              const cached = this.#facts.get(path);
              if (cached !== undefined) {
                if (cached) out.push(cached);
                continue;
              }
              if (budget <= 0) {
                truncated = true;
                break;
              }
              budget--;
              const result = await this.#fetchFacts(ref, path, run.signal);
              if (result === "transient") {
                truncated = true;
                continue;
              }
              this.#facts.set(path, result);
              if (result) out.push(result);
            }
          } finally {
            run.clear();
          }
          return out;
        } catch {
          truncated = true;
          return undefined;
        } finally {
          pending--;
        }
      },
      installSizes: async ({ ecosystem, packages }) => {
        pending++;
        try {
          if (ecosystem !== NPM_ECOSYSTEM || !Array.isArray(packages)) return undefined;
          // Anything not resolved from the public registry is skipped
          // silently: no request, no size, no note.
          const wanted = publicRefs(packages);
          if (wanted.length === 0) return { basis: NPM_SIZE_BASIS, sizes: [] };
          const key = answerKey(ecosystem, wanted);
          const cached = this.#answers.get(key);
          if (cached) return cached;
          const take = () => (budget > 0 ? (budget--, true) : false);
          const { answer, complete } = await this.#resolve(wanted, take);
          // Only a fully resolved answer stands for the whole set: one cut
          // short by the budget, deadline or a transient failure retries.
          if (complete) this.#answers.set(key, answer);
          else truncated = true;
          return answer;
        } catch {
          truncated = true;
          return undefined;
        } finally {
          pending--;
        }
      },
    };
  }

  async #resolve(
    packages: readonly PackageVersionRef[],
    take: () => boolean,
  ): Promise<{ answer: Answer; complete: boolean }> {
    const sizes: (PackageVersionRef & { bytes: number })[] = [];
    const missing: { ref: PackageVersionRef; path: string; id: string }[] = [];
    const seen = new Set<string>();
    for (const ref of packages) {
      const path = registryPath(ref);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const known = this.#versions.get(path);
      if (known === undefined) missing.push({ ref, path, id: path });
      else if (known !== null) sizes.push({ name: ref.name, version: ref.version, bytes: known });
    }

    let complete = true;
    const run = timeoutSignal(this.#options.runTimeoutMs);
    const deadline = run.signal;
    let next = 0;
    const worker = async () => {
      while (next < missing.length && !deadline.aborted) {
        const item = missing[next++]!;
        if (!take()) {
          complete = false;
          return;
        }
        const got = await this.#fetchSize(item.path, deadline);
        if (got === "transient") {
          complete = false;
          continue;
        }
        this.#versions.set(item.path, got);
        if (got !== null)
          sizes.push({ name: item.ref.name, version: item.ref.version, bytes: got });
      }
      if (next < missing.length) complete = false;
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.#options.concurrency, missing.length) }, worker),
      );
    } finally {
      run.clear();
    }
    sizes.sort((a, b) =>
      a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
    );
    return { answer: { basis: NPM_SIZE_BASIS, sizes }, complete };
  }

  /** The bounded packument carries version timestamps and deprecation. */
  async #fetchFacts(
    ref: PackageVersionRef,
    path: string,
    deadline: AbortSignal,
  ): Promise<PackageRegistryFacts | null | "transient"> {
    const request = timeoutSignal(this.#options.requestTimeoutMs);
    try {
      const namePath = path.slice(0, path.lastIndexOf("/"));
      const res = await this.#options.fetch(`${NPM_REGISTRY}/${namePath}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.any([deadline, request.signal]),
      });
      if (res.status === 404) {
        await discard(res.body);
        return null;
      }
      if (res.status !== 200) {
        await discard(res.body);
        return "transient";
      }
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > this.#options.maxResponseBytes) {
        await discard(res.body);
        return null;
      }
      const body = await readCapped(res.body, this.#options.maxResponseBytes);
      if (body === undefined) return null;
      const doc: unknown = JSON.parse(body);
      if (!doc || typeof doc !== "object") return null;
      const pack = doc as {
        versions?: Record<string, { deprecated?: unknown }>;
        time?: Record<string, unknown>;
      };
      const version = pack.versions?.[ref.version];
      if (!version || typeof version !== "object") return null;
      const publishedAt = pack.time?.[ref.version];
      const deprecated = version.deprecated;
      const validDate =
        typeof publishedAt === "string" &&
        Number.isFinite(Date.parse(publishedAt)) &&
        /^\d{4}-\d\d-\d\dT/.test(publishedAt);
      return {
        name: ref.name,
        version: ref.version,
        ...(ref.origin ? { origin: ref.origin } : {}),
        ...(validDate
          ? { publishedAt: { value: publishedAt, basis: "npm registry time[version]" } }
          : {}),
        ...(typeof deprecated === "string"
          ? {
              deprecated: {
                value: deprecated.length > 0,
                basis: "npm registry versions[version].deprecated",
              },
            }
          : {}),
      };
    } catch {
      return "transient";
    } finally {
      request.clear();
    }
  }

  /** Size in bytes, null when the registry has none (cacheable), or "transient". */
  async #fetchSize(path: string, deadline: AbortSignal): Promise<number | null | "transient"> {
    const request = timeoutSignal(this.#options.requestTimeoutMs);
    const signal = AbortSignal.any([deadline, request.signal]);
    try {
      const res = await this.#options.fetch(`${NPM_REGISTRY}/${path}`, {
        method: "GET",
        // No credentials of any kind: the registry is public and read-only.
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (res.status === 404) {
        await discard(res.body);
        return null;
      }
      if (res.status !== 200) {
        await discard(res.body);
        return "transient";
      }
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > this.#options.maxResponseBytes) {
        await discard(res.body);
        return null;
      }
      const body = await readCapped(res.body, this.#options.maxResponseBytes);
      if (body === undefined) return null;
      const doc: unknown = JSON.parse(body);
      const size = (doc as { dist?: { unpackedSize?: unknown } } | null)?.dist?.unpackedSize;
      return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
    } catch {
      return "transient";
    } finally {
      request.clear();
    }
  }
}
