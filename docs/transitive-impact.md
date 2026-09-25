# Transitive impact and footprint (#59) - design

Status: slices A, B and C (CLI) implemented (#59). The lead's rulings on the open questions are recorded below.

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

### Provider contract (slice B)

```ts
interface PackageMetadataProvider {
  installSizes(request: {
    ecosystem: string;
    packages: readonly { name: string; version: string }[];
  }): Promise<
    | { basis: string; sizes: readonly { name: string; version: string; bytes: number }[] }
    | undefined
  >;
}
```

- Core makes **one call per ecosystem** with every locked version it needs, deduplicated and sorted, across all projects. More than `MAX_FOOTPRINT_PACKAGES` (50,000) means no call and no footprint for that ecosystem.
- **Caching is the provider's job.** Serve from cache. Leave unknown packages out of `sizes`. Return `undefined` for an ecosystem with no size data. Never install or build anything.
- Offline behaviour: a throw, a timeout (`FOOTPRINT_TIMEOUT_MS`, 10 s), a missing or empty `basis`, or no valid sizes leaves `footprint` absent for that ecosystem. Sizes must be non-negative safe integers for exactly the versions asked for. Anything else is ignored.
- Per entry, `bytes` is a **lower bound** (#288). Closures are by name, so which locked version a dependency installs isn't known: `a -> c` and `b -> c` with `c@1` and `c@2` both locked doesn't say which one `a` uses. Each package name (the dependency itself and each closure member) counts only when every locked version of it is sized, and it counts at its smallest locked version. `coverage` is `{ sized, total }` over package names. Unsized names are left out, so `bytes` only undercounts. A version-aware walk that gives exact per-version charges needs version-resolved edges from adapters and is tracked in #288. An entry with `transitive: null` or no sized name gets no footprint.
- Registry origin (#174 step 3): each requested version carries `origin` when every locked node for that name and version agrees on a valid `GraphNode.registryOrigin` (a plain, lowercase http(s) origin, validated by core). Otherwise `origin` is absent, which fails closed. Providers query only the origins they're allowed to and skip the rest silently. The GitHub App allows only core's exact two-entry `PUBLIC_NPM_REGISTRY_ORIGINS` (`https://registry.npmjs.org`, `https://registry.yarnpkg.com`), checked with `isPublicNpmRegistryOrigin`. That check never matches by suffix or wildcard. Adapters fill `registryOrigin` only from lockfile evidence (see [security-model.md](security-model.md)).
- Adapters never see the provider. The isolated engine keeps it in the parent process. Footprint changes no finding, severity or conclusion.

## Caps and notes

- Work budget: the summed closure lengths across graphs are capped at 2,000,000 (`MAX_IMPACT_CLOSURE_ENTRIES`). Past the cap, the remaining dependencies get `transitive`/`exclusive` = `null` with a `limited: true` flag. `impact` length is bounded by `dependencies`, which is already capped.
- Missing impact never touches a verdict. When the work budget is exceeded, core emits one visible, non-capping `impact-limited` note; `null` counts and the `limited` flag identify the affected entries. No note is emitted when a metadata provider simply has no footprint data.

## Slices

- **A (core, implemented)**: counts, JSON, docs and tests, plus goldens (the CLI/app e2e/corpus results gain `impact`).
- **B (core, implemented)**: the footprint provider contract, offline behaviour and caching expectations.
- **C (presenters, implemented for CLI)**: the CLI repository summary prints one `impact:` line under removal verdicts (see [output-formats.md](output-formats.md)). Other surfaces render from the same `impact[]` fields and wording rules.

## Rulings (lead, on #265)

1. **Top-level `impact[]`.** `Dependency` is the adapter contract type. Impact is engine-derived and keyed by dependency, so adapters stay untouched.
2. **Work limit: an engine note, group "note".** It's visible and non-capping, and the check keeps success. `limited: true` stays in the data. It's not silent (ADR 0004 rules out silent incompleteness) and not "incomplete": no coverage was lost, only an optional analytics block hit a budget.
3. **PR mode: compute for every dependency.** Adding a dependency that shares subtrees shrinks existing dependencies' exclusive counts. The app chooses what to show.
