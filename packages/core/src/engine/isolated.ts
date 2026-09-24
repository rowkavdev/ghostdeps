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

export interface IsolatedAnalyseOptions {
  /** Module specifiers; each module's default or "adapter" export is the adapter. */
  adapters: readonly string[];
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
    });

    let watchdog: NodeJS.Timeout;
    const finish = (outcome: AdapterOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      void worker.terminate();
      resolve(outcome);
    };

    // A stage past its budget (plus reporting headroom) means the worker's
    // event loop is stuck in synchronous work: async waits are bounded
    // inside the worker by the same timeout, so a healthy worker always
    // reports first. The watchdog must not keep the process alive.
    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
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
        finish(message.outcome);
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
      finish(emptyOutcome(ecosystem, adapterFailure({ ecosystem }, stage, error)));
    });
    worker.on("exit", (code: number) => {
      if (code !== 0 && !settled) {
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
      ),
    ),
  );

  return assembleAnalysisResult(outcomes, options.recommend);
}
