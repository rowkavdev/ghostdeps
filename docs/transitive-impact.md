# Transitive impact and footprint (#59) - design

Status: draft for review before implementation.

## What "impact" means

For each direct dependency of a project: how much of the installed tree it brings in, read only from that project's lockfile graph. It is a **fact, not a verdict**. It never creates a finding, and it never changes severity, confidence or the check conclusion. It follows ADR 0004: counts come from lockfiles only, and nothing is resolved or installed. Uncertainty is shown as "unknown" or "at least", never as a smaller or bigger number.

Per direct dependency, as a new additive `AnalysisResult.impact?: DependencyImpact[]` (schemaVersion stays 1):

| Field                          | Meaning                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecosystem`, `project`, `name` | which declaration this is about                                                                                                                                                                                                                                                                                                    |
| `graph`                        | `"complete"`, `"partial"` or `"none"`: the #114 completeness of this project's graph                                                                                                                                                                                                                                               |
| `transitive`                   | unique packages in the dependency's closure, not counting itself. `null` when `graph` is `"none"` (unknown, never 0). A lower bound when `"partial"`.                                                                                                                                                                              |
| `exclusive`                    | closure packages that no other direct dependency of the same project reaches: roughly what removing it would drop. **Only when `graph` is `"complete"`**, otherwise `null`. A partial graph can make packages look exclusive when they aren't, which would inflate the benefit of removing something. That's the unsafe direction. |
| `footprint?`                   | slice B, optional; see below                                                                                                                                                                                                                                                                                                       |

The source is `DependencyGraph.transitiveClosure`, the same data the policy already uses for `requiredByOtherDirect`. There's no new adapter contract for the counts.

## Footprint (slice B, optional, offline-degradable)

- **Install footprint only**: the sum of registry-reported unpacked sizes over the closure nodes, at the versions the lockfile pins. Labelled `approximate: true`, with `basis` (e.g. `"npm unpackedSize"`) and `coverage` (sized nodes out of all nodes).
- **No bundle size.** Measuring it would need a build, which ADR 0004 rules out.
- Sizes come only from a caller-supplied, cached metadata provider (`AnalyseOptions.metadata`, core's metadata service per ADR 0004 point 5). Adapters never fetch.
- With no provider (the CLI offline, tests) or no size data for an ecosystem (e.g. Go), `footprint` is simply absent. That's not a note and not incomplete.

## Caps and notes

- Work budget: the summed closure lengths across graphs are capped (proposed at 2,000,000). Past the cap, the remaining dependencies get `transitive`/`exclusive` = `null` with a `limited: true` flag. `impact` length is bounded by `dependencies`, which is already capped.
- Missing impact never touches a verdict, so the proposal is **no finding** for it. The `null`s and the `graph` field carry it. **Open question 2** below.

## Slices

- **A (core, this PR)**: counts, JSON, docs and tests, plus goldens (the CLI/app e2e/corpus results gain `impact`).
- **B (core)**: the footprint provider contract, offline behaviour and caching expectations.
- **C (presenter lanes)**: e.g. "removing left-pad drops 0 other packages" next to an existing verdict. Out of scope here.

## Open questions for the lead

1. Top-level `impact[]` (proposed: keeps `Dependency` adapter-owned) or a core-set field on each dependency?
2. Hitting the work limit: silent `null` plus `limited` (proposed), or an engine note? If a note, which findingGroup? It isn't a verdict gap, so "incomplete" would overstate it.
3. PR mode: compute impact for every dependency (proposed, cheap) and let the app choose what to show, or only for added or changed ones?
