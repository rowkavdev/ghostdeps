# Analysis engine

`analyseRepository(handle, options)` in `packages/core/src/engine/` is the one entry point the CLI (#39) and the GitHub App check reporter (#32) call. It runs pipeline steps 2-8 from [architecture.md](architecture.md) over a `RepositoryHandle` and returns one `AnalysisResult`.

```ts
import { analyseRepository } from "@ghostdeps/core";

const result = await analyseRepository(handle, {
  adapters: [javascriptAdapter, pythonAdapter],
  network: { mode: "offline" }, // default
  detectionThreshold: 0.5, // default, DEFAULT_DETECTION_THRESHOLD
  adapterTimeoutMs: 60_000, // default, per adapter stage
  recommend: policy, // optional; omit for facts only
});
```

## Behaviour

- **Detection gate.** Every adapter's `detect()` runs in parallel. Only adapters at or above the threshold go further. Scores map to `Confidence` as high (>= 0.8), medium (>= 0.5), low.
- **Capabilities.** `buildDependencyGraph` and `findUsage` run only when the adapter declares the capability and implements the method. Graph and usage stages run in parallel per adapter.
- **API version.** Adapters whose `apiVersion` does not match core's `adapterApiVersion` (major.minor while pre-1.0) are skipped with an info finding.
- **Error isolation.** A stage that throws or passes `adapterTimeoutMs` becomes an `info` finding (confidence low, with limitations) for that adapter. Other adapters and earlier facts are kept. Adapter error text is flattened and truncated before it enters a finding.
- **Recommendation policy.** Core-owned and injected via `recommend`. It receives dependencies, usages, graphs, and `usageAnalysedEcosystems`, the ecosystems where usage analysis actually completed. Policy must not call a dependency unused outside that set. A policy failure becomes an info finding; facts survive.
- **Determinism.** Projects, dependencies, usages, findings, detections and surfaces are sorted by stable keys, so adapter order and completion timing never change the output.
- **Surface.** `direct` counts unique direct dependency names per ecosystem; `transitive` counts unique node names across that ecosystem's graphs (0 without a graph).
