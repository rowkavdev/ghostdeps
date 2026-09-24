# Analysis engine

`analyseRepository(handle, options)` in `packages/core/src/engine/` is the one entry point the CLI (#39) and the GitHub App check reporter (#32) call. It runs pipeline steps 2-8 from [architecture.md](architecture.md) over a `RepositoryHandle` and returns one `AnalysisResult`.

```ts
import { analyseRepository } from "@ghostdeps/core";

const result = await analyseRepository(handle, {
  adapters: [javascriptAdapter, pythonAdapter],
  network: { mode: "offline" }, // default
  detectionThreshold: 0.5, // default, DEFAULT_DETECTION_THRESHOLD
  adapterTimeoutMs: 60_000, // default, per adapter stage (async waits only, see below)
  usageConcurrency: 8, // default, concurrent findUsage calls per adapter
  recommend: policy, // optional; omit for facts only
});
```

## Behaviour

- **Detection gate.** Every adapter's `detect()` runs in parallel. Only adapters at or above the threshold go further. Scores map to `Confidence` as high (>= 0.8), medium (>= 0.5), low.
- **Capabilities.** `buildDependencyGraph` and `findUsage` run only when the adapter declares the capability and implements the method. Graph and usage stages run in parallel per adapter.
- **API version.** Adapters whose `apiVersion` does not match core's `adapterApiVersion` (major.minor while pre-1.0) are skipped with an info finding.
- **Error isolation.** A stage that throws, or whose async work passes `adapterTimeoutMs`, becomes an `info` finding (confidence low, with limitations) for that adapter. Other adapters and earlier facts are kept. Adapter error text is flattened and truncated before it enters a finding.
- **Timeout limits (important).** The engine has two isolation tiers. In-process (`analyseRepository`), the timeout only bounds async waits: synchronous CPU work inside an adapter (a big `JSON.parse`, a YAML parse, a pathological source file) cannot be preempted, so the run waits for it; a fired timeout aborts `AdapterContext.signal` and stops scheduling that adapter's remaining usage calls, but cannot kill work already running. The worker-thread tier (`analyseRepositoryIsolated`, #90) runs each adapter in its own `worker_threads` Worker loaded by module specifier, with a heap ceiling (`resourceLimits`, default 512 MiB old generation) and a watchdog that `terminate()`s the worker when a stage outlives `adapterTimeoutMs` (plus a small grace so a healthy worker reports its own async timeout first). A busy-loop adapter is killed at the budget and a heap-hungry adapter dies on its own ceiling; both become the same `info` findings as in-process failures, and untrusted parsing never touches the main thread's heap. Worker stdout/stderr is captured, never inherited by the parent (a stray adapter log line must not corrupt `ghostdeps scan --json`), and drained to the optional `debugLog` sink. A worker that posts its outcome resolves at exit so captured output has drained before callers see the result. What a worker may post back is count-capped main-side (`OUTCOME_CAPS`: 10,000 dependencies, 50,000 usages, 100,000 graph nodes-plus-closure-entries, 100 evidence entries per finding, 1,000 findings); the structured clone has already landed in the main heap when the caps run, so they bound what flows downstream, not peak memory. Overflow becomes an info finding with limitations - capped usages also mark the outcome's usage analysis incomplete so policy never reads a truncated usage list as "analysed, none found", and oversized graphs are dropped whole rather than truncated into inconsistency. Workers start in waves of `maxParallelAdapters` (default 4), so worst-case adapter heap is `maxParallelAdapters x adapterHeapMb` (2 GiB with defaults), not N x the ceiling. Adapters must still check `signal` between files and keep their own input ceilings (security-model rule 3).
- **Bounded concurrency.** `findUsage` runs for at most `usageConcurrency` dependencies at once per adapter.
- **Recommendation policy.** Core-owned and injected via `recommend`. It receives dependencies, usages, graphs, and `usageAnalysedEcosystems`, the ecosystems where usage analysis actually completed. Policy must not call a dependency unused outside that set. A policy failure becomes an info finding; facts survive. Findings that are not plain JSON data (Map, Date, class instances, non-finite numbers) are dropped with an info finding, because `renderJsonReport` rejects them and one bad finding must not abort the run. As a second guard, the canonical sort (`normaliseAnalysisResult`) never throws, even on such values, so ordering can't abort a run on its own.
- **Determinism.** Projects, dependencies, usages, findings, detections and surfaces are sorted by stable keys, so adapter order and completion timing never change the output. The engine uses the same canonical ordering as the JSON reporter (`normaliseAnalysisResult`), so there is one sorter to keep correct.
- **Surface.** `direct` counts unique direct dependency names per ecosystem; `transitive` counts unique node names across that ecosystem's graphs (0 without a graph).

## Local directories

`analyseDirectory(path, options)` scans a checkout with the repository scanner ([repository-scanner.md](repository-scanner.md)) and runs `analyseRepository` over the resulting `FsRepositoryHandle`. Scan options go in `options.scan`.

Scan limits that could hide the project's own files become `info` findings, so a partial scan is never presented as a complete analysis:

- a truncated scan (`max-files`, `max-directories`, `max-total-bytes`)
- files or directories skipped as too large, too deep, over-long, unsafely named or unreadable, with counts from `skippedCounts` and up to 5 example paths

When any of these is reported, `unused` and `potentially-unnecessary` findings are capped at `medium` confidence and each carries a limitation saying the scan was incomplete, so a skipped file can never produce a confident false "not needed".

Skips that are by design (excluded vendor/generated directories, generated files, symlinks, special files) are not reported. `scanCompletenessFindings(scan)` is exported for callers that scan on their own.
