/**
 * Per-adapter stage execution, shared by the in-process engine
 * (analyse.ts) and the worker-thread entry (adapter-worker.ts, #90). The
 * logic must not fork: both isolation tiers run adapters through the same
 * stage sequence, error-isolation contract and timeout shape.
 */
import { adapterApiVersion, normaliseUsageResult, type EcosystemAdapter } from "../adapter.js";
import type {
  Dependency,
  DependencyGraph,
  Evidence,
  Finding,
  NetworkPolicy,
  ProjectRef,
  RepositoryHandle,
  Usage,
} from "../types/index.js";

export class StageTimeout extends Error {
  constructor(readonly stage: string) {
    super(`timed out during ${stage}`);
  }
}

export async function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  stage: string,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new StageTimeout(stage);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Map with at most `limit` calls in flight; stops starting new work once aborted. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      if (signal.aborted) throw signal.reason;
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function majorOf(version: string): string | undefined {
  return /^(\d+)\.(\d+)\.\d+$/.exec(version)?.slice(1, 3).join(".");
}

/**
 * Pre-1.0, a minor bump is breaking (semver convention), so compatibility
 * compares major.minor; from 1.0 it could compare major only.
 */
export function apiCompatible(version: string): boolean {
  const theirs = majorOf(version);
  return theirs !== undefined && theirs === majorOf(adapterApiVersion);
}

/** Map numeric detection confidence onto the shared Confidence scale. */
export function detectionConfidence(value: number): "high" | "medium" | "low" {
  if (value >= 0.8) return "high";
  if (value >= DEFAULT_DETECTION_THRESHOLD) return "medium";
  return "low";
}

/** Detection confidence an adapter must reach to run. Shared across adapters. */
export const DEFAULT_DETECTION_THRESHOLD = 0.5;

export function describeError(error: unknown): string {
  if (error instanceof StageTimeout) return error.message;
  // Adapter error text can echo repository content; keep it short and plain.
  const message = error instanceof Error ? error.message : String(error);
  return `failed: ${message.replace(/\s+/g, " ").slice(0, 200)}`;
}

export function adapterFailure(
  adapter: { ecosystem: string },
  stage: string,
  error: unknown,
): Finding {
  return {
    kind: "info",
    summary: `${adapter.ecosystem} analysis incomplete: ${stage} ${describeError(error)}`,
    recommendation: "Manual review recommended for this ecosystem.",
    evidence: [{ kind: "adapter-error", statement: `${adapter.ecosystem} adapter ${stage} stage` }],
    confidence: "low",
    limitations: [`Results for ${adapter.ecosystem} may be missing or partial.`],
    affectedFiles: [],
  };
}

export interface AdapterOutcome {
  ecosystem: string;
  detected?: {
    confidence: "high" | "medium" | "low";
    evidence: Evidence[];
    projects: ProjectRef[];
  };
  dependencies: Dependency[];
  usages: Usage[];
  graphs: DependencyGraph[];
  usageAnalysed: boolean;
  findings: Finding[];
}

/**
 * Called as each adapter stage begins. The in-process engine ignores it;
 * the worker-thread tier forwards it to the main thread, whose watchdog
 * terminates the worker when a stage outlives the timeout (synchronous
 * work cannot be preempted from inside the worker).
 */
export type StageObserver = (stage: string) => void;

export async function runAdapter(
  adapter: EcosystemAdapter,
  repository: RepositoryHandle,
  network: NetworkPolicy,
  threshold: number,
  timeoutMs: number,
  usageConcurrency: number,
  onStage?: StageObserver,
): Promise<AdapterOutcome> {
  const outcome: AdapterOutcome = {
    ecosystem: adapter.ecosystem,
    dependencies: [],
    usages: [],
    graphs: [],
    usageAnalysed: false,
    findings: [],
  };
  const controller = new AbortController();
  const context = { repository, network, signal: controller.signal };

  if (!apiCompatible(adapter.apiVersion)) {
    outcome.findings.push({
      kind: "info",
      summary: `${adapter.ecosystem} adapter skipped: API ${adapter.apiVersion} is incompatible with core ${adapterApiVersion}`,
      recommendation: "Update the adapter to the current adapter API.",
      evidence: [{ kind: "adapter-api-mismatch", statement: `adapter API ${adapter.apiVersion}` }],
      confidence: "high",
      limitations: [`${adapter.ecosystem} was not analysed.`],
      affectedFiles: [],
    });
    return outcome;
  }

  let detection;
  try {
    onStage?.("detection");
    detection = await withTimeout(
      () => adapter.detect(context),
      timeoutMs,
      "detection",
      controller,
    );
  } catch (error) {
    outcome.findings.push(adapterFailure(adapter, "detection", error));
    return outcome;
  }
  const score = Number.isFinite(detection.confidence) ? detection.confidence : 0;
  if (score < threshold) return outcome;

  outcome.detected = {
    confidence: detectionConfidence(score),
    evidence: [...detection.evidence],
    projects: [...detection.projects],
  };

  try {
    onStage?.("dependency listing");
    outcome.dependencies = await withTimeout(
      () => adapter.listDirectDependencies(context, detection.projects),
      timeoutMs,
      "dependency listing",
      controller,
    );
  } catch (error) {
    outcome.findings.push(adapterFailure(adapter, "dependency listing", error));
    return outcome;
  }

  const graphStage =
    adapter.capabilities.has("dependencyGraph") && adapter.buildDependencyGraph
      ? (() => {
          onStage?.("dependency graph");
          return withTimeout(
            () => adapter.buildDependencyGraph!(context, detection.projects),
            timeoutMs,
            "dependency graph",
            controller,
          ).then(
            (graphs) => {
              outcome.graphs = graphs;
            },
            (error: unknown) => {
              outcome.findings.push(adapterFailure(adapter, "dependency graph", error));
            },
          );
        })()
      : Promise.resolve();

  const usageStage =
    adapter.capabilities.has("usageAnalysis") && adapter.findUsage
      ? (() => {
          onStage?.("usage analysis");
          return withTimeout(
            async () => {
              const perDependency = await mapBounded(
                outcome.dependencies,
                usageConcurrency,
                controller.signal,
                async (dep) => normaliseUsageResult(await adapter.findUsage!(context, dep)),
              );
              // referenceAnalysisComplete is consumed by the policy engine (#121).
              return perDependency.flatMap((result) => result.usages);
            },
            timeoutMs,
            "usage analysis",
            controller,
          ).then(
            (usages) => {
              outcome.usages = usages;
              outcome.usageAnalysed = true;
            },
            (error: unknown) => {
              outcome.findings.push(adapterFailure(adapter, "usage analysis", error));
            },
          );
        })()
      : Promise.resolve();

  await Promise.all([graphStage, usageStage]);
  return outcome;
}
