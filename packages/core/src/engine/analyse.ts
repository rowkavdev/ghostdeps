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
 *   In-process timeouts bound async waits only; the worker-thread tier
 *   (isolated.ts, #90) preempts synchronous work and caps heap.
 * - Output is deterministic: the same facts always produce the same result.
 * - Recommendation policy lives in core and is injected here; adapters report facts.
 */
import { type EcosystemAdapter } from "../adapter.js";
import { normaliseAnalysisResult } from "../report/json.js";
import type {
  AnalysisResult,
  Dependency,
  DependencyGraph,
  Finding,
  NetworkPolicy,
  ProjectRef,
  RepositoryHandle,
  Usage,
} from "../types/index.js";
import {
  adapterFailure,
  describeError,
  detectionConfidence,
  runAdapter,
  DEFAULT_DETECTION_THRESHOLD,
  type AdapterOutcome,
} from "./run-adapter.js";

export { detectionConfidence, DEFAULT_DETECTION_THRESHOLD };

/**
 * Per-adapter stage timeout. In-process it bounds async waits only:
 * synchronous CPU work inside an adapter cannot be preempted in-process,
 * and timed-out work is asked to stop via AdapterContext.signal rather
 * than killed. The worker-thread tier (isolated.ts) enforces it
 * preemptively with terminate().
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

/**
 * True when a value is plain JSON data: null, booleans, strings, finite
 * numbers, arrays and plain objects, nested at most `depth` levels. The
 * JSON reporter (renderJsonReport) throws on anything else (#98), so
 * findings are checked here before they reach it: one bad finding must not
 * abort the whole analysis. The canonical sort itself never throws (#102).
 */
function isPlainData(value: unknown, depth = 32): boolean {
  if (depth < 0) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainData(item, depth - 1));
  // Sets are accepted because the reporter's canonical() serialises them as arrays.
  if (value instanceof Set) return [...value].every((item) => isPlainData(item, depth - 1));
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(
      (item) => item === undefined || isPlainData(item, depth - 1),
    );
  }
  return false;
}

/**
 * Turn per-adapter outcomes (however they were produced - in-process or in
 * workers) into one AnalysisResult: merge facts, apply recommendation
 * policy, normalise ordering. Shared by analyse.ts and isolated.ts.
 */
export async function assembleAnalysisResult(
  outcomes: readonly AdapterOutcome[],
  recommend?: RecommendationPolicy,
): Promise<AnalysisResult> {
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

  if (recommend) {
    try {
      const proposed = await recommend({
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

  return assembleAnalysisResult(outcomes, options.recommend);
}
