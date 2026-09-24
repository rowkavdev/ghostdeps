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
import { MAX_ADAPTER_NOTES } from "./adapter-notes.js";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { DependencyChange } from "../diff/dependency-changes.js";
import type {
  AnalysisResult,
  Finding,
  NetworkPolicy,
  PackageMetadataProvider,
  SourceLineChanges,
} from "../types/index.js";
import {
  assembleAnalysisResult,
  boundPullRequestSourceChanges,
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
 * Default cap on concurrently running adapter workers (#125): bounds total
 * adapter heap at 4 x adapterHeapMb (2 GiB with defaults) regardless of
 * adapter count.
 */
export const DEFAULT_MAX_PARALLEL_ADAPTERS = 4;

/**
 * Main-side caps on what a worker may post back (#123). An adapter can stay
 * under its own heap ceiling and still structured-clone a huge outcome; the
 * clone has already landed in the main heap by the time these caps run, so
 * they bound what flows downstream (policy, reporters), not peak main-heap
 * memory. Overflow becomes a limitation on the outcome - the same
 * "oversize surfaces as evidence" rule as the byte ceilings in limits.ts.
 */
export const OUTCOME_CAPS = Object.freeze({
  maxDependencies: 10_000,
  maxUsages: 50_000,
  /**
   * Total graph size across all of one adapter's graphs, counting each
   * graph's nodes plus its transitive-closure entries, so a graph with few
   * nodes but a huge closure is bounded too.
   */
  maxGraphNodes: 100_000,
  /** Evidence entries kept per finding. */
  maxEvidencePerFinding: 100,
  /** Findings kept per outcome. */
  maxFindings: 1_000,
});

export interface IsolatedAnalyseOptions {
  /** See AnalyseOptions.scanIncomplete. */
  scanIncomplete?: boolean;
  /** See AnalyseOptions.scanCompleteness. */
  scanCompleteness?: readonly Finding[];
  /**
   * Module specifiers; each module's default or "adapter" export is the
   * adapter. TRUSTED CONFIGURATION ONLY: every specifier goes to import()
   * inside the worker, so specifiers must come from CLI flags or project
   * config, never from repository content (manifests, lockfiles, source).
   * A file URL or absolute path that resolves inside the analysed
   * repository root is rejected with an info finding before a worker
   * starts, and relative specifiers are rejected outright (#150).
   */
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
  /**
   * Maximum adapter workers running at once (#125). Workers start in waves
   * of this size, so the worst-case adapter heap is
   * maxParallelAdapters x adapterHeapMb, not N x adapterHeapMb.
   */
  maxParallelAdapters?: number;
  /** Omit to emit facts only (no recommendation findings). */
  recommend?: RecommendationPolicy;
  /** See AnalyseOptions.metadata. Stays in the parent; workers never see it. */
  metadata?: PackageMetadataProvider;
  /** Dependency changes in the pull request under analysis; see AnalyseOptions. */
  pullRequestChanges?: readonly DependencyChange[];
}

/** Truncate a worker-posted outcome to OUTCOME_CAPS, recording overflow as limitations. */
const MAX_RAW_ADAPTER_NOTES = MAX_ADAPTER_NOTES * 4;

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
  let usageAnalysed = outcome.usageAnalysed;
  // Worker-posted: only an explicit true survives.
  let referenceAnalysed = outcome.referenceAnalysed === true;
  if (usages.length > OUTCOME_CAPS.maxUsages) {
    limitations.push(
      `Adapter posted ${usages.length} usages; capped at ${OUTCOME_CAPS.maxUsages}. Usage analysis is incomplete: dependencies past the cut must not read as unused.`,
    );
    usages = usages.slice(0, OUTCOME_CAPS.maxUsages);
    // A capped usage list is not a complete usage analysis. Leaving
    // usageAnalysed true would let policy read "analysed, no usage" for
    // every dependency whose only usage fell past the cut - exactly the
    // high-confidence false "unused" finding the engine guards against.
    usageAnalysed = false;
    referenceAnalysed = false;
  }
  let graphs = outcome.graphs;
  // Closure entries count against the same budget as nodes, and a graph
  // that does not fit whole is dropped rather than truncated: slicing nodes
  // would leave transitiveClosure pointing at removed nodes, an
  // inconsistent graph downstream code cannot trust.
  const graphSize = (graph: (typeof graphs)[number]): number =>
    graph.nodes.length +
    Object.values(graph.transitiveClosure).reduce((sum, names) => sum + names.length, 0);
  const totalGraphSize = graphs.reduce((sum, graph) => sum + graphSize(graph), 0);
  if (totalGraphSize > OUTCOME_CAPS.maxGraphNodes) {
    const kept: typeof graphs = [];
    let budget: number = OUTCOME_CAPS.maxGraphNodes;
    let dropped = 0;
    for (const graph of graphs) {
      const size = graphSize(graph);
      if (size <= budget) {
        kept.push(graph);
        budget -= size;
      } else {
        dropped += 1;
      }
    }
    limitations.push(
      `Adapter posted ${totalGraphSize} graph nodes/closure entries; budget is ${OUTCOME_CAPS.maxGraphNodes}. Dropped ${dropped} graph(s) whole rather than truncate them into inconsistency.`,
    );
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
  if (findings.length > OUTCOME_CAPS.maxFindings) {
    limitations.push(
      `Adapter posted ${findings.length} findings; capped at ${OUTCOME_CAPS.maxFindings}.`,
    );
    findings = findings.slice(0, OUTCOME_CAPS.maxFindings);
  }
  // Adapter notes (#205) are capped again at assembly; bound the raw array
  // here so a worker can't ship an unbounded one. Losing extra notes never
  // caps the run, so no limitation is recorded for it.
  if (Array.isArray(outcome.adapterNotes) && outcome.adapterNotes.length > MAX_RAW_ADAPTER_NOTES) {
    outcome = { ...outcome, adapterNotes: outcome.adapterNotes.slice(0, MAX_RAW_ADAPTER_NOTES) };
  }
  if (limitations.length === 0) return { ...outcome, referenceAnalysed };
  return {
    ...outcome,
    dependencies,
    usages,
    usageAnalysed,
    referenceAnalysed,
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
  type: "loaded" | "stage" | "partial" | "outcome" | "run-error";
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

/**
 * Enforce the trusted-config rule (#126/#150): adapter specifiers go to
 * import() in the worker, so they must be CLI/project config, never
 * repository content. A specifier that is a file URL or filesystem path
 * resolving inside the analysed repository root is rejected before a
 * worker starts. Bare package specifiers are left to module resolution
 * (they come from the consumer's own dependencies, not the analysed repo).
 */
/**
 * Resolve symlinks so containment cannot be bypassed by a link into the
 * repository (and so a root that is itself a symlink, like macOS
 * /var -> /private/var, compares correctly). realpathSync.native also
 * normalises casing on case-insensitive filesystems. A candidate that
 * does not exist falls back to the realpath of its nearest existing
 * parent with the remainder re-appended.
 */
function realpathOrNearest(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.reduceRight((acc, segment) => path.join(acc, segment), real);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function specifierInsideRoot(specifier: string, root: string): boolean {
  let candidate: string;
  if (specifier.startsWith("file:")) {
    try {
      candidate = fileURLToPath(specifier);
    } catch {
      return false;
    }
  } else if (path.isAbsolute(specifier)) {
    candidate = specifier;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    // Rejected outright: import() in the worker resolves relative
    // specifiers against the worker module, not the caller's cwd, so the
    // check and the actual load could otherwise disagree.
    return true;
  } else {
    return false;
  }
  const realRoot = realpathOrNearest(path.resolve(root));
  const realCandidate = realpathOrNearest(candidate);
  const relative = path.relative(realRoot, realCandidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  );
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
  pullRequestSourceChanges?: readonly SourceLineChanges[],
): Promise<AdapterOutcome> {
  // Trusted-config rule: never import() code from inside the analysed
  // repository (#150). Reject before a worker even starts.
  if (specifierInsideRoot(specifier, repository.scan.root)) {
    return Promise.resolve(
      emptyOutcome(
        specifier,
        adapterFailure(
          { ecosystem: specifier },
          "load",
          new Error(
            "adapter specifier must be trusted configuration (absolute path, file: URL, or bare package specifier) and must not resolve inside the analysed repository",
          ),
        ),
      ),
    );
  }
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
        ...(pullRequestSourceChanges ? { pullRequestSourceChanges } : {}),
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
    // Posted just before the notes stage (#205). If the worker then hangs,
    // dies or errors while in that stage, keep the analysis and report the
    // lost notes as an incomplete note instead of dropping the outcome.
    let beforeNotes: AdapterOutcome | undefined;
    const failed = (error: unknown): AdapterOutcome => {
      const failure = adapterFailure({ ecosystem }, stage, error);
      if (beforeNotes !== undefined && stage === "notes") {
        const kept = capOutcome(beforeNotes);
        return { ...kept, findings: [...kept.findings, failure] };
      }
      return emptyOutcome(ecosystem, failure);
    };

    // A stage past its budget (plus reporting headroom) means the worker's
    // event loop is stuck in synchronous work: async waits are bounded
    // inside the worker by the same timeout, so a healthy worker always
    // reports first. The watchdog must not keep the process alive.
    const armWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        kill();
        finish(failed(new StageTimeout(stage)));
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
      } else if (message.type === "partial" && message.outcome !== undefined) {
        beforeNotes = message.outcome;
      } else if (message.type === "outcome" && message.outcome !== undefined) {
        completed = capOutcome(message.outcome);
      } else if (message.type === "run-error") {
        finish(failed(new Error(message.message ?? "worker failed")));
      }
    });
    // Heap-ceiling death and uncaught worker exceptions arrive here.
    worker.on("error", (error: Error) => {
      kill();
      finish(failed(error));
    });
    worker.on("exit", (code: number) => {
      if (settled) return;
      if (code === 0 && completed !== undefined) {
        finish(completed);
      } else if (code === 0) {
        // Clean exit without an outcome should not happen; report it.
        finish(failed(new Error("worker exited without a result")));
      } else {
        finish(failed(new Error(`worker exited with code ${code}`)));
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
  const sourceChanges = boundPullRequestSourceChanges(options);
  // Guard non-numeric input: Math.max(1, Math.floor(NaN)) is NaN, which
  // would start zero lanes and leave every outcome silently undefined.
  const requestedParallel = options.maxParallelAdapters ?? DEFAULT_MAX_PARALLEL_ADAPTERS;
  const maxParallel = Number.isFinite(requestedParallel)
    ? Math.max(1, Math.floor(requestedParallel))
    : DEFAULT_MAX_PARALLEL_ADAPTERS;

  // Wave-pooled so total adapter heap stays at maxParallel x heapMb (#125).
  const outcomes: AdapterOutcome[] = new Array<AdapterOutcome>(options.adapters.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < options.adapters.length) {
      const index = next++;
      outcomes[index] = await runAdapterIsolated(
        options.adapters[index]!,
        repository,
        network,
        threshold,
        timeoutMs,
        usageConcurrency,
        heapMb,
        options.debugLog,
        sourceChanges.changes,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maxParallel, options.adapters.length) }, () => lane()),
  );

  return assembleAnalysisResult(outcomes, options.recommend, options.pullRequestChanges, {
    scanIncomplete: options.scanIncomplete === true,
    scanCompleteness: options.scanCompleteness ?? [],
    notes: sourceChanges.findings,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}
