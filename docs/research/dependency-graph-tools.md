# Dependency graphs: deps.dev and JS module tools

Research for [#18](https://github.com/rowkavdev/ghostdeps/issues/18). Checked against GhostDeps main on 25 September 2026.

## Problem

A resolved **package graph** answers what a project installs and what each direct dependency brings in. A **source module graph** answers which files import which files or packages. Mixing the two makes transitive cost and usage evidence look more certain than they are.

## Existing solutions

- [deps.dev API v3](https://docs.deps.dev/api/v3/#getdependencies) offers a public-package `GetDependencies` resolved graph for npm, Cargo, Maven and PyPI, with a generic 64-bit Linux resolution model. It does **not** currently offer this resolved-graph endpoint for Go. Other API methods expose version requirements, licences and project-level OpenSSF Scorecard data where available. Its public, generic graph need not match a private repo's lockfile, replacements or selected environment.
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser/) analyses JS/TS module imports, validates them against user-defined rules and can visualise the module graph. Its import-boundary rules are a useful policy model, not a cross-ecosystem package graph.
- [Madge](https://github.com/pahen/madge) builds JS module graphs and spots circular dependencies. Like dependency-cruiser, its unit is a source module rather than a resolved package version in a lockfile.

## Useful techniques and limits

Keep node identities and graph completeness explicit. Use the repository's manifests and lockfiles for project-specific package facts; public resolution data can only enrich, not override, that local graph. Source import paths should carry file/line evidence, while transitive counts depend on locked package edges. Any external API lookup needs an origin/privacy decision before sending package identifiers, particularly for private dependencies.

## Fit with GhostDeps today

GhostDeps adapters statically parse supported lockfiles and return per-project [dependency graphs](../adapters.md). Core builds a [unified repository graph](https://github.com/rowkavdev/ghostdeps/blob/main/packages/core/src/engine/unified-graph.ts) keyed by ecosystem, name and version, and [transitive impact](../transitive-impact.md) only from those lockfile graphs. An incomplete graph lowers what can be claimed; for example, Go's graph currently lists nodes but no edges. Usage scanners separately collect source references. GhostDeps does **not** use deps.dev, dependency-cruiser or Madge as a runtime graph or metadata source; its optional public npm registry metadata is a different, bounded service.

## Recommendation

Retain the in-house lockfile graph and per-adapter source evidence. Use deps.dev's public graph as an external comparison on owned fixture packages, not a replacement for the repository's resolved graph. If external health or licence enrichment is proposed later, scope its privacy, freshness and failure handling separately. Borrow module-boundary test ideas from dependency-cruiser without introducing a general graph library solely for this work.
