/**
 * Worker-thread adapter isolation (#90): the preemptive tier of the
 * analysis engine. Each adapter runs in its own Worker with a heap ceiling
 * (resourceLimits) and is terminate()d when a stage outlives
 * adapterTimeoutMs - synchronous CPU work (a pathological JSON.parse, a
 * busy loop) cannot escape the way it can in-process, and a memory-hungry
 * adapter dies on its own heap ceiling instead of taking the run down.
 * Both failure modes become the same info findings the in-process tier
 * emits, so downstream consumers see one contract.
 *
 * Adapters are referenced by module specifier (functions cannot cross the
 * thread boundary); the worker imports the module and resolves its default
 * or named "adapter" export. The handle is rebuilt inside the worker from
 * the scan - cheap while adapter count is small, and it keeps untrusted
 * parsing out of the main thread entirely.
 */
import { Worker } from "node:worker_threads";
import type { AnalysisResult, NetworkPolicy } from "../types/index.js";
import {
  assembleAnalysisResult,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DEFAULT_USAGE_CONCURRENCY,
  type RecommendationPolicy,
} from "./analyse.js";
import {
  adapterFailure,
  StageTimeout,
  DEFAULT_DETECTION_THRESHOLD,
  type AdapterOutcome,
} from "./run-adapter.js";
import type { FsRepositoryHandle } from "./scanner/handle.js";

/** Default per-worker old-generation heap ceiling. */
export const DEFAULT_ADAPTER_HEAP_MB = 512;

/**
 * Main-side caps on what a worker may post back (#123). An adapter can stay
 * under its own heap ceiling and still structured-clone a huge outcome into
 * the main heap, so counts are capped here and overflow becomes a
 * limitation on the outcome - the same "oversize surfaces as evidence"
 * rule as the byte ceilings in limits.ts.
 */
export const OUTCOME_CAPS = Object.freeze({
  maxDependencies: 10_000,
  maxUsages: 50_000,
  /** Total graph nodes across all of one adapter's graphs. */
  maxGraphNodes: 100_000,
  /** Evidence entries kept per finding. */
  maxEvidencePerFinding: 100,
});

export interface IsolatedAnalyseOptions {
  /** Module specifiers; each module's default or "adapter" export is the adapter. */
  adapters: readonly string[];
  /**
   * Drain for adapter stdout/stderr lines. Worker output is NEVER inherited
   * by the parent process (it would corrupt `ghostdeps scan --json`); it is
   * captured and passed here instead. Omit to discard it.
   */
  debugLog?: (line: string) => void;
  /** Defaults to offline. */
  network?: NetworkPolicy;
  detectionThreshold?: number;
  /** Per-stage wall-clock budget; a stage past it is terminate()d. */
  adapterTimeoutMs?: number;
  usageConcurrency?: number;
  /** Per-worker heap ceiling in MiB (old generation). */
  adapterHeapMb?: number;
  /** Omit to emit facts only (no recommendation findings). */
  recommend?: RecommendationPolicy;
}

/** Truncate a worker-posted outcome to OUTCOME_CAPS, recording overflow as limitations. */
export function capOutcome(outcome: AdapterOutcome): AdapterOutcome {
  const limitations: string[] = [];
  let dependencies = outcome.dependencies;
  if (dependencies.length > OUTCOME_CAPS.maxDependencies) {
    limitations.push(
      `Adapter posted ${dependencies.length} dependencies; capped at ${OUTCOME_CAPS.maxDependencies}.`,
    );
    dependencies = dependencies.slice(0, OUTCOME_CAPS.maxDependencies);
  }
  let usages = outcome.usages;
  if (usages.length > OUTCOME_CAPS.maxUsages) {
    limitations.push(
      `Adapter posted ${usages.length} usages; capped at ${OUTCOME_CAPS.maxUsages}.`,
    );
    usages = usages.slice(0, OUTCOME_CAPS.maxUsages);
  }
  let graphs = outcome.graphs;
  const totalNodes = graphs.reduce((sum, graph) => sum + graph.nodes.length, 0);
  if (totalNodes > OUTCOME_CAPS.maxGraphNodes) {
    limitations.push(
      `Adapter posted ${totalNodes} graph nodes; capped at ${OUTCOME_CAPS.maxGraphNodes}.`,
    );
    const kept: typeof graphs = [];
    let budget: number = OUTCOME_CAPS.maxGraphNodes;
    for (const graph of graphs) {
      if (budget <= 0) break;
      if (graph.nodes.length <= budget) {
        kept.push(graph);
        budget -= graph.nodes.length;
      } else {
        kept.push({ ...graph, nodes: graph.nodes.slice(0, budget) });
        budget = 0;
      }
    }
    graphs = kept;
  }
  let findings = outcome.findings;
  let evidenceTrimmed = false;
  findings = findings.map((finding) => {
    if (finding.evidence.length <= OUTCOME_CAPS.maxEvidencePerFinding) return finding;
    evidenceTrimmed = true;
    return { ...finding, evidence: finding.evidence.slice(0, OUTCOME_CAPS.maxEvidencePerFinding) };
  });
  if (evidenceTrimmed)
    limitations.push(
      `Finding evidence capped at ${OUTCOME_CAPS.maxEvidencePerFinding} entries each.`,
    );
  if (limitations.length === 0) return outcome;
  return {
    ...outcome,
    dependencies,
    usages,
    graphs,
    findings: [
      ...findings,
      {
        kind: "info",
        summary: `${outcome.ecosystem} adapter result truncated to size ceilings`,
        recommendation:
          "Manual review recommended; the adapter returned more data than the engine keeps.",
        evidence: [{ kind: "outcome-capped", statement: limitations.join(" ") }],
        confidence: "low",
        limitations,
        affectedFiles: [],
      },
    ],
  };
}

interface WorkerMessage {
  type: "loaded" | "stage" | "outcome" | "run-error";
  ecosystem?: string;
  stage?: string;
  outcome?: AdapterOutcome;
  message?: string;
}

function emptyOutcome(
  ecosystem: string,
  finding: ReturnType<typeof adapterFailure>,
): AdapterOutcome {
  return {
    ecosystem,
    dependencies: [],
    usages: [],
    graphs: [],
    usageAnalysed: false,
    findings: [finding],
  };
}

/** Run one adapter module in a worker and resolve its outcome; never rejects. */
export function runAdapterIsolated(
  specifier: string,
  repository: FsRepositoryHandle,
  network: NetworkPolicy,
  threshold: number,
  timeoutMs: number,
  usageConcurrency: number,
  heapMb: number,
  debugLog?: (line: string) => void,
): Promise<AdapterOutcome> {
  return new Promise((resolve) => {
    // The name shown in findings before the worker tells us the ecosystem.
    let ecosystem = specifier;
    // The stage the watchdog is currently timing; "run" before the first boundary.
    let stage = "run";
    let settled = false;

    const worker = new Worker(new URL("./adapter-worker.js", import.meta.url), {
      workerData: {
        specifier,
        scan: repository.scan,
        network,
        detectionThreshold: threshold,
        adapterTimeoutMs: timeoutMs,
        usageConcurrency,
      },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
      // Capture adapter output instead of inheriting the parent's streams:
      // a stray adapter log line must not corrupt JSON output on stdout.
      stdout: true,
      stderr: true,
    });

    // Drain both captured streams as lines, tagged with the adapter name.
    if (debugLog !== undefined) {
      for (const [stream, tag] of [
        [worker.stdout, "stdout"],
        [worker.stderr, "stderr"],
      ] as const) {
        let pending = "";
        stream?.on("data", (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) debugLog(`${ecosystem} ${tag}: ${line}`);
        });
        stream?.on("end", () => {
          if (pending.length > 0) debugLog(`${ecosystem} ${tag}: ${pending}`);
        });
      }
    } else {
      // Discard, but still read so the worker never blocks on a full pipe.
      worker.stdout?.resume();
      worker.stderr?.resume();
    }

    let watchdog: NodeJS.Timeout;
    const kill = (): void => {
      void worker.terminate();
    };
    // A worker that posted an outcome resolves at exit, so captured
    // stdout/stderr has drained to debugLog by the time callers see the
    // result. Failure paths (watchdog, error, non-zero exit) resolve now.
    let completed: AdapterOutcome | undefined;
    const finish = (outcome: AdapterOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(outcome);
    };

    // A stage past its budget (plus reporting headroom) means the worker's
    // event loop is stuck in synchronous work: async waits are bounded
    // inside the worker by the same timeout, so a healthy worker always
    // reports first. The watchdog must not keep the process alive.
    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        kill();
        finish(
          emptyOutcome(ecosystem, adapterFailure({ ecosystem }, stage, new StageTimeout(stage))),
        );
      }, timeoutMs + WATCHDOG_GRACE_MS);
      watchdog.unref();
    };
    armWatchdog();

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "loaded" && message.ecosystem !== undefined) {
        ecosystem = message.ecosystem;
      } else if (message.type === "stage" && message.stage !== undefined) {
        stage = message.stage;
        armWatchdog();
      } else if (message.type === "outcome" && message.outcome !== undefined) {
        completed = capOutcome(message.outcome);
      } else if (message.type === "run-error") {
        finish(
          emptyOutcome(
            ecosystem,
            adapterFailure({ ecosystem }, stage, new Error(message.message ?? "worker failed")),
          ),
        );
      }
    });
    // Heap-ceiling death and uncaught worker exceptions arrive here.
    worker.on("error", (error: Error) => {
      kill();
      finish(emptyOutcome(ecosystem, adapterFailure({ ecosystem }, stage, error)));
    });
    worker.on("exit", (code: number) => {
      if (settled) return;
      if (code === 0 && completed !== undefined) {
        finish(completed);
      } else if (code === 0) {
        // Clean exit without an outcome should not happen; report it.
        finish(
          emptyOutcome(
            ecosystem,
            adapterFailure({ ecosystem }, stage, new Error("worker exited without a result")),
          ),
        );
      } else {
        finish(
          emptyOutcome(
            ecosystem,
            adapterFailure({ ecosystem }, stage, new Error(`worker exited with code ${code}`)),
          ),
        );
      }
    });
  });
}

/**
 * Headroom added to the watchdog past the stage budget, so a healthy
 * worker whose async wait times out at adapterTimeoutMs reports its own
 * stage timeout (keeping earlier stage facts) instead of being killed
 * mid-report. Only synchronous stalls actually wait for the watchdog.
 */
const WATCHDOG_GRACE_MS = 1_000;

/**
 * Analyse a repository with every adapter isolated in its own worker
 * thread. Same AnalysisResult as analyseRepository; same info-finding
 * contract for adapter failures. Requires an FsRepositoryHandle: the scan
 * is cloned into each worker, which rebuilds its own handle.
 */
export async function analyseRepositoryIsolated(
  repository: FsRepositoryHandle,
  options: IsolatedAnalyseOptions,
): Promise<AnalysisResult> {
  const network = options.network ?? { mode: "offline" };
  const threshold = options.detectionThreshold ?? DEFAULT_DETECTION_THRESHOLD;
  const timeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const usageConcurrency = options.usageConcurrency ?? DEFAULT_USAGE_CONCURRENCY;
  const heapMb = options.adapterHeapMb ?? DEFAULT_ADAPTER_HEAP_MB;

  const outcomes = await Promise.all(
    options.adapters.map((specifier) =>
      runAdapterIsolated(
        specifier,
        repository,
        network,
        threshold,
        timeoutMs,
        usageConcurrency,
        heapMb,
        options.debugLog,
      ),
    ),
  );

  return assembleAnalysisResult(outcomes, options.recommend);
}
