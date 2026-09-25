/**
 * Same-SHA re-run result cache (#174, option B). A re-run of a check for the
 * same head SHA, base SHA and source-only flag reuses the finished analysis
 * instead of downloading and analysing again, so its output equals the
 * first run's by construction. Only clean analyses are stored: nothing that
 * failed, fell back, skipped a step or saw an adapter error, because a re-run
 * is how a user retries those. It holds the rendered check output, not the
 * analysis, bounded by a byte budget and per repository. In-process, so it
 * never outlives the code that produced an entry.
 */
import { adapterApiVersion, jsonSchemaVersion, type AnalysisResult } from "@ghostdeps/core";
import type { CheckOutput } from "@ghostdeps/checks-renderer";
import type { AnalysisJob } from "../jobs.js";

/**
 * What a re-run needs: the check output the first run posted. Much smaller
 * than the full analysis (GitHub caps the summary and annotations), and
 * reposting it gives the same output by construction.
 */
export type CachedCheck = CheckOutput;

export interface ResultCacheOptions {
  /**
   * Total size budget in bytes, estimated from each entry's serialised
   * size; least recently used entries go first. Default 16 MiB.
   */
  readonly maxBytes?: number;
  /** Entries kept per repository (least recently used go first). Default 4. */
  readonly maxPerRepository?: number;
}

/** Everything else the analysis depends on: worker config and code versions. */
export interface ResultCacheContext {
  readonly adapterModules: readonly string[];
  readonly recommend: boolean;
  /** Install footprints on (#174). */
  readonly footprint?: boolean;
  readonly scan?: unknown;
}

// Workspace packages are all 0.0.0, so the code identity is the contract
// versions plus the process: an in-process cache can't span two builds.
const CODE_VERSION = `core-schema:${jsonSchemaVersion}|adapter-api:${adapterApiVersion}`;

function baseOf(job: AnalysisJob): string {
  if (job.trigger.kind === "pull_request") return job.trigger.baseSha;
  if (job.trigger.kind === "rerequested") return job.trigger.pullRequest?.baseSha ?? "";
  return "";
}

function sourceOnlyOf(job: AnalysisJob): boolean {
  if (job.trigger.kind === "pull_request") return job.trigger.sourceOnly === true;
  if (job.trigger.kind === "rerequested") return job.trigger.pullRequest?.sourceOnly === true;
  return false;
}

/** The cache key: repository id + head SHA + base SHA + source-only flag + versions + policy config. */
export function resultCacheKey(job: AnalysisJob, context: ResultCacheContext): string {
  return JSON.stringify([
    job.headSha,
    baseOf(job),
    sourceOnlyOf(job),
    CODE_VERSION,
    context.recommend ? "recommend:policy" : "recommend:off",
    context.footprint ? "footprint:npm" : "footprint:off",
    context.adapterModules,
    context.scan ?? null,
  ]);
}

/** Adapter failures and timeouts are transient: never cache them. */
export function isCacheable(result: AnalysisResult, appNotes: readonly string[]): boolean {
  if (appNotes.length > 0) return false;
  return !result.findings.some((f) => f.evidence.some((e) => e.kind === "adapter-error"));
}

interface Entry {
  readonly repositoryId: number;
  readonly value: CachedCheck;
  readonly bytes: number;
}

/** Serialised size; JS strings are UTF-16, so count two bytes per code unit. */
function sizeOf(value: CachedCheck): number {
  return JSON.stringify(value).length * 2;
}

export class ResultCache {
  // Map order is recency order: the first entry is the least recently used.
  private readonly entries = new Map<string, Entry>();
  private readonly perRepository = new Map<number, number>();
  private readonly maxBytes: number;
  private readonly maxPerRepository: number;
  private totalBytes = 0;

  constructor(options: ResultCacheOptions = {}) {
    this.maxBytes = Math.max(0, options.maxBytes ?? 16 * 1024 * 1024);
    this.maxPerRepository = Math.max(1, options.maxPerRepository ?? 4);
  }

  get(repositoryId: number, key: string): CachedCheck | undefined {
    const id = JSON.stringify([repositoryId, key]);
    const hit = this.entries.get(id);
    if (!hit) return undefined;
    this.entries.delete(id);
    this.entries.set(id, hit);
    return hit.value;
  }

  set(repositoryId: number, key: string, value: CachedCheck): void {
    const id = JSON.stringify([repositoryId, key]);
    this.remove(id);
    const bytes = sizeOf(value);
    // An entry bigger than the whole budget is never stored.
    if (bytes > this.maxBytes) return;
    this.entries.set(id, { repositoryId, value, bytes });
    this.totalBytes += bytes;
    this.perRepository.set(repositoryId, (this.perRepository.get(repositoryId) ?? 0) + 1);
    if ((this.perRepository.get(repositoryId) ?? 0) > this.maxPerRepository) {
      for (const [oldId, entry] of this.entries) {
        if (entry.repositoryId === repositoryId) {
          this.remove(oldId);
          break;
        }
      }
    }
    while (this.totalBytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value as string);
    }
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.bytes;
    const left = (this.perRepository.get(entry.repositoryId) ?? 1) - 1;
    if (left > 0) this.perRepository.set(entry.repositoryId, left);
    else this.perRepository.delete(entry.repositoryId);
  }

  /** Entries held, for tests and logs. */
  get size(): number {
    return this.entries.size;
  }

  /** Estimated bytes held, for tests and logs. */
  get bytes(): number {
    return this.totalBytes;
  }
}
