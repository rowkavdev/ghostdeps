/**
 * The analysis engine: the single entry point the CLI (#39) and the GitHub
 * App check reporter (#32) call. It runs ecosystem detection, executes the
 * adapters that pass the threshold, collects facts, applies recommendation
 * policy and emits one AnalysisResult.
 *
 * Rules:
 * - Only adapters whose detection passes the threshold run (ADR 0002).
 * - Missing capabilities are skipped, never assumed.
 * - Adapters run in parallel. One adapter failing or timing out becomes an
 *   "info" finding with stated limitations; it never crashes the run.
 *   Timeouts bound async waits only (see DEFAULT_ADAPTER_TIMEOUT_MS, #90).
 * - Output is deterministic: the same facts always produce the same result.
 * - Recommendation policy lives in core and is injected here; adapters report facts.
 */
import { adapterApiVersion, type EcosystemAdapter } from "../adapter.js";
import { normaliseAnalysisResult } from "../report/json.js";
import type {
  AnalysisResult,
  Confidence,
  Dependency,
  DependencyGraph,
  Evidence,
  Finding,
  NetworkPolicy,
  ProjectRef,
  RepositoryHandle,
  Usage,
} from "../types/index.js";

/** Detection confidence an adapter must reach to run. Shared across adapters. */
export const DEFAULT_DETECTION_THRESHOLD = 0.5;

/**
 * Per-adapter stage timeout. Bounds async waits only: synchronous CPU work
 * inside an adapter cannot be preempted in-process, and timed-out work is
 * asked to stop via AdapterContext.signal rather than killed. Preemptive
 * worker isolation is tracked in #90.
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 60_000;

/** Maximum concurrent findUsage calls per adapter. */
export const DEFAULT_USAGE_CONCURRENCY = 8;

/** Facts collected from adapters, handed to recommendation policy. */
export interface RecommendationInput {
  dependencies: readonly Dependency[];
  usages: readonly Usage[];
  graphs: readonly DependencyGraph[];
  /** Ecosystems whose adapter had usage analysis; policy must not call deps "unused" elsewhere. */
  usageAnalysedEcosystems: ReadonlySet<string>;
}

/** Core-owned policy that turns facts into findings (#56 and friends plug in here). */
export type RecommendationPolicy = (input: RecommendationInput) => Finding[] | Promise<Finding[]>;

export interface AnalyseOptions {
  adapters: readonly EcosystemAdapter[];
  /** Defaults to offline. */
  network?: NetworkPolicy;
  detectionThreshold?: number;
  adapterTimeoutMs?: number;
  /** Maximum concurrent findUsage calls per adapter. */
  usageConcurrency?: number;
  /** Omit to emit facts only (no recommendation findings). */
  recommend?: RecommendationPolicy;
}

class StageTimeout extends Error {
  constructor(readonly stage: string) {
    super(`timed out during ${stage}`);
  }
}

async function withTimeout<T>(
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
async function mapBounded<T, R>(
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

/**
 * True when a value is plain JSON data: null, booleans, strings, finite
 * numbers, arrays and plain objects, nested at most `depth` levels. The
 * reporter's canonical ordering throws on anything else (#98), so findings
 * are checked here before they reach it: one bad finding must not abort
 * the whole analysis.
 */
function isPlainData(value: unknown, depth = 32): boolean {
  if (depth < 0) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainData(item, depth - 1));
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(
      (item) => item === undefined || isPlainData(item, depth - 1),
    );
  }
  return false;
}

function majorOf(version: string): string | undefined {
  return /^(\d+)\.(\d+)\.\d+$/.exec(version)?.slice(1, 3).join(".");
}

/**
 * Pre-1.0, a minor bump is breaking (semver convention), so compatibility
 * compares major.minor; from 1.0 it could compare major only.
 */
function apiCompatible(version: string): boolean {
  const theirs = majorOf(version);
  return theirs !== undefined && theirs === majorOf(adapterApiVersion);
}

/** Map numeric detection confidence onto the shared Confidence scale. */
export function detectionConfidence(value: number): Confidence {
  if (value >= 0.8) return "high";
  if (value >= DEFAULT_DETECTION_THRESHOLD) return "medium";
  return "low";
}

function describeError(error: unknown): string {
  if (error instanceof StageTimeout) return error.message;
  // Adapter error text can echo repository content; keep it short and plain.
  const message = error instanceof Error ? error.message : String(error);
  return `failed: ${message.replace(/\s+/g, " ").slice(0, 200)}`;
}

function adapterFailure(adapter: EcosystemAdapter, stage: string, error: unknown): Finding {
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

interface AdapterOutcome {
  ecosystem: string;
  detected?: { confidence: Confidence; evidence: Evidence[]; projects: ProjectRef[] };
  dependencies: Dependency[];
  usages: Usage[];
  graphs: DependencyGraph[];
  usageAnalysed: boolean;
  findings: Finding[];
}

async function runAdapter(
  adapter: EcosystemAdapter,
  repository: RepositoryHandle,
  network: NetworkPolicy,
  threshold: number,
  timeoutMs: number,
  usageConcurrency: number,
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
      ? withTimeout(
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
        )
      : Promise.resolve();

  const usageStage =
    adapter.capabilities.has("usageAnalysis") && adapter.findUsage
      ? withTimeout(
          async () => {
            const perDependency = await mapBounded(
              outcome.dependencies,
              usageConcurrency,
              controller.signal,
              (dep) => adapter.findUsage!(context, dep),
            );
            return perDependency.flat();
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
        )
      : Promise.resolve();

  await Promise.all([graphStage, usageStage]);
  return outcome;
}

/** Analyse a repository through the given adapters and return one AnalysisResult. */
export async function analyseRepository(
  repository: RepositoryHandle,
  options: AnalyseOptions,
): Promise<AnalysisResult> {
  const network = options.network ?? { mode: "offline" };
  const threshold = options.detectionThreshold ?? DEFAULT_DETECTION_THRESHOLD;
  const timeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const usageConcurrency = options.usageConcurrency ?? DEFAULT_USAGE_CONCURRENCY;

  const outcomes = await Promise.all(
    options.adapters.map((adapter) =>
      runAdapter(adapter, repository, network, threshold, timeoutMs, usageConcurrency).catch(
        (error: unknown): AdapterOutcome => ({
          ecosystem: adapter.ecosystem,
          dependencies: [],
          usages: [],
          graphs: [],
          usageAnalysed: false,
          findings: [adapterFailure(adapter, "run", error)],
        }),
      ),
    ),
  );

  const projects = new Map<string, ProjectRef>();
  const dependencies: Dependency[] = [];
  const usages: Usage[] = [];
  const graphs: DependencyGraph[] = [];
  const findings: Finding[] = [];
  const detected: AnalysisResult["detected"] = [];
  const surface: AnalysisResult["surface"] = [];
  const usageAnalysedEcosystems = new Set<string>();

  for (const outcome of outcomes) {
    findings.push(...outcome.findings);
    if (!outcome.detected) continue;
    for (const project of outcome.detected.projects) {
      projects.set(`${project.path}\0${project.ecosystem}`, project);
    }
    dependencies.push(...outcome.dependencies);
    usages.push(...outcome.usages);
    graphs.push(...outcome.graphs);
    if (outcome.usageAnalysed) usageAnalysedEcosystems.add(outcome.ecosystem);
    detected.push({
      ecosystem: outcome.ecosystem,
      confidence: outcome.detected.confidence,
      evidence: outcome.detected.evidence,
    });
    const transitive = new Set(outcome.graphs.flatMap((g) => g.nodes.map((n) => n.name)));
    surface.push({
      ecosystem: outcome.ecosystem,
      direct: new Set(outcome.dependencies.map((d) => d.name)).size,
      transitive: transitive.size,
    });
  }

  if (options.recommend) {
    try {
      const proposed = await options.recommend({
        dependencies,
        usages,
        graphs,
        usageAnalysedEcosystems,
      });
      const rejected = proposed.filter((finding) => !isPlainData(finding));
      findings.push(...proposed.filter((finding) => isPlainData(finding)));
      if (rejected.length > 0) {
        findings.push({
          kind: "info",
          summary: `recommendation policy returned ${rejected.length} finding(s) that are not plain data`,
          recommendation: "Manual review recommended; those findings were dropped.",
          evidence: [{ kind: "policy-error", statement: "non-plain finding rejected" }],
          confidence: "low",
          limitations: ["Some recommendations are missing from this result."],
          affectedFiles: [],
        });
      }
    } catch (error) {
      findings.push({
        kind: "info",
        summary: `recommendation policy ${describeError(error)}`,
        recommendation: "Manual review recommended; no recommendations were produced.",
        evidence: [{ kind: "policy-error", statement: "recommendation stage failed" }],
        confidence: "low",
        limitations: ["Findings other than facts and adapter notes are missing."],
        affectedFiles: [],
      });
    }
  }

  // One canonical ordering for the engine and the JSON reporter (#71).
  return normaliseAnalysisResult({
    schemaVersion: 1,
    projects: [...projects.values()],
    dependencies,
    usages,
    findings,
    detected,
    surface,
  });
}
