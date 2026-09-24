# GhostDeps architecture

GhostDeps answers one question: **does this codebase actually need this dependency?** This document is the map of how the system is put together. Consequential decisions live in [adr/](adr/); this file stays current as the system evolves.

## Big picture

```text
                 ┌──────────────────────────┐
                 │     @ghostdeps/core       │
                 │                           │
                 │  repository discovery     │
                 │  language detection       │
                 │  package-manager detect.  │
                 │  dependency model         │
                 │  dependency graph         │
                 │  usage analysis           │
                 │  recommendation engine    │
                 │  evidence/confidence      │
                 │  reporting                │
                 └─────────────┬─────────────┘
                               │ EcosystemAdapter (ADR 0002)
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
     adapters/javascript-   adapters/python    adapters/rust ...
     typescript
                               │
        ┌──────────────────────┴───────────────────────┐
        ▼                                              ▼
@ghostdeps/github-app (primary)              @ghostdeps/cli (secondary)
Checks, annotations                          terminal, JSON
```

One analysis engine. The GitHub App and the CLI are delivery mechanisms over the same core; there is no second implementation.

## The core pipeline

1. **Repository discovery.** Walk the repository through a read-only `RepositoryHandle`. Identify candidate projects, including workspaces and monorepo sub-projects. Skip vendor/generated directories. See [repository-scanner.md](repository-scanner.md).
2. **Ecosystem detection.** Every adapter's `detect()` runs and returns a confidence-scored result with evidence. Adapters below threshold are skipped — `package.json` present but no meaningful JS/TS source means no JS analysis.
3. **Package-manager detection.** Within each detected ecosystem, identify the package manager(s) from lockfiles and manifests (npm/pnpm/Yarn/Bun; pip/Poetry/uv/Pipenv; Cargo; Go Modules), per project.
4. **Dependency model.** Parse manifests into a normalised `Dependency` model: name, version constraint, kind (runtime/dev/peer/optional/build), scope (root vs workspace package).
5. **Dependency graph.** Parse lockfiles into the transitive graph. No lockfile means reduced confidence, never implicit resolution (ADR 0004).
6. **Usage analysis.** For each direct dependency, find imports/requires and the APIs actually used, with file/line evidence. JS/TS uses the TypeScript compiler API; other languages use tree-sitter grammars.
7. **Recommendation engine.** Core-owned policy turns facts into findings: unused, potentially unnecessary (native alternative / duplicate capability), risk notes (unmaintained, footprint). Every finding carries evidence, confidence, and limitations. Conservative by design: uncertainty downgrades the recommendation, never upgrades it.
8. **Reporting.** A single `AnalysisResult` schema feeds both the CLI (human + `--json`) and the GitHub App (Checks + annotations).

## JSON output

`renderJsonReport()` in `packages/core/src/report/json.ts` is the one serialiser for `AnalysisResult`. The CLI's `--json` and any later integration use it, so the output is a public, versioned schema.

- **`schemaVersion`** is the first key. It is `1` today. Any breaking change (a removed or renamed field, a changed meaning) bumps it; adding an optional field does not.
- **Stable bytes.** The same result always gives the same output: object keys are sorted, and `projects`, `dependencies`, `usages`, `findings`, `detected` and `surface` are sorted by their identifying fields, so adapter run order never shows up as a diff. Order inside a finding (`evidence`, `limitations`) is kept as the recommendation engine set it.
- **Missing fields are omitted**, never written as `null`.
- **Repository content is escaped.** Line separators, bidi controls and zero-width characters are written as `\uXXXX` escapes so a hostile name or path can't hide or reorder text (security model rule 6).
- **Golden files** in `packages/core/test/golden/` pin the exact output. After an intended schema change, regenerate them with `UPDATE_GOLDEN=1 pnpm --filter @ghostdeps/core test` and review the diff.

## Key concepts

- **Unused vs potentially unnecessary.** _Unused_: declared, never imported. _Potentially unnecessary_: imported, but used only for functionality the runtime provides natively or another existing dependency already covers. The second category is the product's differentiator and demands the strongest evidence.
- **Evidence-based recommendations.** A finding without evidence is a bug. "Manual review recommended" with a stated reason (e.g. dynamic imports prevent complete analysis) is a first-class result.
- **Deterministic first.** No LLM is required anywhere in the pipeline. Optional AI assistance (explaining findings, evaluating ambiguous replacements) may come later as an additive layer over deterministic evidence — never as the source of a verdict.
- **Static analysis only.** Repository code is never executed. See ADR 0004 and [security-model.md](security-model.md).

## Native replacement rules

Native alternatives come from versioned rule sets (`packages/core/src/native-rules/`, one module per ecosystem), each rule recording: package, minimum runtime/language version, APIs covered, incompatible use cases, semantic differences, confidence criteria, and references. Rules are data with tests, not vibes. Example: `axios` simple GET/JSON usage on Node 18+ → `fetch()`; incompatible when interceptors, custom adapters, or cancellation APIs are detected.

## Cross-language repositories

A repository may contain several ecosystems (frontend TypeScript, API Python, agent Rust). Detection runs per project root; results aggregate into a repository-wide view: per-ecosystem dependency surface, cross-language capability duplication (e.g. three HTTP clients across three languages), and a single total. Cross-language duplication is reported as information, not accusation.

## Performance stance

No premature optimisation, with deliberate design headroom: cached lockfile parses keyed by content hash, incremental PR analysis limited to changed ecosystems, parallel adapters, vendor/generated exclusion lists, registry response caching, repository size limits and job timeouts. Large monorepos must become practical, not merely possible.

## Where things live

| Concern                                       | Location                                                            |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Shared types, dependency model, result schema | `packages/core/src/types/`                                          |
| Adapter interface + contract test kit         | `packages/core/src/adapter.ts`, `packages/core/src/contract-tests/` |
| Analysis engine                               | `packages/core/src/engine/`                                         |
| Recommendation policy                         | `packages/core/src/recommend/`                                      |
| Native replacement rules                      | `packages/core/src/native-rules/`                                   |
| Ecosystem adapters                            | `packages/adapters/<ecosystem>/`                                    |
| CLI                                           | `packages/cli/`                                                     |
| GitHub App                                    | `packages/github-app/`                                              |
| Test fixture repositories                     | `fixtures/`                                                         |
| Inert codeload archive extraction             | `packages/core/src/checkout/`                                       |
| Decisions                                     | `docs/adr/`                                                         |
