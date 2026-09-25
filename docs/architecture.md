# GhostDeps architecture

GhostDeps answers one question: **does this codebase actually need this dependency?** This document is the map of how the system is put together. Consequential decisions live in [architecture decisions](adr/index.md); this file stays current as the system evolves.

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
6. **Usage analysis.** Adapters look for source and configuration references to direct dependencies and report the evidence and limits of their coverage. JS/TS uses the TypeScript compiler API; Python, Rust and Go use tree-sitter grammars. Exact API-use coverage for native replacements is not shipped across these adapters.
7. **Recommendation engine.** Today core policy reports `unused` only behind complete reference coverage, plus type-only, should-be-dev and manual-review findings. Health observations and transitive impact are facts, not removal verdicts; cross-ecosystem capability overlap is awareness-only. Native-alternative and duplicate-capability verdicts are designed but not shipped. Every finding carries evidence, confidence and limitations; uncertainty downgrades a claim, never upgrades it.
8. **Reporting.** A single `AnalysisResult` schema feeds both the CLI (human + `--json`) and the GitHub App (Checks + annotations).

## JSON output

`renderJsonReport()` in `packages/core/src/report/json.ts` is the one serialiser for `AnalysisResult`. The CLI's `--json` and any later integration use it, so the output is a public, versioned schema.

- **`schemaVersion`** is the first key. It is `1` today. Any breaking change (a removed or renamed field, a changed meaning) bumps it; adding an optional field does not.
- **Stable bytes.** The same result always gives the same output: object keys are sorted, and `projects`, `dependencies`, `usages`, `findings`, `detected` and `surface` are sorted by their identifying fields, so adapter run order never shows up as a diff. Findings that look alike are ordered by first evidence location, then by full content. Order inside a finding (`evidence`, `limitations`) is kept as the recommendation engine set it, so producers must emit it in a stable order. Maps, Dates and class instances are rejected rather than silently written as `{}`.
- **Missing fields are omitted**, never written as `null`.
- **Repository content is escaped.** Soft hyphens, line separators, bidi controls, zero-width and other invisible characters are written as `\uXXXX` escapes so a hostile name or path can't hide or reorder text (security model rule 6).
- **Golden files** in `packages/core/test/golden/` pin the exact output. After an intended schema change, regenerate them with `UPDATE_GOLDEN=1 pnpm --filter @ghostdeps/core test` and review the diff.

## Pull request analysis

For a PR, core first works out what changed before running any adapter:

1. `parseUnifiedDiff()` reads the PR diff into files, hunks and line numbers. The diff is untrusted input: it never throws, and size limits or unreadable parts become `truncated`/`problems`.
2. `classifyDependencyFile()` sorts changed files into manifests and lockfiles by name, per ecosystem, skipping vendored copies.
3. `extractDependencyChanges()` compares each changed manifest's declared dependencies at base and head. Core never parses manifests itself: the caller passes `readDeclared`, normally the adapter's `listDirectDependencies()` over the base and head trees. package.json is the first format, through the JS/TS adapter.

The result lists added, removed and changed direct dependencies, which lockfiles changed, manifests whose dependencies changed without a lockfile change nearby, and the added lines in changed source files. Added dependencies are marked `usageCheck: "pending"`: whether a new dependency is actually used is decided by usage analysis on those lines, not here. Anything that could not be read becomes a limitation, never a guess.

Diff paths are attacker data. Paths that are absolute, contain `..` segments, backslashes or control characters are never passed on; they become limitations. `readDeclared` implementations must read through the job's `RepositoryHandle` (never the host filesystem) and extract statically: a manifest with an executable surface such as `setup.py` is parsed as text or reported as unreadable (return `undefined`), never imported or run (ADR 0004 rule 2).

## Key concepts

- **Unused vs potentially unnecessary.** _Unused_: declared, never imported. _Potentially unnecessary_: imported, but used only for functionality the runtime provides natively or another existing dependency already covers. The second category is the product's differentiator and demands the strongest evidence.
- **Evidence-based recommendations.** A finding without evidence is a bug. "Manual review recommended" with a stated reason (e.g. dynamic imports prevent complete analysis) is a first-class result.
- **Deterministic first.** No LLM is required anywhere in the pipeline. Optional AI assistance (explaining findings, evaluating ambiguous replacements) may come later as an additive layer over deterministic evidence — never as the source of a verdict.
- **Static analysis only.** Repository code is never executed. See ADR 0004 and [security-model.md](security-model.md).

## Native replacement rules

The shared rule interface exists under `packages/core/src/native-rules/`, but no ecosystem rule dataset or native-replacement verdict is shipped yet. The design calls for versioned, tested rules recording packages, minimum runtime/language versions, covered APIs, incompatible uses, semantic differences, confidence criteria and references. A proposed example is `axios` simple GET/JSON usage on Node 18+ to `fetch()`; interceptors, custom adapters and cancellation semantics must disqualify a naive swap. See the [JS/TS native-rule research](research/native-rules-js.md).

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
| PR diff parsing, dependency-change extraction | `packages/core/src/diff/`                                           |
| Recommendation policy                         | `packages/core/src/recommend/`                                      |
| Native replacement rules                      | `packages/core/src/native-rules/`                                   |
| Ecosystem adapters                            | `packages/adapters/<ecosystem>/`                                    |
| CLI                                           | `packages/cli/`                                                     |
| GitHub App                                    | `packages/github-app/`                                              |
| Test fixture repositories                     | `fixtures/`                                                         |
| Inert codeload archive extraction             | `packages/core/src/checkout/`                                       |
| Decisions                                     | `docs/adr/`                                                         |
