# ADR 0002: Ecosystem adapter interface

- Status: Accepted
- Date: 2026-09-24

## Context

GhostDeps must be multi-language from day one: JavaScript/TypeScript, Python, Rust and Go adapters in the first wave, many more later, mostly written by people who never touch the core. The adapter interface is therefore the most load-bearing contract in the project. If it is wrong, every adapter rewrites; if it is right, adapters proceed heavily in parallel without coordinating with each other.

The interface must let the core:

1. decide which adapters apply to a repository (and which do not, even when a manifest is present but the language is not meaningfully used),
2. enumerate direct dependencies and build a dependency graph,
3. find where and how each dependency is used,
4. propose native alternatives and assess package health,

while staying ecosystem-agnostic and versionable.

## Decision

Adapters implement a versioned `EcosystemAdapter` interface defined in `@ghostdeps/core` (see `packages/core/src/adapter.ts`). Design rules:

- **Two-phase detection.** `detect()` returns a confidence-scored `DetectionResult` with evidence (manifests found, source file counts, lockfiles). The core only runs an adapter whose detection passes a threshold. This implements "only analyse languages actually used" as a contract-level concept, not a heuristic bolted on per adapter.
- **Capabilities are explicit.** Adapters declare what they can do (`dependencyGraph`, `usageAnalysis`, `nativeAlternatives`, `health`, `lockfileParsing`). The core degrades gracefully when a capability is absent rather than assuming every adapter does everything.
- **Everything returns evidence.** Usage findings carry file, line, and the symbol/API observed. Recommendations are never bare verdicts; they carry an `Evidence[]` list and a `Confidence` (`high | medium | low`) computed from the evidence, plus explicit `limitations`. "Manual review recommended" is a first-class outcome.
- **No I/O prescribed.** The core hands the adapter a `RepositoryHandle` (an abstract read-only file view) and a `NetworkPolicy`. Adapters never fetch or execute; registry metadata comes from the core's metadata service (ADR 0004), keeping offline CLI analysis possible.
- **Monorepo-native.** Adapters return per-package results keyed by workspace path, not a flattened repo-wide guess.
- **Contract tests are shared.** `@ghostdeps/core` ships a contract-test kit; every adapter runs the same suite against its fixtures. An adapter that cannot pass the contract suite does not merge.

The interface is versioned (`adapterApiVersion` in the core package). Breaking changes bump the major version and adapters pin a range.

## Alternatives considered

**The illustrative interface from the product spec** (`detect`, `detectPackageManagers`, `listDirectDependencies`, `buildDependencyGraph`, `findUsage`, `findNativeAlternatives`, `analyseHealth`). Adopted in spirit, extended with capability flags, evidence/confidence plumbing, detection confidence, and workspace awareness. The spec itself invites this ("improve it if necessary").

**Plugin-by-subprocess (adapters as binaries speaking JSON-RPC).** Maximum language freedom for adapter authors. Rejected for v1: process orchestration, schema drift without a type system across the boundary, and harder contributor DX. The `RepositoryHandle`/`NetworkPolicy` seam keeps a future out-of-process adapter protocol possible without redesign.

**One interface method per question the product asks** (`isUnnecessary()`, `replacementDifficulty()`...). Rejected: it pushes recommendation policy into adapters. Adapters report facts (usage, graphs, health); the recommendation engine in core turns facts into verdicts, so policy stays consistent across ecosystems.

## Consequences

- Adapter authors write TypeScript and run the shared contract suite; the bar is explicit and mechanical.
- The core owns all recommendation policy, so "conservative by design" is enforced in one place.
- Adding a capability later (e.g. `fixGeneration` for M4) extends the capability enum instead of breaking the interface.

## Amendment (2026-09-24): type-only imports

`Usage` gained `typeOnly?: boolean`, orthogonal to `form`. A dependency imported only in type positions (`import type`, type-level `import()`) is evidence for a devDependency move, not runtime necessity - collapsing it into "static" would lose that signal. Additive change; no `adapterApiVersion` bump.

## Addendum (2026-09-25): reference-analysis coverage

The capability list above was the original decision. The interface now also
includes `referenceAnalysis`, which declares that `findUsage` checks script,
bin and config references. An `unused` recommendation requires this capability
and `referenceAnalysisComplete: true` for every dependency in the ecosystem;
without that proof, the policy does not issue an unused-removal verdict. See
[recommendation policy](../recommendation-policy.md) for the full coverage gate.
