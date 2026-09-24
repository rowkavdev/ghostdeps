/**
 * Same-SHA re-run result cache (#174, option B). A re-run of a check for the
 * same head SHA, base SHA and source-only flag reuses the finished analysis
 * instead of downloading and analysing again, so its output equals the
 * first run's by construction. Only clean analyses are stored: nothing that
 * failed, fell back, skipped a step or saw an adapter error, because a re-run
 * is how a user retries those. In-process and bounded per repository; it
 * never outlives the code that produced an entry.
 */
import { adapterApiVersion, jsonSchemaVersion, type AnalysisResult } from "@ghostdeps/core";
import type { AddedLines } from "../checks/diff.js";
import type { AnalysisJob } from "../jobs.js";

export interface CachedAnalysis {
  readonly result: AnalysisResult;
  readonly added: AddedLines;
}

export interface ResultCacheOptions {
  /** Entries kept per repository (least recently used go first). Default 16. */
  readonly maxPerRepository?: number;
  /** Repositories kept (least recently used go first). Default 256. */
  readonly maxRepositories?: number;
}

/** Everything else the analysis depends on: worker config and code versions. */
export interface ResultCacheContext {
  readonly adapterModules: readonly string[];
  readonly recommend: boolean;
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
    context.recommend ? "recommend:default" : "recommend:off",
    context.adapterModules,
    context.scan ?? null,
  ]);
}

/** Adapter failures and timeouts are transient: never cache them. */
export function isCacheable(result: AnalysisResult, appNotes: readonly string[]): boolean {
  if (appNotes.length > 0) return false;
  return !result.findings.some((f) => f.evidence.some((e) => e.kind === "adapter-error"));
}

export class ResultCache {
  private readonly repos = new Map<number, Map<string, CachedAnalysis>>();
  private readonly maxPerRepository: number;
  private readonly maxRepositories: number;

  constructor(options: ResultCacheOptions = {}) {
    this.maxPerRepository = Math.max(1, options.maxPerRepository ?? 16);
    this.maxRepositories = Math.max(1, options.maxRepositories ?? 256);
  }

  get(repositoryId: number, key: string): CachedAnalysis | undefined {
    const entries = this.repos.get(repositoryId);
    const hit = entries?.get(key);
    if (!entries || !hit) return undefined;
    // Refresh recency for both the repository and the entry.
    this.repos.delete(repositoryId);
    this.repos.set(repositoryId, entries);
    entries.delete(key);
    entries.set(key, hit);
    return hit;
  }

  set(repositoryId: number, key: string, value: CachedAnalysis): void {
    let entries = this.repos.get(repositoryId);
    if (entries) this.repos.delete(repositoryId);
    else entries = new Map();
    this.repos.set(repositoryId, entries);
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > this.maxPerRepository) {
      entries.delete(entries.keys().next().value as string);
    }
    while (this.repos.size > this.maxRepositories) {
      this.repos.delete(this.repos.keys().next().value as number);
    }
  }

  /** Entries held, for tests and logs. */
  get size(): number {
    let n = 0;
    for (const entries of this.repos.values()) n += entries.size;
    return n;
  }
}
