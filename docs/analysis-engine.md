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
- **Timeout limits (important).** Analysis runs in-process, so the timeout only bounds async waits. Synchronous CPU work inside an adapter (a big `JSON.parse`, a YAML parse, a pathological source file) cannot be preempted: the run waits for it. When a timeout does fire, the engine aborts `AdapterContext.signal` and stops scheduling that adapter's remaining usage calls, but it cannot kill work already running. Adapters must check `signal` between files and keep their own input ceilings (security-model rule 3). Preemptive isolation (worker threads with heap limits and `terminate()`) is tracked in #90.
- **Bounded concurrency.** `findUsage` runs for at most `usageConcurrency` dependencies at once per adapter.
- **Recommendation policy.** Core-owned and injected via `recommend`. It receives dependencies, usages, graphs, and `usageAnalysedEcosystems`, the ecosystems where usage analysis actually completed. Policy must not call a dependency unused outside that set. A policy failure becomes an info finding; facts survive. Findings that are not plain JSON data (Map, Date, class instances, non-finite numbers) are dropped with an info finding, because `renderJsonReport` rejects them and one bad finding must not abort the run. As a second guard, the canonical sort (`normaliseAnalysisResult`) never throws, even on such values, so ordering can't abort a run on its own.
- **Determinism.** Projects, dependencies, usages, findings, detections and surfaces are sorted by stable keys, so adapter order and completion timing never change the output. The engine uses the same canonical ordering as the JSON reporter (`normaliseAnalysisResult`), so there is one sorter to keep correct.
- **Surface.** `direct` counts unique direct dependency names per ecosystem; `transitive` counts unique node names across that ecosystem's graphs (0 without a graph).
