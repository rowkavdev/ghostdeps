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
import type { PackageMetadataProvider, PackageVersionRef } from "@ghostdeps/core";

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
  text(): Promise<string>;
}>;

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
  readonly registry?: string;
  readonly fetch?: FetchLike;
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
 * lockfiles produced. Source-only changes leave it alone, so those runs are
 * answered without touching the version cache or the registry; any change
 * to a resolved name@version misses.
 */
export function answerKey(ecosystem: string, packages: readonly PackageVersionRef[]): string {
  const lines = packages.map((p) => `${p.name}\0${p.version}`).sort();
  return createHash("sha256").update(ecosystem).update("\n").update(lines.join("\n")).digest("hex");
}

/** An abort signal that fires after `ms`; `clear` stops the timer. */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

class Lru<V> {
  readonly #map = new Map<string, V>();
  constructor(readonly max: number) {}
  get(key: string): V | undefined {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key)!;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }
  has(key: string): boolean {
    return this.#map.has(key);
  }
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
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
  readonly #versions: Lru<number | null>;
  readonly #answers: Lru<Answer>;
  readonly #options: Required<Omit<NpmMetadataOptions, "maxVersions" | "maxAnswers">>;

  constructor(options: NpmMetadataOptions = {}) {
    this.#versions = new Lru(Math.max(1, options.maxVersions ?? 50_000));
    this.#answers = new Lru(Math.max(1, options.maxAnswers ?? 256));
    this.#options = {
      fetchBudget: Math.max(0, options.fetchBudget ?? 300),
      requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? 3_000),
      runTimeoutMs: Math.max(1, options.runTimeoutMs ?? 8_000),
      concurrency: Math.max(1, options.concurrency ?? 8),
      maxResponseBytes: Math.max(1, options.maxResponseBytes ?? 1024 * 1024),
      registry: (options.registry ?? NPM_REGISTRY).replace(/\/+$/, ""),
      fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike),
    };
  }

  /** A provider for one analysis run. */
  forRun(): PackageMetadataProvider {
    let budget = this.#options.fetchBudget;
    return {
      installSizes: async ({ ecosystem, packages }) => {
        try {
          if (ecosystem !== NPM_ECOSYSTEM || !Array.isArray(packages)) return undefined;
          const key = answerKey(ecosystem, packages);
          const cached = this.#answers.get(key);
          if (cached) return cached;
          const take = () => (budget > 0 ? (budget--, true) : false);
          const { answer, complete } = await this.#resolve(packages, take);
          // Only a fully resolved answer stands for the whole set: one cut
          // short by the budget, deadline or a transient failure retries.
          if (complete) this.#answers.set(key, answer);
          return answer;
        } catch {
          return undefined;
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

  /** Size in bytes, null when the registry has none (cacheable), or "transient". */
  async #fetchSize(path: string, deadline: AbortSignal): Promise<number | null | "transient"> {
    const request = timeoutSignal(this.#options.requestTimeoutMs);
    const signal = AbortSignal.any([deadline, request.signal]);
    try {
      const res = await this.#options.fetch(`${this.#options.registry}/${path}`, {
        method: "GET",
        // No credentials of any kind: the registry is public and read-only.
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (res.status === 404) return null;
      if (res.status !== 200) return "transient";
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > this.#options.maxResponseBytes) return null;
      const body = await res.text();
      if (body.length > this.#options.maxResponseBytes) return null;
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
